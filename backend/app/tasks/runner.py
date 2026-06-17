"""Serial task queue.

A single worker thread runs at most one action task at a time (scan today;
rename / metadata-strip / delete in later milestones). Tasks are persisted in
the ``tasks`` table for history and live status; the in-memory queue only holds
the pending callables. A container restart therefore drops the queue — matching
the "no resume, mark interrupted on restart" decision.

The enrichment worker pauses while a task is running (the ``_idle`` gate) so the
two never touch files at the same time. Cancellation is cooperative: the task id
is added to ``_cancel_requested`` and the running callable observes it via
``ctx.cancelled`` / ``ctx.raise_if_cancelled()`` between items.
"""
import json
import queue
import threading
import time
import uuid

from .. import db


class TaskCancelled(Exception):
    """Raised inside a task to abort cooperatively; recorded as 'cancelled'."""


# In-memory queue of (task_id, fn). The DB row holds the authoritative status.
_queue: "queue.Queue[tuple[str, object]]" = queue.Queue()
_worker: threading.Thread | None = None
_worker_lock = threading.Lock()

# Idle gate: cleared while a task runs so the enrichment worker yields to it.
_idle = threading.Event()
_idle.set()

# Cooperative cancellation.
_cancel_lock = threading.Lock()
_cancel_requested: set[str] = set()
_running_task_id: str | None = None


def any_task_active() -> bool:
    return not _idle.is_set()


def wait_until_idle(timeout: float | None = None) -> bool:
    """Block until no task is running. Returns True if idle, False on timeout."""
    return _idle.wait(timeout)


def _update(task_id: str, **cols) -> None:
    if not cols:
        return
    assignments = ", ".join(f"{k} = ?" for k in cols)
    con = db.connect()
    con.execute(f"UPDATE tasks SET {assignments} WHERE id = ?", (*cols.values(), task_id))
    con.commit()
    con.close()


class TaskContext:
    """Passed to the task callable so it can report progress and log lines, and
    observe cooperative cancellation."""

    def __init__(self, task_id: str):
        self.task_id = task_id
        self._lines: list[str] = []

    def log(self, message: str) -> None:
        self._lines.append(message)
        _update(self.task_id, log="\n".join(self._lines[-300:]))

    def progress(self, percent: float) -> None:
        _update(self.task_id, progress=round(percent, 1))

    @property
    def cancelled(self) -> bool:
        with _cancel_lock:
            return self.task_id in _cancel_requested

    def raise_if_cancelled(self) -> None:
        if self.cancelled:
            raise TaskCancelled()


def create_task(task_type: str, params: dict) -> str:
    task_id = uuid.uuid4().hex
    con = db.connect()
    con.execute(
        "INSERT INTO tasks(id, type, status, params, progress, created_at) "
        "VALUES(?, ?, 'queued', ?, 0, ?)",
        (task_id, task_type, json.dumps(params), time.time()),
    )
    con.commit()
    con.close()
    return task_id


def enqueue(task_id: str, fn) -> None:
    """Append a task to the serial queue. ``fn(ctx)`` runs on the worker thread,
    one task at a time, in submission order."""
    _ensure_worker()
    _queue.put((task_id, fn))


def request_cancel(task_id: str) -> str | None:
    """Cancel a queued or running task.

    Returns a status hint (``"cancelled"`` if it had not started, ``"cancelling"``
    if it is running and must stop cooperatively, or the existing terminal status
    for a no-op) — or ``None`` if the task does not exist.
    """
    con = db.connect()
    row = con.execute("SELECT status FROM tasks WHERE id = ?", (task_id,)).fetchone()
    con.close()
    if not row:
        return None
    status = row["status"]
    if status not in ("queued", "running"):
        return status  # already terminal — no-op

    with _cancel_lock:
        _cancel_requested.add(task_id)
        running_now = task_id == _running_task_id

    if not running_now:
        # Still waiting in the queue: cancel it right away. The conditional keeps
        # this safe against the race where the worker has just picked it up — it
        # would already be 'running', so the running task handles cancellation.
        con = db.connect()
        con.execute(
            "UPDATE tasks SET status = 'cancelled', ended_at = ? "
            "WHERE id = ? AND status = 'queued'",
            (time.time(), task_id),
        )
        con.commit()
        con.close()
    return "cancelling" if running_now else "cancelled"


def _run_one(task_id: str, fn) -> None:
    global _running_task_id

    # A task cancelled while still waiting in the queue: drop it without running.
    with _cancel_lock:
        if task_id in _cancel_requested:
            _cancel_requested.discard(task_id)
            skip = True
        else:
            _running_task_id = task_id
            skip = False
    if skip:
        _update(task_id, status="cancelled", ended_at=time.time())
        return

    _idle.clear()
    _update(task_id, status="running", started_at=time.time())
    ctx = TaskContext(task_id)
    try:
        result = fn(ctx) or {}
        if ctx.cancelled:
            _update(task_id, status="cancelled", ended_at=time.time())
        else:
            _update(task_id, status="done", progress=100, ended_at=time.time(),
                    result=json.dumps(result))
    except TaskCancelled:
        _update(task_id, status="cancelled", ended_at=time.time())
    except Exception as exc:  # noqa: BLE001 - surfaced to the user via the task log
        ctx.log(f"ERROR: {exc}")
        _update(task_id, status="error", ended_at=time.time())
    finally:
        with _cancel_lock:
            _cancel_requested.discard(task_id)
            _running_task_id = None
        _idle.set()


def _dispatch_loop() -> None:
    while True:
        task_id, fn = _queue.get()
        try:
            _run_one(task_id, fn)
        finally:
            _queue.task_done()


def _ensure_worker() -> None:
    global _worker
    with _worker_lock:
        if _worker and _worker.is_alive():
            return
        _worker = threading.Thread(target=_dispatch_loop, name="task-worker", daemon=True)
        _worker.start()


def start_worker() -> None:
    """Start the dispatcher thread (idempotent). Called once at app startup."""
    _ensure_worker()
