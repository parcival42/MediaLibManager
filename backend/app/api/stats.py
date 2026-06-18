"""Aggregate statistics for the Statistics page.

One read-only endpoint returning three blocks: library composition (present
files, broken down by type), deduplication results (files removed and space
freed, from ``delete_history`` -- only ``dedup/delete.py`` writes there), and
metadata stripping outcomes (from ``metadata_history`` -- only ``strip.py``
writes there). All three live in the DB, so a wiped database reads as zeros.
"""
from fastapi import APIRouter, Depends

from .. import auth, db

router = APIRouter(prefix="/api")

# Fixed type ordering so the UI always lists the same buckets in the same place.
_TYPES = ("image", "video", "audio", "other")


@router.get("/stats")
def stats(_: str = Depends(auth.current_user)):
    con = db.connect()
    try:
        by_type = {t: {"count": 0, "bytes": 0} for t in _TYPES}
        rows = con.execute(
            "SELECT type, COUNT(*) AS c, COALESCE(SUM(size), 0) AS b "
            "FROM files WHERE present = 1 GROUP BY type"
        ).fetchall()
        for r in rows:
            bucket = r["type"] if r["type"] in by_type else "other"
            by_type[bucket]["count"] += r["c"]
            by_type[bucket]["bytes"] += r["b"]

        total = sum(b["count"] for b in by_type.values())
        total_bytes = sum(b["bytes"] for b in by_type.values())

        dedup_row = con.execute(
            "SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS b FROM delete_history"
        ).fetchone()

        meta = {"ok": 0, "failed": 0, "error": 0}
        for r in con.execute(
            "SELECT status, COUNT(*) AS c FROM metadata_history GROUP BY status"
        ).fetchall():
            if r["status"] in meta:
                meta[r["status"]] += r["c"]
    finally:
        con.close()

    return {
        "library": {"total": total, "total_bytes": total_bytes, "by_type": by_type},
        "dedup": {"deleted_files": dedup_row["c"], "freed_bytes": dedup_row["b"]},
        "metadata": {"stripped": meta["ok"], "failed": meta["failed"], "errors": meta["error"]},
    }
