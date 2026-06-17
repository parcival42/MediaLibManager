"""Database maintenance: detect and remove ``files`` rows whose file no
longer exists on disk.

The inventory scan's ``present`` flag (scan/inventory.py) is only ever set to
0 within the directory scope of the *last* scan, and it never deletes the row
(a missing path might just be a rename pending rediscovery). This is the
opposite, explicit operation: re-verify *every* row
in the database with a fresh ``os.path.isfile()`` check, regardless of scope
or the stored flag, and actually delete the ones that are gone. Runs as a
serial task (cooperatively cancellable) since it walks the whole library.
"""
import os

from .. import db


def stats() -> dict:
    con = db.connect()
    total = con.execute("SELECT COUNT(*) AS c FROM files").fetchone()["c"]
    missing = con.execute("SELECT COUNT(*) AS c FROM files WHERE present = 0").fetchone()["c"]
    con.close()
    return {"total": total, "marked_missing": missing}


_DELETE_BATCH = 500

# Safety net: if a large share of a non-trivial library suddenly looks
# missing, that almost always means the media mount itself is gone/empty
# (wrong compose file, unmounted pool, ...) -- `os.path.isfile` returns False
# for that exactly like it does for a genuinely deleted file, and silently
# wiping the enrichment data behind it (hours-to-days to rebuild) is far
# worse than refusing and asking the user to check the mount first.
_GUARD_MIN_TOTAL = 50
_GUARD_MAX_FRACTION = 0.5


def run_cleanup(ctx) -> dict:
    con = db.connect()
    try:
        rows = con.execute("SELECT id, path FROM files").fetchall()
        total = len(rows)
        stale: list[int] = []

        for i, r in enumerate(rows, start=1):
            ctx.raise_if_cancelled()
            if not os.path.isfile(r["path"]):
                stale.append(r["id"])
            if i % 1000 == 0:
                ctx.progress(90 * i / total if total else 90)

        if total >= _GUARD_MIN_TOTAL and len(stale) / total > _GUARD_MAX_FRACTION:
            raise RuntimeError(
                f"refusing to remove {len(stale)}/{total} entries "
                f"({len(stale) / total:.0%}) -- this looks like the media mount "
                "is missing rather than the files themselves; check the volume "
                "mount and retry"
            )

        for i in range(0, len(stale), _DELETE_BATCH):
            ctx.raise_if_cancelled()
            batch = stale[i:i + _DELETE_BATCH]
            placeholders = ",".join("?" * len(batch))
            con.execute(f"DELETE FROM files WHERE id IN ({placeholders})", batch)
            con.commit()

        # Drop duplicate groups left with fewer than two members (the FK
        # cascade already removed the stale files' own membership rows).
        con.execute(
            "DELETE FROM duplicate_groups WHERE id IN ("
            "  SELECT g.id FROM duplicate_groups g "
            "  LEFT JOIN duplicate_members m ON m.group_id = g.id "
            "  GROUP BY g.id HAVING COUNT(m.file_id) < 2)"
        )
        con.commit()

        ctx.progress(100)
        ctx.log(f"Checked {total} files, removed {len(stale)} stale entries.")
        return {"checked": total, "removed": len(stale)}
    finally:
        con.close()
