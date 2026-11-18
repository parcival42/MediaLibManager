"""Perceptual duplicate detection for images and videos.

Every pass turns pairwise "is a near-duplicate of" relations into connected
components via union-find (``DSU``). Each pass takes an ``exclude`` set of file
ids already claimed by an earlier (stronger) pass. One representative per
earlier group stays available (see ``rebuild``), so a file similar to a member
of an exact group can still be found; that representative may then appear in
two groups.

Candidate search per pass:

* **Images** compare a single pHash via a BK-tree (avoids the full O(n^2) cross
  product on large libraries; see ``bktree``).
* **Video 5-frame** compares the five fixed-position frame pHashes, gated by a
  duration tolerance; a duration-sorted sliding window keeps it cheap.
* **Deep compare** compares the start/end edge blocks (one pHash per second),
  no duration filter — this is what catches re-encoded or trimmed copies whose
  fixed sample positions no longer line up. Candidate pairs come from BK-trees
  over the individual frame hashes; frames shared by many videos (intros,
  blank frames) are dropped first.
"""
import json
import sqlite3
from collections import Counter

from .bktree import BKTree, DSU, hamming, parse_hash


def find_image_groups(
    con: sqlite3.Connection,
    threshold: int,
    grey_cutoff: float,
    exclude: set[int],
    ignore_pairs: set[tuple[int, int]],
    scope: tuple[str, list] | None = None,
) -> list[list[int]]:
    where = "present = 1 AND type = 'image' AND phash IS NOT NULL AND phash != ''"
    params: list = []
    if scope:
        where += " AND " + scope[0]
        params += scope[1]
    rows = con.execute(
        f"SELECT id, phash, mean_saturation FROM files WHERE {where}", params
    ).fetchall()

    tree = BKTree()
    items: list[tuple[int, int, float | None]] = []
    sat_map: dict[int, float | None] = {}
    for r in rows:
        if r["id"] in exclude:
            continue
        h = parse_hash(r["phash"])
        if h is None:
            continue
        sat = r["mean_saturation"]
        items.append((r["id"], h, sat))
        sat_map[r["id"]] = sat
        tree.add(h, r["id"])

    dsu = DSU()
    for fid, h, sat in items:
        for other in tree.query(h, threshold):
            if other == fid:
                continue
            pair = (min(fid, other), max(fid, other))
            if pair in ignore_pairs:
                continue
            # Colour gate: pHash drops colour (it hashes only luminance), so a
            # colour image and its black-and-white version reach distance 0.
            # Mean saturation reliably separates only "colourful" vs "greyscale"
            # — its *magnitude* is low even for colour photos (skin, neutral
            # backgrounds), so we classify each image as greyscale (saturation
            # at/below grey_cutoff) or colour and refuse to union across that
            # boundary, rather than thresholding the difference.
            other_sat = sat_map.get(other)
            if sat is not None and other_sat is not None:
                if (sat <= grey_cutoff) != (other_sat <= grey_cutoff):
                    continue
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
    ignore_pairs: set[tuple[int, int]],
    scope: tuple[str, list] | None = None,
) -> list[list[int]]:
    where = "present = 1 AND type = 'video' AND frame_hashes IS NOT NULL"
    params: list = []
    if scope:
        where += " AND " + scope[0]
        params += scope[1]
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
            pair = (min(id_i, id_j), max(id_i, id_j))
            if pair in ignore_pairs:
                continue
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


# A frame hash shared exactly by more than this many videos (absolute floor /
# fraction of the pass) is a common studio intro/outro or a blank frame; it
# says nothing about two videos being the same and, left in, transitively
# chains unrelated videos into one huge group.
_COMMON_HASH_MIN = 5
_COMMON_HASH_FRACTION = 0.01
# Fewer informative frames than this in a block: too little evidence.
_MIN_BLOCK_FRAMES = 3


def find_deep_groups(
    con: sqlite3.Connection,
    threshold: int,
    min_fraction: float,
    exclude: set[int],
    ignore_pairs: set[tuple[int, int]],
    scope: tuple[str, list] | None = None,
    check_cancelled=None,
) -> list[list[int]]:
    where = "present = 1 AND type = 'video' AND edge_hashes IS NOT NULL"
    params: list = []
    if scope:
        where += " AND " + scope[0]
        params += scope[1]
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

    # Drop uninformative frames (see _COMMON_HASH_*): count in how many
    # videos each exact hash occurs.
    freq: Counter[int] = Counter()
    for _, start, end in vids:
        freq.update(set(start) | set(end))
    common_limit = max(_COMMON_HASH_MIN, int(len(vids) * _COMMON_HASH_FRACTION))

    def informative(block: list[int]) -> list[int]:
        kept = [h for h in block if freq[h] <= common_limit]
        return kept if len(kept) >= _MIN_BLOCK_FRAMES else []

    vids = [(vid, informative(s), informative(e)) for vid, s, e in vids]
    vids = [v for v in vids if v[1] or v[2]]

    # Candidate pairs via BK-trees over the individual frame hashes instead of
    # comparing every pair of videos (O(n^2) block compares took hours on
    # large libraries): only videos sharing at least one near frame in the
    # same block can match at all.
    start_tree, end_tree = BKTree(), BKTree()
    for idx, (_, start, end) in enumerate(vids):
        for h in set(start):
            start_tree.add(h, idx)
        for h in set(end):
            end_tree.add(h, idx)

    dsu = DSU()
    for i, (id_i, start_i, end_i) in enumerate(vids):
        if check_cancelled and i % 100 == 0:
            check_cancelled()
        candidates: set[int] = set()
        for h in set(start_i):
            candidates.update(start_tree.query(h, threshold))
        for h in set(end_i):
            candidates.update(end_tree.query(h, threshold))
        for j in candidates:
            if j <= i:
                continue
            id_j, start_j, end_j = vids[j]
            pair = (min(id_i, id_j), max(id_i, id_j))
            if pair in ignore_pairs:
                continue
            if _block_matches(start_i, start_j, threshold, min_fraction) or \
               _block_matches(end_i, end_j, threshold, min_fraction):
                dsu.union(id_i, id_j)
    return dsu.groups(min_size=2)
