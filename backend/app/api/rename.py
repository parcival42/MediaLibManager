"""Rename endpoints — rule/assignment CRUD, dry-run preview, and apply.

Preview and apply both go through the serial task queue: preview only reads
the DB (no filesystem writes), but is queued the same way as apply so a large
library reports progress instead of leaving the caller waiting on a single
long request with no feedback.
"""
import json
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import auth, db, paths
from ..rename import engine, quick
from ..tasks import runner

router = APIRouter(prefix="/api/rename")

ALLOWED_SOURCES = {"literal", "dirname", "resolution", "duration", "filename"}
ALLOWED_FILTER_TYPES = {"strings", "replace_chars"}


def _reject_path_chars(value, what: str) -> None:
    """Rule/filter text ends up in target filenames; "/" etc. would turn a
    rename into a move (see engine.is_valid_filename)."""
    if isinstance(value, str) and any(c in value for c in engine.FORBIDDEN_NAME_CHARS):
        raise HTTPException(status_code=400, detail=f"{what} must not contain / or \\")


def _validate_segments(segments: list[dict], separator: str) -> None:
    if not segments:
        raise HTTPException(status_code=400, detail="rule needs at least one segment")
    _reject_path_chars(separator, "separator")
    for seg in segments:
        if seg.get("source") not in ALLOWED_SOURCES:
            raise HTTPException(status_code=400, detail=f"invalid segment source: {seg.get('source')}")
        if seg.get("source") == "literal":
            _reject_path_chars(seg.get("text", ""), "literal text")


def _validate_filter(req: "StripFilterIn") -> None:
    if req.type not in ALLOWED_FILTER_TYPES:
        raise HTTPException(status_code=400, detail=f"invalid filter type: {req.type}")
    if req.type == "replace_chars":
        for entry in req.entries:
            if isinstance(entry, dict):
                _reject_path_chars(entry.get("to", ""), "replacement")


class StripFilterIn(BaseModel):
    name: str
    type: str
    entries: list


class RuleIn(BaseModel):
    name: str
    segments: list[dict]
    separator: str = " - "


@router.get("/strip-filters")
def list_strip_filters(_: str = Depends(auth.current_user)):
    con = db.connect()
    rows = con.execute("SELECT id, name, type, entries FROM strip_filters ORDER BY name").fetchall()
    con.close()
    out = []
    for r in rows:
        d = dict(r)
        d["entries"] = json.loads(d["entries"])
        out.append(d)
    return out


@router.post("/strip-filters")
def create_strip_filter(req: StripFilterIn, _: str = Depends(auth.current_user)):
    _validate_filter(req)
    con = db.connect()
    cur = con.execute(
        "INSERT INTO strip_filters(name, type, entries) VALUES(?, ?, ?)",
        (req.name, req.type, json.dumps(req.entries)),
    )
    con.commit()
    filter_id = cur.lastrowid
    con.close()
    return {"id": filter_id}


@router.put("/strip-filters/{filter_id}")
def update_strip_filter(filter_id: int, req: StripFilterIn, _: str = Depends(auth.current_user)):
    _validate_filter(req)
    con = db.connect()
    cur = con.execute(
        "UPDATE strip_filters SET name = ?, type = ?, entries = ? WHERE id = ?",
        (req.name, req.type, json.dumps(req.entries), filter_id),
    )
    con.commit()
    found = cur.rowcount > 0
    con.close()
    if not found:
        raise HTTPException(status_code=404, detail="strip filter not found")
    return {"ok": True}


@router.delete("/strip-filters/{filter_id}")
def delete_strip_filter(filter_id: int, _: str = Depends(auth.current_user)):
    con = db.connect()
    cur = con.execute("DELETE FROM strip_filters WHERE id = ?", (filter_id,))
    con.commit()
    found = cur.rowcount > 0
    con.close()
    if not found:
        raise HTTPException(status_code=404, detail="strip filter not found")
    return {"ok": True}


@router.get("/rules")
def list_rules(_: str = Depends(auth.current_user)):
    con = db.connect()
    rows = con.execute("SELECT id, name, segments, separator, created_at FROM rename_rules ORDER BY name").fetchall()
    con.close()
    out = []
    for r in rows:
        d = dict(r)
        d["segments"] = json.loads(d["segments"])
        out.append(d)
    return out


