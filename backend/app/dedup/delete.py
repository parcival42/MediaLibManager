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


def _last_copies(con, selected: set[int]) -> dict[int, str]:
    """Ids (-> path) that must survive so no duplicate group loses every copy.

    For each group whose members are *all* selected, the best copy (same
    ranking as the UI's "keep": highest resolution, then largest, then
    oldest) is protected. Guards the backend against a selection that
    includes the keep card, whatever the UI sends.
    """
    if not selected:
        return {}
    placeholders = ",".join("?" * len(selected))
    group_ids = [r["group_id"] for r in con.execute(
        f"SELECT DISTINCT group_id FROM duplicate_members WHERE file_id IN ({placeholders})",
        list(selected),
    ).fetchall()]
    protected: dict[int, str] = {}
    for gid in group_ids:
        members = con.execute(
            "SELECT f.id, f.path FROM duplicate_members m JOIN files f ON f.id = m.file_id "
            "WHERE m.group_id = ? "
            "ORDER BY COALESCE(f.width, 0) * COALESCE(f.height, 0) DESC, "
            "COALESCE(f.size, 0) DESC, COALESCE(f.mtime, 0) ASC",
            (gid,),
        ).fetchall()
        if members and all(m["id"] in selected for m in members):
            protected[members[0]["id"]] = members[0]["path"]
    return protected


def run_delete(file_ids: list[int], ctx) -> dict:
    deleted = 0
    errors = 0
    freed = 0
    con = db.connect()
    try:
        protected = _last_copies(con, set(file_ids))
        for fid in file_ids:
            ctx.raise_if_cancelled()
            if fid in protected:
                ctx.log(f"SKIP (last remaining copy of its duplicate group): {protected[fid]}")
                continue
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
                existed = os.path.isfile(path)
                if existed:
                    os.remove(path)
                    # Only a file actually removed here frees space; one that
                    # was already gone just loses its stale row.
                    con.execute(
                        "INSERT INTO delete_history(path, filename, size, deleted_at) "
                        "VALUES(?, ?, ?, ?)",
                        (path, os.path.basename(path), row["size"], time.time()),
                    )
                    freed += row["size"] or 0
                con.execute("DELETE FROM files WHERE id = ?", (fid,))
                con.commit()
                deleted += 1
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
        if deleted:
            db.bump_files_generation()

    return {"deleted": deleted, "errors": errors, "freed_bytes": freed}
