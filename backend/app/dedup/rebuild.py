"""Rebuild the derived duplicate groups from the enriched ``files`` rows.

Runs as a serial task: enrichment is paused while it executes, so the hashes it
reads are stable. The whole result is recomputed and the ``duplicate_groups`` /
``duplicate_members`` tables are replaced atomically — duplicate detection is a
pure derivation of the current file data.

An optional ``directory`` scopes the comparison to files under that path
(recursively): every source query is filtered, so the rebuild is a fresh,
self-contained derivation for that subset rather than a partial merge — a
file in scope that duplicates one outside it would otherwise be invisible to
a list-time filter, since grouping is transitive (see ``visual.py``
union-find). Passing no directory rebuilds for the whole
library, replacing the previous (possibly scoped) result.

Passes run strongest-first and each excludes files already claimed by an earlier
pass, so every file lands in at most one group (no duplicate is shown twice):

    exact (MD5) -> visual image (pHash) -> video 5-frame -> deep (edge blocks)
"""
import time

from .. import config, db
from . import exact, visual


def _like_pattern(directory: str | None) -> str | None:
    """Escape LIKE wildcards and build a recursive-prefix pattern for ``directory``."""
    if not directory:
        return None
    escaped = directory.rstrip("/").replace("%", "\\%").replace("_", "\\_")
    return escaped + "/%"


def rebuild(ctx, directory: str | None = None) -> dict:
    threshold = int(config.get("phash_threshold"))
    frame_threshold = int(config.get("video_frame_threshold"))
    min_matches = int(config.get("video_min_matches"))
    duration_tolerance = float(config.get("duration_tolerance"))
    deep_threshold = int(config.get("deep_threshold"))
    deep_min_fraction = float(config.get("deep_min_fraction"))
    deep_enabled = bool(config.get("deep_enabled"))
    pattern = _like_pattern(directory)

    ctx.log(f"Scope: {directory}" if directory else "Scope: entire library")

    con = db.connect()
    try:
        claimed: set[int] = set()

        def claim(groups: list[list[int]]) -> None:
            for g in groups:
                claimed.update(g)

        ctx.log("Finding exact (MD5) duplicates…")
        exact_groups = exact.find_exact_groups(con, pattern)
        claim(ids for _, ids in exact_groups)
        ctx.progress(25)
        ctx.raise_if_cancelled()

        ctx.log("Finding visually similar images…")
        image_groups = visual.find_image_groups(con, threshold, claimed, pattern)
        claim(image_groups)
        ctx.progress(50)
        ctx.raise_if_cancelled()

        ctx.log("Finding similar videos (5-frame)…")
        video_groups = visual.find_video_groups(
            con, frame_threshold, min_matches, duration_tolerance, claimed, pattern
        )
        claim(video_groups)
        ctx.progress(75)
        ctx.raise_if_cancelled()

        if deep_enabled:
            ctx.log("Finding similar videos (deep compare)…")
            deep_groups = visual.find_deep_groups(
                con, deep_threshold, deep_min_fraction, claimed, pattern
            )
        else:
            ctx.log("Deep compare disabled — skipping.")
            deep_groups = []
        ctx.progress(90)
        ctx.raise_if_cancelled()

        now = time.time()
        con.execute("DELETE FROM duplicate_members")
        con.execute("DELETE FROM duplicate_groups")

        for kind, members in exact_groups:
            cur = con.execute(
                "INSERT INTO duplicate_groups(kind, created_at) VALUES(?, ?)",
                (kind, now),
            )
            gid = cur.lastrowid
            con.executemany(
                "INSERT INTO duplicate_members(group_id, file_id) VALUES(?, ?)",
                [(gid, fid) for fid in members],
            )
        for kind, groups in (
            ("visual", image_groups),
            ("video", video_groups),
            ("deep", deep_groups),
        ):
            for members in groups:
                cur = con.execute(
                    "INSERT INTO duplicate_groups(kind, created_at) VALUES(?, ?)",
                    (kind, now),
                )
                gid = cur.lastrowid
                con.executemany(
                    "INSERT INTO duplicate_members(group_id, file_id) VALUES(?, ?)",
                    [(gid, fid) for fid in members],
                )
        con.commit()
    finally:
        con.close()

    result = {
        "exact_groups": len(exact_groups),
        "image_groups": len(image_groups),
        "video_groups": len(video_groups),
        "deep_groups": len(deep_groups),
    }
    ctx.log(
        f"Done: {result['exact_groups']} exact, {result['image_groups']} image, "
        f"{result['video_groups']} video, {result['deep_groups']} deep groups."
    )
    return result
