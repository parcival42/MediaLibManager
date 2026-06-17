"""Database maintenance endpoints -- stats and a stale-row cleanup task.

Cleanup goes through the serial task queue since it walks the whole library
(see ``maintenance/cleanup.py`` for why this is a separate, explicit pass
rather than reusing the inventory scan's ``present`` flag).
"""
from fastapi import APIRouter, Depends

from .. import auth
from ..maintenance import cleanup
from ..tasks import runner

router = APIRouter(prefix="/api/maintenance")


@router.get("/stats")
def maintenance_stats(_: str = Depends(auth.current_user)):
    return cleanup.stats()


@router.post("/cleanup")
def run_cleanup_endpoint(_: str = Depends(auth.current_user)):
    task_id = runner.create_task("maintenance_cleanup", {})
    runner.enqueue(task_id, cleanup.run_cleanup)
    return {"task_id": task_id}
