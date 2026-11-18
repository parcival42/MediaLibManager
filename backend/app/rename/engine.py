"""Rule assignment lookup, dry-run preview, and apply.

Both ``preview`` and ``apply_renames`` run through the serial task queue so a
large library reports progress instead of a single long request with no
feedback. ``preview``'s full result (every proposed rename) is kept out of the
``tasks.result`` column — that column is read for every row on the Tasks
history list, and a few thousand renames there would bloat it badly — and is
instead cached in ``_preview_cache`` here, fetched once via
``get_cached_preview``.

``find_recent_preview`` layers a second, short-lived cache on top: opening the
Rename page (or switching scope) recomputes nothing if a preview for that
same scope was already computed recently and nothing that could change its
answer has happened since — see its docstring for the exact rule.
"""
import json
import os
import sqlite3
import threading
import time
from collections import OrderedDict, defaultdict
from pathlib import Path

from .. import db, stash
from . import rules

# Guards both caches below: the worker thread writes them while a preview
# computes, request-handling threads read (and evict from) them concurrently.
_preview_lock = threading.Lock()

# Full preview payloads, keyed by task id — kept out of the tasks table (see
# module docstring). Bounded to a handful of entries; nothing needs more than
# the latest one or two in flight.
_MAX_CACHED_PREVIEWS = 4
_preview_cache: "OrderedDict[str, dict]" = OrderedDict()


def get_cached_preview(task_id: str) -> dict | None:
    with _preview_lock:
        return _preview_cache.get(task_id)


def cache_preview(task_id: str, result: dict) -> None:
    with _preview_lock:
        _preview_cache[task_id] = result
        while len(_preview_cache) > _MAX_CACHED_PREVIEWS:
            _preview_cache.popitem(last=False)


# One entry per scope (``None`` = whole library) recording the most recent
# preview computed for it, so a caller that doesn't need a guaranteed-fresh
# answer can be handed that task id instead of triggering a full recompute.
_RECENT_PREVIEW_TTL = 3600  # seconds
_recent_preview: dict[str | None, dict] = {}


def find_recent_preview(directory: str | None) -> str | None:
    """Return a still-valid task id for ``directory``'s last preview, or
    ``None`` if there isn't one.

    Valid means: computed less than ``_RECENT_PREVIEW_TTL`` ago, and the files
    inventory hasn't changed since (``db.files_generation()`` unchanged --
    bumped by scans, enrichment's metadata stage, deletes, cleanup and
    resets). Rule/filter/assignment
    edits change the answer too but aren't tracked here — the user accepted
    relying on the Refresh button (a forced recompute, see ``force`` in
    ``api/rename.py``) after editing those instead of a third trigger here.
    """
    with _preview_lock:
        entry = _recent_preview.get(directory)
        if not entry:
            return None
        if time.time() - entry["computed_at"] > _RECENT_PREVIEW_TTL:
            return None
        if entry["generation"] != db.files_generation():
            return None
        task_id = entry["task_id"]
        if task_id not in _preview_cache:
            # Evicted from the small full-result cache (or the process
            # restarted) — the entry is unusable, so don't keep offering it.
            _recent_preview.pop(directory, None)
            return None

    # Checked against the DB, outside the lock: the in-memory pointer can
    # still be stale in ways none of the checks above catch — the task was
    # remembered right before a race with a cancel landed, or its own final
    # status update failed. Only a row that actually finished 'done' is safe
    # to hand back as if it were a fresh preview.
    con = db.connect()
    try:
        row = con.execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone()
    finally:
        con.close()
    if not row or row["status"] != "done":
        with _preview_lock:
            if _recent_preview.get(directory, {}).get("task_id") == task_id:
                _recent_preview.pop(directory, None)
        return None

    with _preview_lock:
        _preview_cache.move_to_end(task_id)  # keep it from being the next eviction
    return task_id


def _remember_recent_preview(directory: str | None, task_id: str, generation: int) -> None:
    with _preview_lock:
        _recent_preview[directory] = {
            "task_id": task_id,
            "computed_at": time.time(),
            "generation": generation,
        }


def protected_preview_task_ids() -> set[str]:
    """Task ids the preview history cleanup in ``api/rename.py`` must keep:
    everything a ``_recent_preview`` entry points at, plus every result still
    in ``_preview_cache`` -- another browser tab may be displaying one, and
    deleting its row would make that tab's task poll 404 and show an error
    even though the result is still available."""
    with _preview_lock:
        return {entry["task_id"] for entry in _recent_preview.values()} | set(_preview_cache)


def invalidate_recent_previews() -> None:
    """Discard every cached scope's "recent preview" pointer — used wherever
    a forced recompute is meant to make the *next* page load recompute too,
    not just the request that triggered it (apply, manual rename, an
    explicit forced ``/preview`` call)."""
    with _preview_lock:
        _recent_preview.clear()


