"""Duplicate endpoints — list derived groups, trigger a rebuild, delete files.

Listing reads the pre-computed ``duplicate_groups`` / ``duplicate_members``
tables and enriches each group for display: it picks the best copy to keep,
and computes the per-member comparison info (pHash distance for images, the
per-frame match strip for videos) against that kept reference on the fly — so
none of that transient comparison data has to be persisted. Rebuild and delete
are file/heavy actions and go through the serial task queue.
"""
import json
import os

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import auth, config, db, paths
from ..dedup import delete as dedup_delete
from ..dedup import rebuild as dedup_rebuild
from ..dedup.bktree import DSU, hamming, parse_hash
from ..tasks import runner

router = APIRouter(prefix="/api")

MEMBER_COLUMNS = ("id, path, type, size, width, height, duration, codec, mtime, "
                  "enrich_status, thumbnail_b64, phash, mean_saturation, "
                  "frame_hashes, frames_b64")

# Strongest-evidence-first — matches the detection pass order in dedup/rebuild.py.
KIND_ORDER = ["exact_image", "exact_video", "exact_other", "visual", "video", "deep"]
_KIND_RANK_SQL = " ".join(
    f"WHEN '{k}' THEN {i}" for i, k in enumerate(KIND_ORDER)
)


def _keep_rank(m: dict) -> tuple:
    """Sort key: best copy first — highest resolution, then largest, then oldest."""
    pixels = (m.get("width") or 0) * (m.get("height") or 0)
    return (-pixels, -(m.get("size") or 0), m.get("mtime") or 0)


def _parse_frames(value) -> list[int | None]:
    try:
        return [parse_hash(x) for x in json.loads(value)] if value else []
    except (TypeError, ValueError):
        return []


def _enrich_group(g: dict, members: list[dict], frame_threshold: int) -> dict:
    ordered = sorted(members, key=_keep_rank)
    reference = ordered[0] if ordered else None
    kind = g["kind"]

    ref_phash = parse_hash(reference["phash"]) if reference else None
    ref_frames = _parse_frames(reference["frame_hashes"]) if reference else []

    out_members = []
    for m in ordered:
        item = {
            "id": m["id"],
            "path": m["path"],
            "filename": os.path.basename(m["path"]),
            "type": m["type"],
            "size": m["size"],
            "width": m["width"],
            "height": m["height"],
            "duration": m["duration"],
            "codec": m["codec"],
            "thumbnail_b64": m["thumbnail_b64"],
            "mean_saturation": m["mean_saturation"],
            "is_keep": reference is not None and m["id"] == reference["id"],
        }

        if m["type"] == "video":
            try:
                item["frames"] = json.loads(m["frames_b64"]) if m["frames_b64"] else []
            except (TypeError, ValueError):
                item["frames"] = []

        if kind == "visual" and ref_phash is not None and not item["is_keep"]:
            mh = parse_hash(m["phash"])
            item["phash_distance"] = hamming(mh, ref_phash) if mh is not None else None

        if kind == "video" and ref_frames and not item["is_keep"]:
            mf = _parse_frames(m["frame_hashes"])
            distances: list[int | None] = []
            for a, b in zip(ref_frames, mf):
                distances.append(hamming(a, b) if (a is not None and b is not None) else None)
            item["frame_distances"] = distances
            item["frame_matches"] = [d is not None and d <= frame_threshold for d in distances]
            item["match_count"] = sum(1 for ok in item["frame_matches"] if ok)

        out_members.append(item)

    sizes = [m["size"] or 0 for m in ordered]
    keep_size = reference["size"] or 0 if reference else 0
    reclaimable = sum(sizes) - keep_size
    return {"id": g["id"], "kind": kind, "members": out_members, "reclaimable": reclaimable}


@router.get("/duplicates")
def list_duplicates(_: str = Depends(auth.current_user), kind: str | None = None):
    frame_threshold = int(config.get("video_frame_threshold"))

    where = ""
    params: list = []
    if kind:
        where = " WHERE kind = ?"
        params.append(kind)

    con = db.connect()
    groups = con.execute(
        f"SELECT id, kind, created_at FROM duplicate_groups{where} "
        f"ORDER BY CASE kind {_KIND_RANK_SQL} ELSE {len(KIND_ORDER)} END, id",
        params,
    ).fetchall()

    result = []
    for g in groups:
        members = con.execute(
            f"SELECT {MEMBER_COLUMNS} FROM files f "
            "JOIN duplicate_members m ON m.file_id = f.id "
            "WHERE m.group_id = ? ORDER BY f.path",
            (g["id"],),
        ).fetchall()
        result.append(_enrich_group(dict(g), [dict(r) for r in members], frame_threshold))
    con.close()
    return {"groups": result}