@router.post("/rules")
def create_rule(rule: RuleIn, _: str = Depends(auth.current_user)):
    _validate_segments(rule.segments, rule.separator)
    con = db.connect()
    cur = con.execute(
        "INSERT INTO rename_rules(name, segments, separator, created_at) VALUES(?, ?, ?, ?)",
        (rule.name, json.dumps(rule.segments), rule.separator, time.time()),
    )
    con.commit()
    rule_id = cur.lastrowid
    con.close()
    return {"id": rule_id}


@router.put("/rules/{rule_id}")
def update_rule(rule_id: int, rule: RuleIn, _: str = Depends(auth.current_user)):
    _validate_segments(rule.segments, rule.separator)
    con = db.connect()
    cur = con.execute(
        "UPDATE rename_rules SET name = ?, segments = ?, separator = ? WHERE id = ?",
        (rule.name, json.dumps(rule.segments), rule.separator, rule_id),
    )
    con.commit()
    found = cur.rowcount > 0
    con.close()
    if not found:
        raise HTTPException(status_code=404, detail="rule not found")
    return {"ok": True}


@router.delete("/rules/{rule_id}")
def delete_rule(rule_id: int, _: str = Depends(auth.current_user)):
    con = db.connect()
    cur = con.execute("DELETE FROM rename_rules WHERE id = ?", (rule_id,))
    con.commit()
    found = cur.rowcount > 0
    con.close()
    if not found:
        raise HTTPException(status_code=404, detail="rule not found")
    return {"ok": True}


class AssignmentIn(BaseModel):
    directory: str
    rule_id: int


@router.get("/assignments")
def list_assignments(_: str = Depends(auth.current_user)):
    con = db.connect()
    rows = con.execute(
        "SELECT ra.id, ra.directory, ra.rule_id, r.name AS rule_name "
        "FROM rule_assignments ra JOIN rename_rules r ON r.id = ra.rule_id "
        "ORDER BY ra.directory"
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]


@router.post("/assignments")
def create_assignment(req: AssignmentIn, _: str = Depends(auth.current_user)):
    try:
        directory = paths.resolve_within_root(req.directory)
    except ValueError:
        raise HTTPException(status_code=400, detail="directory outside media root")
    if not directory.is_dir():
        raise HTTPException(status_code=404, detail="directory not found")

    con = db.connect()
    rule = con.execute("SELECT id FROM rename_rules WHERE id = ?", (req.rule_id,)).fetchone()
    if rule is None:
        con.close()
        raise HTTPException(status_code=404, detail="rule not found")
    cur = con.execute(
        "INSERT INTO rule_assignments(directory, rule_id) VALUES(?, ?)",
        (str(directory), req.rule_id),
    )
    con.commit()
    assignment_id = cur.lastrowid
    con.close()
    return {"id": assignment_id}


@router.delete("/assignments/{assignment_id}")
def delete_assignment(assignment_id: int, _: str = Depends(auth.current_user)):
    con = db.connect()
    cur = con.execute("DELETE FROM rule_assignments WHERE id = ?", (assignment_id,))
    con.commit()
    found = cur.rowcount > 0
    con.close()
    if not found:
        raise HTTPException(status_code=404, detail="assignment not found")
    return {"ok": True}


def _prune_preview_tasks(task_type: str) -> None:
    """Delete finished preview tasks of ``task_type`` before a new one starts.

    A finished preview is done being useful once a newer one exists; without
    this, preview runs would fill up the Tasks history and push real
    scans/renames off its first page. Rows whose result is still cached (see
    ``engine.protected_preview_task_ids``) are kept, since a cache entry or
    another open tab may still point at them.
    """
    keep_ids = engine.protected_preview_task_ids()
    sql = "DELETE FROM tasks WHERE type = ? AND status NOT IN ('queued', 'running')"
    params: list = [task_type]
    if keep_ids:
        sql += f" AND id NOT IN ({','.join('?' * len(keep_ids))})"
        params += list(keep_ids)
    con = db.connect()
    con.execute(sql, params)
    con.commit()
    con.close()


def _normalize_scope(directory: str | None) -> str | None:
    """Validate a preview scope; the media root itself maps to ``None``."""
    try:
        scope = paths.resolve_within_root(directory)
    except ValueError:
        raise HTTPException(status_code=400, detail="directory outside media root")
    if not scope.is_dir():
        raise HTTPException(status_code=404, detail="directory not found")
    return str(scope) if scope != paths.media_root() else None