# A starter rule (directory name + resolution + cleaned-up original filename),
# so a fresh install doesn't start with an empty rule editor.
# Order matters: the rule applies its filters in list order, and "Scene Tags"
# must run before "Separators" -- once "." has become " ", tags like "H.264"
# or "DD5.1" no longer match.
_PREDEFINED_FILTERS = [
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
    {
        "name": "Separators",
        "type": "replace_chars",
        "entries": [{"from": ".", "to": " "}, {"from": "_", "to": " "}],
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


def preview(ctx, directory: str | None = None) -> dict:
    """Compute proposed renames for every present file under ``directory``
    (or the whole library) that has an assigned rule.

    Returns only ``{"rename_count": ..., "pending_count": ...}`` as the task
    result — the full ``{"renames": [...], "pending": [...]}`` (``pending``
    lists files whose rule needs resolution/duration that hasn't been
    enriched yet) is stashed in ``_preview_cache`` under this task's id
    instead, for the caller to fetch via ``get_cached_preview``.

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

    Runs through the task queue like ``apply_renames`` (rather than as a
    plain synchronous read) purely so a large library reports progress
    instead of leaving the UI guessing for however long the matching loop
    below takes — it still only reads the DB, no filesystem writes.
    """
    ctx.log(f"Scope: {directory}" if directory else "Scope: entire library")
    # Captured up front: an inventory change while this runs must invalidate
    # the cached result, not be baked into it as "seen".
    generation = db.files_generation()
    con = db.connect()
    try:
        scope_sql, scope_params = db.under_dir(directory) if directory else ("1", [])
        files = [dict(r) for r in con.execute(
            f"SELECT {_FILE_COLUMNS} FROM files WHERE present = 1 AND {scope_sql}", scope_params
        ).fetchall()]
        all_paths = [r["path"] for r in con.execute(
            f"SELECT path FROM files WHERE {scope_sql}", scope_params
        ).fetchall()]

        assignments = _load_assignments(con)
        filters_by_id = _load_strip_filters(con)
    finally:
        con.close()

    ctx.progress(5)
    taken_by_dir = taken_names_by_dir(all_paths)

    if not files:
        ctx.log("No files in scope.")
        cache_preview(ctx.task_id, {"renames": [], "pending": []})
        _remember_recent_preview(directory, ctx.task_id, generation)
        return {"rename_count": 0, "pending_count": 0}

    ctx.log(f"Matching rules for {len(files)} files…")
    match_step = max(1, len(files) // 50)  # ~50 progress/log updates regardless of scale
    candidates: list[dict] = []
    pending: list[dict] = []
    for i, f in enumerate(files, start=1):
        ctx.raise_if_cancelled()
        match = _best_assignment(assignments, f["path"])
        if match:
            target = rules.build_target_name(match, match["assign_dir"], f, filters_by_id)
            current_name = os.path.basename(f["path"])
            if target is None:
                pending.append({
                    "file_id": f["id"], "path": f["path"],
                    "current_name": current_name, "rule_name": match["rule_name"],
                })
            elif target != current_name:
                candidates.append({
                    "file_id": f["id"],
                    "path": f["path"],
                    "directory": os.path.dirname(f["path"]),
                    "current_name": current_name,
                    "target": target,
                    "rule_id": match["rule_id"],
                    "rule_name": match["rule_name"],
                })
        if i % match_step == 0 or i == len(files):
            ctx.progress(5 + 80 * i / len(files))
            ctx.log(f"Matched {i} of {len(files)} files…")

    ctx.log(f"Resolving {len(candidates)} potential collisions…")
    renames = simulate_collisions(candidates, taken_by_dir, ctx, progress_from=85)

    ctx.log(f"Done — {len(renames)} renames, {len(pending)} pending.")
    cache_preview(ctx.task_id, {"renames": renames, "pending": pending})
    _remember_recent_preview(directory, ctx.task_id, generation)
    return {"rename_count": len(renames), "pending_count": len(pending)}


def taken_names_by_dir(paths) -> dict[str, set[str]]:
    """Basenames grouped by parent directory -- the collision-blocking set
    for ``simulate_collisions``."""
    taken: dict[str, set[str]] = defaultdict(set)
    for p in paths:
        taken[os.path.dirname(p)].add(os.path.basename(p))
    return taken


def simulate_collisions(candidates: list[dict], taken_by_dir: dict[str, set[str]], ctx,
                        progress_from: float = 0) -> list[dict]:
    """Resolve ``_1``/``_2`` suffixes for preview the same way apply will.

    Each candidate needs ``path``, ``directory``, ``current_name`` and
    ``target``; any other keys are carried over. Processed in path order
    (as apply does), so the result matches what apply will produce. Returns
    the renames that still change something, each with ``new_name`` and
    ``collision`` (true when the literal target was taken) instead of
    ``target``; ``taken_by_dir`` is updated in place.
    """
    ordered = sorted(candidates, key=lambda c: c["path"])
    total = len(ordered)
    step = max(1, total // 20)
    renames: list[dict] = []
    for i, c in enumerate(ordered, start=1):
        ctx.raise_if_cancelled()
        taken = taken_by_dir[c["directory"]]
        own = c["current_name"]
        final = rules.next_free_name(c["target"], lambda n: n in taken and n != own)
        taken.discard(own)
        taken.add(final)
        if final != own:
            item = {k: v for k, v in c.items() if k != "target"}
            item["new_name"] = final
            item["collision"] = final != c["target"]
            renames.append(item)
        if i % step == 0 or i == total:
            ctx.progress(progress_from + (100 - progress_from) * i / total)
    return renames


def apply_batch(rows: list[dict], compute_target, ctx) -> dict:
    """Rename ``rows`` (dicts with ``id``, ``path``, ``present``) in path
    order, each to ``compute_target(row)`` (``None`` = skip).

    Shared by rule-based and quick-edit apply. Per-file errors are logged and
    the batch continues. Changed directories are handed to the Stash
    integration, also after a cancellation (files renamed before it still
    changed).
    """
    ordered = sorted(rows, key=lambda r: r["path"])
    total = len(ordered)
    renamed = skipped = errors = 0
    renamed_ids: list[int] = []
    changed_paths: list[str] = []
    con = db.connect()
    try:
        for i, row in enumerate(ordered, start=1):
            ctx.raise_if_cancelled()
            target = compute_target(row) if row["present"] else None
            if target is None or target == os.path.basename(row["path"]):
                skipped += 1
            else:
                outcome = rename_one(con, row["id"], row["path"], target, ctx)
                if outcome == "renamed":
                    renamed += 1
                    renamed_ids.append(row["id"])
                    changed_paths.append(row["path"])
                elif outcome == "error":
                    errors += 1
                else:
                    skipped += 1
            ctx.progress(100 * i / total)
        return {"renamed": renamed, "skipped": skipped, "errors": errors, "renamed_ids": renamed_ids}
    finally:
        con.close()
        stash.notify_changed(changed_paths, ctx.log)


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

    # Invalidate up front, not just on success: even a run that ends in
    # errors/cancellation may have renamed some files before that happened,
    # and the frontend's own post-apply refresh (force=True) won't run if the
    # user navigated away mid-apply — the next page load must not be handed a
    # pre-apply cached preview either way.
    invalidate_recent_previews()

    con = db.connect()
    try:
        assignments = _load_assignments(con)
        filters_by_id = _load_strip_filters(con)
        placeholders = ",".join("?" * len(file_ids))
        rows = [dict(r) for r in con.execute(
            f"SELECT {_FILE_COLUMNS}, present FROM files WHERE id IN ({placeholders})",
            file_ids,
        ).fetchall()]
    finally:
        con.close()

    def compute_target(f: dict) -> str | None:
        match = _best_assignment(assignments, f["path"])
        if not match:
            return None
        return rules.build_target_name(match, match["assign_dir"], f, filters_by_id)

    result = apply_batch(rows, compute_target, ctx)
    result["skipped"] += len(file_ids) - len(rows)  # ids no longer in the DB
    return result


FORBIDDEN_NAME_CHARS = ("/", "\\", "\0")


def is_valid_filename(name: str) -> bool:
    return bool(name) and name not in (".", "..") and not any(c in name for c in FORBIDDEN_NAME_CHARS)


def rename_one(con, fid: int, path: str, target: str, ctx) -> str:
    """Rename one file to ``target`` on disk and update its DB path.

    Collisions are resolved against both the filesystem and the DB
    (``files.path`` is UNIQUE regardless of ``present``), excluding the file's
    own current name. A DB failure rolls the disk rename back so disk and DB
    never disagree. Returns ``"renamed"``, ``"skipped"`` (resolved name equals
    the current one) or ``"error"`` (logged to ``ctx``).
    """
    old_path = Path(path)
    directory = old_path.parent
    current_name = old_path.name

    # A target must be a plain name in the same directory: "/" (from a rule
    # literal, separator or replace filter) would move the file into another
    # directory, ".." even out of the media root.
    if not is_valid_filename(target):
        ctx.log(f"ERROR renaming {current_name}: invalid target name {target!r}")
        return "error"

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
        return "skipped"

    new_path = directory / final_name
    try:
        old_path.rename(new_path)
    except OSError as exc:
        ctx.log(f"ERROR renaming {current_name}: {exc}")
        return "error"

    try:
        con.execute("UPDATE files SET path = ? WHERE id = ?", (str(new_path), fid))
        con.commit()
    except sqlite3.Error as exc:
        con.rollback()
        new_path.rename(old_path)  # keep disk and DB from disagreeing
        ctx.log(f"ERROR renaming {current_name}: {exc}")
        return "error"

    ctx.log(f"{current_name} -> {final_name}")
    return "renamed"
