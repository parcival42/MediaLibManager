"""Title/Comment metadata stripping with backup + multi-stage integrity check.

Mirrors ``dedup/delete.py``'s shape: ``candidates`` is a pure read over the
already-enriched ``files`` rows; ``apply_strip`` touches the filesystem and
runs through the serial task queue.

The integrity check reuses the dedup module's Hamming-distance code
(``bktree.hamming``/``parse_hash``) and the same five frame positions used
during enrichment (``enrich.tools.FRAME_POSITIONS``), but with a deliberately
tight threshold: stripping a Title/Comment atom never touches the video
stream, so the frames before/after should be near pixel-identical. Reusing
the looser duplicate-detection thresholds (meant to tolerate genuinely
different, re-encoded videos) would let real corruption slip through
undetected.
"""
import json
import os
import time

import imagehash

from .. import db, paths
from ..dedup.bktree import hamming, parse_hash
from ..enrich import tools

# All 5 sampled frames must match within this distance for the integrity
# check to pass. Tight on purpose -- see module docstring.
INTEGRITY_FRAME_THRESHOLD = 4

# Duration must match within this many seconds. Small fixed epsilon (not the
# dedup `duration_tolerance` setting) -- stripping shouldn't change it at all,
# this just absorbs ffprobe rounding.
DURATION_EPSILON = 0.5

_CANDIDATE_COLUMNS = "id, path, size, duration, frame_hashes"


def candidates(directory: str | None = None) -> list[dict]:
    """Present videos flagged with Title/Comment that have an enriched frame
    baseline to verify against (stage 2 enrichment). Files not yet at that
    stage simply aren't offered yet -- they show up once enrichment catches up.

    Restricted to the MP4 family: ``has_title_comment`` is set whenever
    exiftool can *read* a Title/Comment on any video container, but its
    *write* support is format-dependent -- containers like .mkv/.wmv/.flv are
    typically read-only there, which would make such a file error on every
    strip attempt and reappear as a candidate forever. MP4/M4V/MOV is the
    deliberately limited, proven write scope.
    """
    con = db.connect()
    try:
        where = [
            "present = 1", "type = 'video'", "has_title_comment = 1", "frame_hashes IS NOT NULL",
            "(path LIKE '%.mp4' OR path LIKE '%.m4v' OR path LIKE '%.mov')",
        ]
        params: list = []
        if directory:
            like = directory.rstrip(os.sep) + os.sep + "%"
            where.append("(path = ? OR path LIKE ?)")
            params += [directory, like]
        rows = con.execute(
            f"SELECT {_CANDIDATE_COLUMNS} FROM files WHERE {' AND '.join(where)} ORDER BY path",
            params,
        ).fetchall()
    finally:
        con.close()

    out = []
    for r in rows:
        out.append({
            "id": r["id"],
            "path": r["path"],
            "filename": os.path.basename(r["path"]),
            "size": r["size"],
            "duration": r["duration"],
        })
    return out


def _check_integrity(path: str, duration: float, before_fmt: dict, baseline_hashes: list[str]) -> tuple[str, str]:
    """Returns ``(duration_check, phash_check)``, each ``"ok"`` or a ``"fail: ..."`` reason."""
    try:
        after_fmt = tools.ffprobe(path).get("format", {})
        before_streams = before_fmt.get("nb_streams")
        after_streams = after_fmt.get("nb_streams")
        before_dur = float(before_fmt.get("duration") or 0)
        after_dur = float(after_fmt.get("duration") or 0)
        if before_streams != after_streams:
            duration_check = "fail: nb_streams changed"
        elif abs(before_dur - after_dur) > DURATION_EPSILON:
            duration_check = "fail: duration changed"
        else:
            duration_check = "ok"
    except tools.ToolError as exc:
        duration_check = f"fail: ffprobe error ({exc})"

    try:
        phash_check = "ok"
        for frac, hex_hash in zip(tools.FRAME_POSITIONS, baseline_hashes):
            expected = parse_hash(hex_hash)
            if expected is None:
                phash_check = "fail: missing baseline hash"
                break
            frame = tools.extract_frame(path, duration * frac)
            actual = parse_hash(str(imagehash.phash(frame)))
            if actual is None or hamming(expected, actual) > INTEGRITY_FRAME_THRESHOLD:
                phash_check = "fail: frame mismatch"
                break
    except tools.ToolError as exc:
        phash_check = f"fail: frame extraction error ({exc})"

    return duration_check, phash_check


