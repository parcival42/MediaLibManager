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
import stat

from .. import db, paths
from ..scan import exclude


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


def _is_gone(path: str) -> bool:
    """True only if ``path`` definitely doesn't exist (or is no longer a
    regular file). A permission error or I/O hiccup is *not* "gone" --
    ``os.path.isfile`` would report False for those too and the row would be
    deleted for good."""
    try:
        st = os.stat(path)
    except (FileNotFoundError, NotADirectoryError):
        return True
    except OSError:
        return False
    return not stat.S_ISREG(st.st_mode)


def run_cleanup(ctx) -> dict:
    con = db.connect()
    try:
        rows = con.execute("SELECT id, path FROM files").fetchall()
        total = len(rows)
        gone: list[int] = []
        # Rows for paths matching a scan exclusion pattern (added after the
        # file was inventoried): the file may still exist, but no scan will
        # ever confirm it again. Not counted by the mount guard below -- a
        # broad new pattern is a deliberate choice, not a missing mount.
        excluded: list[int] = []
        pats = exclude.patterns()
        root = str(paths.media_root())

        for i, r in enumerate(rows, start=1):
            ctx.raise_if_cancelled()
            if exclude.path_excluded(r["path"], pats, root):
                excluded.append(r["id"])
            elif _is_gone(r["path"]):
                gone.append(r["id"])
            if i % 1000 == 0:
                ctx.progress(90 * i / total if total else 90)

        checked = total - len(excluded)
        if checked >= _GUARD_MIN_TOTAL and len(gone) / checked > _GUARD_MAX_FRACTION:
            raise RuntimeError(
                f"refusing to remove {len(gone)}/{checked} entries "
                f"({len(gone) / checked:.0%}) -- this looks like the media mount "
                "is missing rather than the files themselves; check the volume "
                "mount and retry"
            )
        stale = gone + excluded

        for i in range(0, len(stale), _DELETE_BATCH):
            ctx.raise_if_cancelled()
            batch = stale[i:i + _DELETE_BATCH]
            placeholders = ",".join("?" * len(batch))
            con.execute(f"DELETE FROM files WHERE id IN ({placeholders})", batch)
            con.commit()
            db.bump_files_generation()

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
        ctx.log(f"Checked {total} files, removed {len(gone)} stale and "
                f"{len(excluded)} excluded entries.")
        return {"checked": total, "removed": len(stale), "excluded": len(excluded)}
    finally:
        con.close()