class RebuildRequest(BaseModel):
    directory: str | None = None  # absolute path under media_root; None = whole library


@router.post("/duplicates/rebuild")
def rebuild_duplicates(req: RebuildRequest, _: str = Depends(auth.current_user)):
    try:
        scope = paths.resolve_within_root(req.directory)
    except ValueError:
        raise HTTPException(status_code=400, detail="directory outside media root")
    if not scope.is_dir():
        raise HTTPException(status_code=404, detail="directory not found")
    directory = str(scope) if scope != paths.media_root() else None

    task_id = runner.create_task("dedup_rebuild", {"directory": directory})
    runner.enqueue(task_id, lambda ctx: dedup_rebuild.rebuild(ctx, directory=directory))
    return {"task_id": task_id}


class IgnoreRequest(BaseModel):
    file_ids: list[int]  # all members of the group to mark as "not duplicates"


@router.post("/duplicates/ignore")
def ignore_group(req: IgnoreRequest, _: str = Depends(auth.current_user)):
    if len(req.file_ids) < 2:
        raise HTTPException(status_code=400, detail="need at least 2 files")
    import time as _time
    ids = sorted(req.file_ids)
    pairs = [
        (ids[i], ids[j], _time.time())
        for i in range(len(ids))
        for j in range(i + 1, len(ids))
    ]
    con = db.connect()
    con.executemany(
        "INSERT OR IGNORE INTO dedup_ignores(file_id_a, file_id_b, ignored_at) VALUES(?, ?, ?)",
        pairs,
    )
    con.commit()
    con.close()
    return {"pairs_added": len(pairs)}


@router.post("/duplicates/unignore")
def unignore_group(req: IgnoreRequest, _: str = Depends(auth.current_user)):
    """Reverse an ``ignore_group`` call — remove the C(N,2) pairs of this group
    from the ignore list so it is detected again on the next rebuild."""
    if len(req.file_ids) < 2:
        raise HTTPException(status_code=400, detail="need at least 2 files")
    ids = sorted(req.file_ids)
    pairs = [
        (ids[i], ids[j])
        for i in range(len(ids))
        for j in range(i + 1, len(ids))
    ]
    con = db.connect()
    con.executemany(
        "DELETE FROM dedup_ignores WHERE file_id_a = ? AND file_id_b = ?", pairs
    )
    con.commit()
    con.close()
    return {"pairs_removed": len(pairs)}


@router.get("/duplicates/ignores")
def ignore_stats(_: str = Depends(auth.current_user)):
    """Summary of the persisted ignore list. ``groups`` is the number of
    connected components of the ignored-pair graph — i.e. how many distinct
    ignored clusters there are (a single ignore action stores all C(N,2) pairs
    of one group, which form one component)."""
    con = db.connect()
    rows = con.execute("SELECT file_id_a, file_id_b FROM dedup_ignores").fetchall()
    con.close()
    dsu = DSU()
    for r in rows:
        dsu.union(r["file_id_a"], r["file_id_b"])
    return {"pairs": len(rows), "groups": len(dsu.groups(min_size=2))}


@router.post("/duplicates/ignores/reset")
def reset_ignores(_: str = Depends(auth.current_user)):
    """Clear the whole ignore list. Previously ignored groups reappear on the
    next rebuild ('Find duplicates')."""
    con = db.connect()
    cur = con.execute("DELETE FROM dedup_ignores")
    con.commit()
    con.close()
    return {"cleared": cur.rowcount}


class DeleteRequest(BaseModel):
    file_ids: list[int]


@router.post("/delete")
def delete_files(req: DeleteRequest, _: str = Depends(auth.current_user)):
    if not req.file_ids:
        raise HTTPException(status_code=400, detail="no files selected")
    ids = list(req.file_ids)
    task_id = runner.create_task("delete", {"count": len(ids)})
    runner.enqueue(task_id, lambda ctx: dedup_delete.run_delete(ids, ctx))
    return {"task_id": task_id}