@router.get("/preview/recent")
def recent_preview(directory: str | None = None, _: str = Depends(auth.current_user)):
    """Look up a still-valid cached preview for the scope without computing one.

    The Rename page calls this on open / scope switch and only shows a cached
    result; a new preview is computed solely on explicit request (POST
    /preview). Declared before ``/preview/{task_id}`` so "recent" is not taken
    for a task id.
    """
    return {"task_id": engine.find_recent_preview(_normalize_scope(directory))}


@router.post("/preview")
def preview_rename(directory: str | None = None, force: bool = False, _: str = Depends(auth.current_user)):
    directory = _normalize_scope(directory)

    # `force=False` reuses a recent-enough preview for this scope instead of
    # recomputing — see engine.find_recent_preview. (The page itself no longer
    # uses it: on open it only looks up the cache via GET /preview/recent.)
    # `force=True` (the create/refresh button) always recomputes and, since the user
    # asked Refresh to fully discard the cache, drops every scope's cached
    # pointer too — not just this one's.
    if not force:
        recent = engine.find_recent_preview(directory)
        if recent:
            return {"task_id": recent}
    else:
        engine.invalidate_recent_previews()

    _prune_preview_tasks("rename_preview")
    task_id = runner.create_task("rename_preview", {"directory": directory})
    runner.enqueue(task_id, lambda ctx: engine.preview(ctx, directory=directory))
    return {"task_id": task_id}


@router.get("/preview/{task_id}")
def get_preview_result(task_id: str, _: str = Depends(auth.current_user)):
    result = engine.get_cached_preview(task_id)
    if result is None:
        raise HTTPException(status_code=404, detail="preview result not available")
    return result


class ApplyRequest(BaseModel):
    file_ids: list[int]


@router.post("/apply")
def apply_rename(req: ApplyRequest, _: str = Depends(auth.current_user)):
    if not req.file_ids:
        raise HTTPException(status_code=400, detail="no files selected")
    ids = list(req.file_ids)
    task_id = runner.create_task("rename", {"count": len(ids)})
    runner.enqueue(task_id, lambda ctx: engine.apply_renames(ids, ctx))
    return {"task_id": task_id}


# --- Quick edit: rule-free remove/replace of terms in filenames -------------

QUICK_MODES = {"remove", "replace"}

class QuickParams(BaseModel):
    directory: str | None = None
    recursive: bool = False
    terms: list[str]
    mode: str = "remove"
    replacement: str = ""


class QuickApplyRequest(QuickParams):
    file_ids: list[int]


def _resolve_quick(req: QuickParams) -> tuple[str, list[str], str]:
    """Validate quick-edit parameters; returns (directory, terms, replacement)."""
    try:
        scope = paths.resolve_within_root(req.directory)
    except ValueError:
        raise HTTPException(status_code=400, detail="directory outside media root")
    if not scope.is_dir():
        raise HTTPException(status_code=404, detail="directory not found")
    if req.mode not in QUICK_MODES:
        raise HTTPException(status_code=400, detail=f"invalid mode: {req.mode}")
    terms = quick.normalize_terms(req.terms)
    if not terms:
        raise HTTPException(status_code=400, detail="no terms given")
    replacement = req.replacement if req.mode == "replace" else ""
    _reject_path_chars(replacement, "replacement")
    return str(scope), terms, replacement


@router.post("/quick/preview")
def quick_preview(req: QuickParams, _: str = Depends(auth.current_user)):
    directory, terms, replacement = _resolve_quick(req)
    _prune_preview_tasks("rename_quick_preview")
    task_id = runner.create_task(
        "rename_quick_preview",
        {"directory": directory, "recursive": req.recursive, "terms": terms, "mode": req.mode},
    )
    runner.enqueue(
        task_id, lambda ctx: quick.preview(ctx, directory, req.recursive, terms, replacement)
    )
    return {"task_id": task_id}


@router.post("/quick/apply")
def quick_apply(req: QuickApplyRequest, _: str = Depends(auth.current_user)):
    if not req.file_ids:
        raise HTTPException(status_code=400, detail="no files selected")
    directory, terms, replacement = _resolve_quick(req)
    ids = list(req.file_ids)
    task_id = runner.create_task("rename", {"count": len(ids), "quick": True})
    runner.enqueue(
        task_id, lambda ctx: quick.apply(ids, directory, req.recursive, terms, replacement, ctx)
    )
    return {"task_id": task_id}
