"""Metadata endpoints -- Title/Comment strip candidates, apply, history.

Candidates is a plain read (pure DB derivation, like ``/api/duplicates``);
strip goes through the serial task queue since it touches the filesystem.
"""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import auth, paths
from ..metadata import strip
from ..tasks import runner

router = APIRouter(prefix="/api/metadata")


@router.get("/candidates")
def list_candidates(directory: str | None = None, _: str = Depends(auth.current_user)):
    try:
        scope = paths.resolve_within_root(directory)
    except ValueError:
        raise HTTPException(status_code=400, detail="directory outside media root")
    if not scope.is_dir():
        raise HTTPException(status_code=404, detail="directory not found")
    directory = str(scope) if scope != paths.media_root() else None
    return {"candidates": strip.candidates(directory=directory)}


class StripRequest(BaseModel):
    file_ids: list[int]


@router.post("/strip")
def strip_metadata(req: StripRequest, _: str = Depends(auth.current_user)):
    if not req.file_ids:
        raise HTTPException(status_code=400, detail="no files selected")
    ids = list(req.file_ids)
    task_id = runner.create_task("metadata_strip", {"count": len(ids)})
    runner.enqueue(task_id, lambda ctx: strip.apply_strip(ids, ctx))
    return {"task_id": task_id}


@router.get("/history")
def metadata_history(limit: int = 200, _: str = Depends(auth.current_user)):
    return {"history": strip.history(limit=limit)}
