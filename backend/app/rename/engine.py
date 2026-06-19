"""Rule assignment lookup, dry-run preview, and apply.

Mirrors the dedup module's split: ``preview`` is a pure derivation over the
already-enriched ``files`` rows (cheap, runs synchronously on a GET like
``/api/duplicates``), while ``apply_renames`` touches the filesystem and runs
through the serial task queue (like ``dedup/delete.py``).
"""
import json
import os
import sqlite3
import time
from collections import defaultdict
from pathlib import Path

from .. import db
from . import rules

# A starter rule (directory name + resolution + cleaned-up original filename),
# so a fresh install doesn't start with an empty rule editor.
_PREDEFINED_FILTERS = [
    {
        "name": "Separators",
        "type": "replace_chars",
        "entries": [{"from": ".", "to": " "}, {"from": "_", "to": " "}],
    },
    {
        "name": "Scene Tags",
        "type": "strings",
        "entries": [
            "2160p", "1080p", "720p", "480p", "360p",
            "4K", "UHD",
            "H.264", "H.265", "x264", "x265",
            "HEVC", "AVC", "AV1",
            "AAC", "MP3", "AC3", "DD5.1",
            "MP4", "MKV", "AVI", "WMV",
        ],
    },
]


def seed_rename_defaults(con) -> None:
    """Seed predefined strip filters and the default rename rule.

    Called once during initial setup when the user opts in. Inserts filters
    first so their IDs can be referenced in the rule's segment JSON.
    """
    filter_ids = []
    for f in _PREDEFINED_FILTERS:
        cur = con.execute(
            "INSERT INTO strip_filters(name, type, entries) VALUES(?, ?, ?)",
            (f["name"], f["type"], json.dumps(f["entries"])),
        )
        filter_ids.append(cur.lastrowid)

    segments = [
        {"source": "dirname", "level": 1},
        {"source": "resolution"},
        {
            "source": "filename",
            "transforms": ["clean_special_chars"],
            "strip_filter_ids": filter_ids,
        },
    ]
    con.execute(
        "INSERT INTO rename_rules(name, segments, separator, created_at) VALUES(?, ?, ?, ?)",
        ("Name - Resolution - Filename", json.dumps(segments), " - ", time.time()),
    )


def _load_strip_filters(con) -> dict:
    """Return all strip filters as {id: {type, entries}} for O(1) lookup."""
    rows = con.execute("SELECT id, type, entries FROM strip_filters").fetchall()
    return {r["id"]: {"type": r["type"], "entries": json.loads(r["entries"])} for r in rows}


def _load_assignments(con) -> list[dict]:
    rows = con.execute(
        "SELECT ra.directory AS assign_dir, r.id AS rule_id, r.name AS rule_name, "
        "r.segments AS segments, r.separator AS separator "
        "FROM rule_assignments ra JOIN rename_rules r ON r.id = ra.rule_id"
    ).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["segments"] = json.loads(d["segments"])
        out.append(d)
    return out


def _best_assignment(assignments: list[dict], path: str) -> dict | None:
    """Deepest matching assignment directory wins (recursive, overridable)."""
    best, best_len = None, -1
    for a in assignments:
        d = a["assign_dir"].rstrip("/\\")
        if path == d or path.startswith(d + os.sep):
            if len(d) > best_len:
                best, best_len = a, len(d)
    return best


_FILE_COLUMNS = "id, path, type, width, height, duration"


