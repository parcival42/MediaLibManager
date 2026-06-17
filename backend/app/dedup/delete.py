"""Delete files from disk and keep the database consistent.

Runs as a serial task so it never races the enrichment worker over the same
files. For each id: remove the file from disk, log it to ``delete_history``, and
drop its ``files`` row — the ON DELETE CASCADE on ``duplicate_members`` removes
it from every duplicate group automatically. Groups left
with fewer than two members afterwards are pruned so the UI never shows a
"group" of one.
"""
import os
import time

from .. import db, paths


def run_delete(file_ids: list[int], ctx) -> dict:
    deleted = 0
    errors = 0
    freed = 0
    con = db.connect()
    try:
        for fid in file_ids:
            ctx.raise_if_cancelled()
            row = con.execute(
                "SELECT path, size FROM files WHERE id = ?", (fid,)
            ).fetchone()
            if row is None:
                continue
            path = row["path"]
            try:
                paths.resolve_within_root(path)  # guard against escaping the root
            except ValueError:
                errors += 1
                ctx.log(f"SKIP (outside media root): {path}")
                continue
            try:
                if os.path.isfile(path):
                    os.remove(path)
                con.execute(
                    "INSERT INTO delete_history(path, filename, size, deleted_at) "
                    "VALUES(?, ?, ?, ?)",
                    (path, os.path.basename(path), row["size"], time.time()),
                )
                con.execute("DELETE FROM files WHERE id = ?", (fid,))
                con.commit()
                deleted += 1
                freed += row["size"] or 0
            except OSError as exc:
                errors += 1
                ctx.log(f"ERROR deleting {path}: {exc}")

        # Drop groups that no longer have at least two members.
        con.execute(
            "DELETE FROM duplicate_groups WHERE id IN ("
            "  SELECT g.id FROM duplicate_groups g "
            "  LEFT JOIN duplicate_members m ON m.group_id = g.id "
            "  GROUP BY g.id HAVING COUNT(m.file_id) < 2)"
        )
        con.commit()
    finally:
        con.close()

    return {"deleted": deleted, "errors": errors, "freed_bytes": freed}
