"""Rename endpoints — rule/assignment CRUD, dry-run preview, and apply.

Preview is a plain read (pure DB derivation, like ``/api/duplicates``); apply
goes through the serial task queue since it touches the filesystem.
"""
import json
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import auth, db, paths
from ..rename import engine
from ..tasks import runner

router = APIRouter(prefix="/api/rename")

ALLOWED_SOURCES = {"literal", "dirname", "resolution", "duration", "filename"}
ALLOWED_FILTER_TYPES = {"strings", "replace_chars"}


def _validate_segments(segments: list[dict]) -> None:
    if not segments:
        raise HTTPException(status_code=400, detail="rule needs at least one segment")
    for seg in segments:
        if seg.get("source") not in ALLOWED_SOURCES:
            raise HTTPException(status_code=400, detail=f"invalid segment source: {seg.get('source')}")


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
    if req.type not in ALLOWED_FILTER_TYPES:
        raise HTTPException(status_code=400, detail=f"invalid filter type: {req.type}")
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
    if req.type not in ALLOWED_FILTER_TYPES:
        raise HTTPException(status_code=400, detail=f"invalid filter type: {req.type}")
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
    _validate_segments(rule.segments)
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
    _validate_segments(rule.segments)
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


@router.get("/preview")
def preview_rename(directory: str | None = None, _: str = Depends(auth.current_user)):
    try:
        scope = paths.resolve_within_root(directory)
    except ValueError:
        raise HTTPException(status_code=400, detail="directory outside media root")
    if not scope.is_dir():
        raise HTTPException(status_code=404, detail="directory not found")
    directory = str(scope) if scope != paths.media_root() else None
    return engine.preview(directory=directory)


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