def preview(directory: str | None = None) -> dict:
    """Compute proposed renames for every present file under ``directory``
    (or the whole library) that has an assigned rule.

    Returns ``{"renames": [...], "pending": [...]}`` — ``pending`` lists files
    whose rule needs resolution/duration that hasn't been enriched yet.

    Collision resolution is simulated here (same suffix algorithm and the
    same path-sorted processing order as ``apply_renames`` uses), so a file
    that already carries a previously-resolved ``_1`` suffix isn't re-listed
    every time just because the rule's raw output doesn't include it. A
    ``collision: true`` flag means the rule's literal target was taken by
    another file and this one got auto-suffixed instead.

    The collision-blocking set is seeded from every known path in scope,
    regardless of ``present`` — ``files.path`` is UNIQUE in the DB no matter
    whether the row is currently present, and ``apply_renames`` checks the
    DB the same way, so a stale row can't make preview promise a name that
    apply then can't actually use.
    """
    con = db.connect()
    try:
        where = ["present = 1"]
        params: list = []
        if directory:
            like = directory.rstrip(os.sep) + os.sep + "%"
            where.append("(path = ? OR path LIKE ?)")
            params += [directory, like]
        clause = " WHERE " + " AND ".join(where)

        files = [dict(r) for r in con.execute(
            f"SELECT {_FILE_COLUMNS} FROM files{clause}", params
        ).fetchall()]

        scope_clause, scope_params = "", []
        if directory:
            scope_clause = " WHERE path = ? OR path LIKE ?"
            scope_params = [directory, like]
        all_paths = [r["path"] for r in con.execute(
            f"SELECT path FROM files{scope_clause}", scope_params
        ).fetchall()]

        assignments = _load_assignments(con)
        filters_by_id = _load_strip_filters(con)
    finally:
        con.close()

    taken_by_dir: dict[str, set[str]] = defaultdict(set)
    for p in all_paths:
        taken_by_dir[os.path.dirname(p)].add(os.path.basename(p))

    candidates: list[dict] = []
    pending: list[dict] = []
    for f in files:
        match = _best_assignment(assignments, f["path"])
        if not match:
            continue
        target = rules.build_target_name(match, match["assign_dir"], f, filters_by_id)
        current_name = os.path.basename(f["path"])
        if target is None:
            pending.append({
                "file_id": f["id"], "path": f["path"],
                "current_name": current_name, "rule_name": match["rule_name"],
            })
            continue
        if target == current_name:
            continue  # already correctly named
        candidates.append({
            "file_id": f["id"],
            "path": f["path"],
            "directory": os.path.dirname(f["path"]),
            "current_name": current_name,
            "target": target,
            "rule_id": match["rule_id"],
            "rule_name": match["rule_name"],
        })

    candidates.sort(key=lambda c: c["path"])

    renames: list[dict] = []
    for c in candidates:
        taken = taken_by_dir[c["directory"]]
        own = c["current_name"]
        final = rules.next_free_name(c["target"], lambda n: n in taken and n != own)
        taken.discard(own)
        taken.add(final)
        if final == own:
            continue  # already correctly (suffix-)named once resolved
        renames.append({
            "file_id": c["file_id"],
            "path": c["path"],
            "directory": c["directory"],
            "current_name": own,
            "new_name": final,
            "rule_id": c["rule_id"],
            "rule_name": c["rule_name"],
            "collision": final != c["target"],
        })

    renames.sort(key=lambda r: r["path"])
    return {"renames": renames, "pending": pending}


def apply_renames(file_ids: list[int], ctx) -> dict:
    """Rename the given files on disk and update their DB paths.

    Recomputes the target name at apply time (never trusts a client-supplied
    name) and resolves collisions against both the real filesystem and the
    DB (``files.path`` is UNIQUE regardless of ``present`` — a stale row left
    over from an earlier run can claim a name the filesystem considers
    free), excluding each file's own current name (it isn't really
    "colliding" with itself — the rename just hasn't happened yet). Files
    are processed in path-sorted order regardless of selection order, so the
    result matches what preview predicted when multiple files share a
    target name.

    A single file's failure (filesystem error, or a path conflict the
    collision check still missed) is recorded as an error and the batch
    continues — it must not abort renames for the rest of the selection.
    """
    if not file_ids:
        return {"renamed": 0, "skipped": 0, "errors": 0}

    con = db.connect()
    try:
        assignments = _load_assignments(con)
        filters_by_id = _load_strip_filters(con)
        placeholders = ",".join("?" * len(file_ids))
        rows = con.execute(
            f"SELECT {_FILE_COLUMNS}, present FROM files WHERE id IN ({placeholders})",
            file_ids,
        ).fetchall()
        by_id = {r["id"]: dict(r) for r in rows}
        ordered = sorted(file_ids, key=lambda fid: by_id[fid]["path"] if fid in by_id else "")

        total = len(ordered)
        renamed = skipped = errors = 0

        for i, fid in enumerate(ordered, start=1):
            ctx.raise_if_cancelled()
            f = by_id.get(fid)
            if f is None or not f["present"]:
                skipped += 1
                continue

            match = _best_assignment(assignments, f["path"])
            if not match:
                skipped += 1
                continue
            target = rules.build_target_name(match, match["assign_dir"], f, filters_by_id)
            current_name = os.path.basename(f["path"])
            if target is None or target == current_name:
                skipped += 1
                continue

            old_path = Path(f["path"])
            directory = old_path.parent

            def taken(name: str) -> bool:
                if name == current_name:
                    return False
                full = str(directory / name)
                if os.path.exists(full):
                    return True
                return con.execute(
                    "SELECT 1 FROM files WHERE path = ? AND id != ?", (full, fid)
                ).fetchone() is not None

            final_name = rules.next_free_name(target, taken)
            if final_name == current_name:
                skipped += 1
                continue

            new_path = directory / final_name
            try:
                old_path.rename(new_path)
            except OSError as exc:
                errors += 1
                ctx.log(f"ERROR renaming {old_path.name}: {exc}")
                continue

            try:
                con.execute("UPDATE files SET path = ? WHERE id = ?", (str(new_path), fid))
                con.commit()
            except sqlite3.Error as exc:
                con.rollback()
                new_path.rename(old_path)  # keep disk and DB from disagreeing
                errors += 1
                ctx.log(f"ERROR renaming {old_path.name}: {exc}")
                continue

            renamed += 1
            ctx.log(f"{current_name} -> {final_name}")
            ctx.progress(100 * i / total)

        return {"renamed": renamed, "skipped": skipped, "errors": errors}
    finally:
        con.close()
