"""Exact (byte-identical) duplicate detection — trivial via the stored MD5.

Groups are split by file type so the UI can filter image/video exact
duplicates separately; a group's MD5 match implies identical bytes, so its
members are practically always the same type, but a stray mixed-type
collision falls back to ``exact_other`` rather than being dropped.
"""
import sqlite3


def find_exact_groups(
    con: sqlite3.Connection, directory_pattern: str | None = None
) -> list[tuple[str, list[int]]]:
    """Group present files that share an identical MD5.

    Returns ``(kind, file_ids)`` tuples — kind is ``exact_image``/``exact_video``/
    ``exact_other`` depending on the group's file type. Each group has at least
    two members.
    """
    where = "present = 1 AND md5 IS NOT NULL AND md5 != ''"
    params: list = []
    if directory_pattern:
        where += " AND path LIKE ? ESCAPE '\\'"
        params.append(directory_pattern)

    rows = con.execute(
        f"SELECT id, type, md5 FROM files WHERE {where}", params
    ).fetchall()

    by_md5: dict[str, list[tuple[int, str]]] = {}
    for r in rows:
        by_md5.setdefault(r["md5"], []).append((r["id"], r["type"]))

    groups: list[tuple[str, list[int]]] = []
    for items in by_md5.values():
        if len(items) < 2:
            continue
        ids = sorted(fid for fid, _ in items)
        types = {t for _, t in items}
        if types == {"image"}:
            kind = "exact_image"
        elif types == {"video"}:
            kind = "exact_video"
        else:
            kind = "exact_other"
        groups.append((kind, ids))
    return groups
