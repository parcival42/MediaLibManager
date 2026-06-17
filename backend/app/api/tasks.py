"""Task endpoints — list, inspect, and cancel tasks."""
import json

from fastapi import APIRouter, Depends, HTTPException

from .. import auth, db
from ..tasks import runner

router = APIRouter(prefix="/api")


def _row_to_task(row) -> dict:
    task = dict(row)
    for field in ("params", "result"):
        if task.get(field):
            try:
                task[field] = json.loads(task[field])
            except (TypeError, ValueError):
                pass
    return task


@router.get("/tasks")
def list_tasks(_: str = Depends(auth.current_user)):
    con = db.connect()
    rows = con.execute(
        "SELECT id, type, status, params, progress, result, created_at, started_at, ended_at "
        "FROM tasks ORDER BY created_at DESC LIMIT 50"
    ).fetchall()
    con.close()
    return [_row_to_task(r) for r in rows]


@router.get("/tasks/{task_id}")
def get_task(task_id: str, _: str = Depends(auth.current_user)):
    con = db.connect()
    row = con.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
    con.close()
    if not row:
        raise HTTPException(status_code=404, detail="task not found")
    return _row_to_task(row)


@router.post("/tasks/{task_id}/cancel")
def cancel_task(task_id: str, _: str = Depends(auth.current_user)):
    """Cancel a queued or running task. Queued tasks stop immediately; running
    tasks stop cooperatively at their next cancellation checkpoint."""
    result = runner.request_cancel(task_id)
    if result is None:
        raise HTTPException(status_code=404, detail="task not found")
    return {"status": result}