def _record_history(con, path: str, duration_check: str, phash_check: str,
                     backup_path: str | None, status: str, errormsg: str | None) -> None:
    con.execute(
        "INSERT INTO metadata_history(path, modified_at, duration_check, phash_check, "
        "backup_path, status, errormsg) VALUES(?, ?, ?, ?, ?, ?, ?)",
        (path, time.strftime("%Y-%m-%dT%H:%M:%S"), duration_check, phash_check,
         backup_path, status, errormsg),
    )
    con.commit()


def apply_strip(file_ids: list[int], ctx) -> dict:
    """Strip Title/Comment from the given files, verifying integrity before
    committing to it. A single file's failure is recorded and the batch
    continues -- it must not abort the rest of the selection."""
    if not file_ids:
        return {"stripped": 0, "failed": 0, "errors": 0}

    con = db.connect()
    try:
        placeholders = ",".join("?" * len(file_ids))
        rows = con.execute(
            f"SELECT {_CANDIDATE_COLUMNS}, present, has_title_comment FROM files WHERE id IN ({placeholders})",
            file_ids,
        ).fetchall()
        by_id = {r["id"]: dict(r) for r in rows}
        ordered = sorted(file_ids, key=lambda fid: by_id[fid]["path"] if fid in by_id else "")

        total = len(ordered)
        stripped = failed = errors = 0

        for i, fid in enumerate(ordered, start=1):
            ctx.raise_if_cancelled()
            f = by_id.get(fid)
            if f is None or not f["present"] or not f["has_title_comment"]:
                continue
            path = f["path"]

            try:
                paths.resolve_within_root(path)
            except ValueError:
                errors += 1
                ctx.log(f"SKIP (outside media root): {path}")
                continue

            try:
                before_fmt = tools.ffprobe(path).get("format", {})
            except tools.ToolError as exc:
                errors += 1
                ctx.log(f"ERROR probing {os.path.basename(path)}: {exc}")
                _record_history(con, path, "skipped", "skipped", None, "error", f"probe failed: {exc}")
                continue

            try:
                backup_path = tools.strip_title_comment(path)
            except tools.ToolError as exc:
                errors += 1
                ctx.log(f"ERROR stripping {os.path.basename(path)}: {exc}")
                _record_history(con, path, "skipped", "skipped", None, "error", f"strip failed: {exc}")
                continue

            duration_check, phash_check = _check_integrity(
                path, f["duration"], before_fmt, json.loads(f["frame_hashes"]),
            )
            ok = duration_check == "ok" and phash_check == "ok"

            if ok:
                try:
                    os.remove(backup_path)
                except OSError:
                    pass
                con.execute(
                    "UPDATE files SET has_title_comment = 0, size = ?, md5 = ? WHERE id = ?",
                    (os.path.getsize(path), tools.md5sum(path), fid),
                )
                con.commit()
                stripped += 1
                ctx.log(f"OK {os.path.basename(path)}")
            else:
                try:
                    os.replace(backup_path, path)
                except OSError as exc:
                    ctx.log(f"ERROR restoring backup for {os.path.basename(path)}: {exc}")
                failed += 1
                ctx.log(f"FAILED {os.path.basename(path)}: {duration_check} / {phash_check}")

            _record_history(
                con, path, duration_check, phash_check,
                None if ok else backup_path,
                "ok" if ok else "failed",
                None if ok else f"{duration_check}; {phash_check}",
            )
            ctx.progress(100 * i / total)

        return {"stripped": stripped, "failed": failed, "errors": errors}
    finally:
        con.close()


def history(limit: int = 200) -> list[dict]:
    con = db.connect()
    rows = con.execute(
        "SELECT id, path, modified_at, duration_check, phash_check, status, errormsg "
        "FROM metadata_history ORDER BY id DESC LIMIT ?", (limit,)
    ).fetchall()
    con.close()
    out = []
    for r in rows:
        d = dict(r)
        d["filename"] = os.path.basename(d["path"]) if d["path"] else ""
        out.append(d)
    return out
