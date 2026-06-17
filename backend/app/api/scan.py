"""Scan endpoint — triggers a stage-1 inventory scan as a background task."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import auth, paths
from ..scan import inventory
from ..tasks import runner

router = APIRouter(prefix="/api")


class ScanRequest(BaseModel):
    directory: str | None = None  # subdirectory for a partial scan; None = full


@router.post("/scan")
def start_scan(req: ScanRequest, _: str = Depends(auth.current_user)):
    try:
        scope = paths.resolve_within_root(req.directory)
    except ValueError:
        raise HTTPException(status_code=400, detail="directory outside media root")
    if not scope.is_dir():
        raise HTTPException(status_code=404, detail="directory not found")

    task_id = runner.create_task("scan", {"directory": str(scope)})
    runner.enqueue(task_id, lambda ctx: inventory.run_inventory_scan(scope, ctx))
    return {"task_id": task_id}
