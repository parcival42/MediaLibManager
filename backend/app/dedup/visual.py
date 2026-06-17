"""Perceptual duplicate detection for images and videos.

Every pass turns pairwise "is a near-duplicate of" relations into connected
components via union-find (``DSU``). Each pass takes an ``exclude`` set of file
ids that were already claimed by an earlier (stronger) pass, so a file ends up
in at most one group — no file is reported twice.

Candidate search per pass:

* **Images** compare a single pHash via a BK-tree (avoids the full O(n^2) cross
  product on large libraries; see ``bktree``).
* **Video 5-frame** compares the five fixed-position frame pHashes, gated by a
  duration tolerance; a duration-sorted sliding window keeps it cheap.
* **Deep compare** compares the start/end edge blocks (one pHash per second).
  All-pairs within each block, no duration filter — this is what catches
  re-encoded or trimmed copies whose fixed sample positions no longer line up.
  Only the (smaller) set of files not yet grouped reaches this pass.
"""
import json
import sqlite3

from .bktree import BKTree, DSU, hamming, parse_hash


def find_image_groups(
    con: sqlite3.Connection,
    threshold: int,
    exclude: set[int],
    directory_pattern: str | None = None,
) -> list[list[int]]:
    where = "present = 1 AND type = 'image' AND phash IS NOT NULL AND phash != ''"
    params: list = []
    if directory_pattern:
        where += " AND path LIKE ? ESCAPE '\\'"
        params.append(directory_pattern)
    rows = con.execute(f"SELECT id, phash FROM files WHERE {where}", params).fetchall()

    tree = BKTree()
    items: list[tuple[int, int]] = []
    for r in rows:
        if r["id"] in exclude:
            continue
        h = parse_hash(r["phash"])
        if h is None:
            continue
        items.append((r["id"], h))
        tree.add(h, r["id"])

    dsu = DSU()
    for fid, h in items:
        for other in tree.query(h, threshold):
            if other != fid:
                dsu.union(fid, other)
    return dsu.groups(min_size=2)


def _frame_matches(a: list[int], b: list[int], threshold: int) -> int:
    """Count position-aligned frame pairs within ``threshold`` Hamming distance."""
    return sum(1 for x, y in zip(a, b) if hamming(x, y) <= threshold)


def find_video_groups(
    con: sqlite3.Connection,
    frame_threshold: int,
    min_matches: int,
    duration_tolerance: float,
    exclude: set[int],
    directory_pattern: str | None = None,
) -> list[list[int]]:
    where = "present = 1 AND type = 'video' AND frame_hashes IS NOT NULL"
    params: list = []
    if directory_pattern:
        where += " AND path LIKE ? ESCAPE '\\'"
        params.append(directory_pattern)
    rows = con.execute(f"SELECT id, duration, frame_hashes FROM files WHERE {where}", params).fetchall()

    vids: list[tuple[int, float | None, list[int]]] = []
    for r in rows:
        if r["id"] in exclude:
            continue
        try:
            raw = json.loads(r["frame_hashes"])
        except (TypeError, ValueError):
            continue
        frames = [h for h in (parse_hash(x) for x in raw) if h is not None]
        if frames:
            vids.append((r["id"], r["duration"], frames))

    # Sort by duration so the comparison can stop early once the window is
    # exceeded. Unknown durations sort last (no window prefilter available).
    vids.sort(key=lambda v: (v[1] is None, v[1] or 0.0))

    dsu = DSU()
    n = len(vids)
    for i in range(n):
        id_i, dur_i, fr_i = vids[i]
        for j in range(i + 1, n):
            id_j, dur_j, fr_j = vids[j]
            if dur_i is not None and dur_j is not None:
                if dur_j - dur_i > duration_tolerance:
                    break  # all later j are even farther apart (sorted ascending)
            if _frame_matches(fr_i, fr_j, frame_threshold) >= min_matches:
                dsu.union(id_i, id_j)
    return dsu.groups(min_size=2)


def _block_matches(a: list[int], b: list[int], threshold: int, min_fraction: float) -> bool:
    """True if at least ``min_fraction`` of block ``a``'s frames find a partner
    within ``threshold`` Hamming distance somewhere in block ``b``."""
    if not a or not b:
        return False
    hits = sum(1 for ha in a if any(hamming(ha, hb) <= threshold for hb in b))
    return hits / len(a) >= min_fraction


def find_deep_groups(
    con: sqlite3.Connection,
    threshold: int,
    min_fraction: float,
    exclude: set[int],
    directory_pattern: str | None = None,
) -> list[list[int]]:
    where = "present = 1 AND type = 'video' AND edge_hashes IS NOT NULL"
    params: list = []
    if directory_pattern:
        where += " AND path LIKE ? ESCAPE '\\'"
        params.append(directory_pattern)
    rows = con.execute(f"SELECT id, edge_hashes FROM files WHERE {where}", params).fetchall()

    vids: list[tuple[int, list[int], list[int]]] = []
    for r in rows:
        if r["id"] in exclude:
            continue
        try:
            eh = json.loads(r["edge_hashes"])
        except (TypeError, ValueError):
            continue
        start = [h for h in (parse_hash(x) for x in eh.get("start", [])) if h is not None]
        end = [h for h in (parse_hash(x) for x in eh.get("end", [])) if h is not None]
        if start or end:
            vids.append((r["id"], start, end))

    dsu = DSU()
    n = len(vids)
    for i in range(n):
        id_i, start_i, end_i = vids[i]
        for j in range(i + 1, n):
            id_j, start_j, end_j = vids[j]
            if _block_matches(start_i, start_j, threshold, min_fraction) or \
               _block_matches(end_i, end_j, threshold, min_fraction):
                dsu.union(id_i, id_j)
    return dsu.groups(min_size=2)
