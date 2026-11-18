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

``_prune_history`` deletes finished rows older than
``task_history_retention_days`` after every successful completion, so the
table does not grow without bound now that dir-watch and auto-strip can
enqueue tasks on their own periodic schedule rather than only on user action.
"""
import json
import logging
import queue
import threading
import time
import uuid
from collections import deque

from .. import config, db

log = logging.getLogger(__name__)


class TaskCancelled(Exception):
    """Raised inside a task to abort cooperatively; recorded as 'cancelled'."""


# In-memory queue of (task_id, fn). The DB row holds the authoritative status.
_queue: "queue.Queue[tuple[str, object]]" = queue.Queue()
_worker: threading.Thread | None = None
_worker_lock = threading.Lock()

# Idle gate: cleared while a task runs so the enrichment worker yields to it.
_idle = threading.Event()
_idle.set()

# Enrichment leases. Checking ``_idle`` once per batch is not enough: a task
# could start while the enrichment pool is still working through up to a
# few dozen files, and both would then touch the same files (a scan
# resetting a row the worker is about to overwrite, a rename moving a file
# mid-ffprobe). Each enrichment step takes a lease via ``try_begin_enrich``;
# ``_run_one`` closes the gate and waits until all leases are returned
# before the task body runs.
_enrich_cond = threading.Condition()
_enrich_inflight = 0


def try_begin_enrich() -> bool:
    """Take an enrichment lease; ``False`` if a task is (about to start)
    running, in which case the caller must skip the file for now."""
    global _enrich_inflight
    with _enrich_cond:
        if not _idle.is_set():
            return False
        _enrich_inflight += 1
        return True


def end_enrich() -> None:
    global _enrich_inflight
    with _enrich_cond:
        _enrich_inflight -= 1
        _enrich_cond.notify_all()

# Cooperative cancellation.
_cancel_lock = threading.Lock()
_cancel_requested: set[str] = set()
_running_task_id: str | None = None

# Task type, keyed by id, looked up (and popped) once the task finishes — lets
# _run_one act on what kind of task just completed without a DB round-trip.
_task_types: dict[str, str] = {}

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

    # Log/progress are buffered and written at most this often: tasks call
    # them per file, and a DB connect + full-log rewrite per call made large
    # batches (tens of thousands of renames) noticeably slower. ``flush`` is
    # forced before the task's terminal status is written.
    _WRITE_INTERVAL = 0.5  # seconds
    _MAX_LINES = 300

    def __init__(self, task_id: str):
        self.task_id = task_id
        self._lines: deque[str] = deque(maxlen=self._MAX_LINES)
        self._log_dirty = False
        self._progress: float | None = None
        self._last_write = 0.0
        self._lock = threading.Lock()

    def log(self, message: str) -> None:
        with self._lock:
            self._lines.append(message)
            self._log_dirty = True
        self._maybe_flush()

    def progress(self, percent: float) -> None:
        with self._lock:
            self._progress = round(percent, 1)
        self._maybe_flush()

    def _maybe_flush(self) -> None:
        if time.monotonic() - self._last_write >= self._WRITE_INTERVAL:
            self.flush()

    def flush(self) -> None:
        with self._lock:
            cols: dict = {}
            if self._log_dirty:
                cols["log"] = "\n".join(self._lines)
                self._log_dirty = False
            if self._progress is not None:
                cols["progress"] = self._progress
                self._progress = None
            self._last_write = time.monotonic()
        _update(self.task_id, **cols)

    @property
    def cancelled(self) -> bool:
        with _cancel_lock:
            return self.task_id in _cancel_requested

    def raise_if_cancelled(self) -> None:
        if self.cancelled:
            raise TaskCancelled()


def create_task(task_type: str, params: dict) -> str:
    task_id = uuid.uuid4().hex
    _task_types[task_id] = task_type
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


def run_and_wait(task_type: str, params: dict, fn, timeout: float):
    """Run ``fn(ctx)`` as a regular queued task and block until it finished.

    For request handlers that need the outcome synchronously but must still
    be serialized with every other file-changing task. Returns ``fn``'s
    result or re-raises its exception. If the task hasn't finished within
    ``timeout`` (queue busy), it is cancelled and ``TimeoutError`` raised.
    """
    task_id = create_task(task_type, params)
    finished = threading.Event()
    outcome: dict = {}

    def wrapper(ctx):
        try:
            outcome["result"] = fn(ctx)
            return outcome["result"]
        except BaseException as exc:
            outcome["error"] = exc
            raise
        finally:
            finished.set()

    enqueue(task_id, wrapper)
    if not finished.wait(timeout):
        with _cancel_lock:
            started = task_id == _running_task_id
        if not started and request_cancel(task_id) == "cancelled":
            raise TimeoutError(task_id)
        # Already running (or it started in the meantime): its effect is
        # happening, so report the real outcome instead of a timeout.
        finished.wait()
    if "error" in outcome:
        raise outcome["error"]
    return outcome.get("result")


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


def _prune_history() -> None:
    """Delete finished task rows older than ``task_history_retention_days``.

    Runs after every successfully completed task (see ``_run_one``) rather
    than on its own schedule -- an error/cancelled/interrupted task is left
    alone so it stays visible in the history until a later success sweeps it
    away, instead of silently disappearing on its own account.
    """
    retention_days = max(1, int(config.get("task_history_retention_days")))
    cutoff = time.time() - retention_days * 86400
    con = db.connect()
    con.execute(
        "DELETE FROM tasks WHERE status NOT IN ('queued', 'running') "
        "AND COALESCE(ended_at, created_at) < ?",
        (cutoff,),
    )
    con.commit()
    con.close()


def _run_one(task_id: str, fn) -> None:
    global _running_task_id

    task_type = _task_types.pop(task_id, None)

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

    # Close the gate under the lease lock so no new enrichment step can begin,
    # then wait for the ones in flight (a long MD5 can take a while).
    with _enrich_cond:
        _idle.clear()
        _enrich_cond.wait_for(lambda: _enrich_inflight == 0)
    _update(task_id, status="running", started_at=time.time())
    ctx = TaskContext(task_id)
    try:
        try:
            result = fn(ctx) or {}
        finally:
            ctx.flush()
            # Any scan that actually started (done/error/cancelled alike) may
            # have inserted or flagged files. Bumped *before* the status below
            # flips to a terminal state, so a client that sees "done" and
            # immediately asks for a rename preview can't be handed one cached
            # from before this scan.
            if task_type == "scan":
                db.bump_files_generation()
        if ctx.cancelled:
            _update(task_id, status="cancelled", ended_at=time.time())
        else:
            _update(task_id, status="done", progress=100, ended_at=time.time(),
                    result=json.dumps(result))
            # Deliberately outside the try's own error path: a prune failure
            # (e.g. a busy DB) must not flip this already-successful task's
            # recorded status to 'error' -- it's unrelated housekeeping.
            try:
                _prune_history()
            except Exception:
                log.exception("task history prune failed after task %s", task_id)
    except TaskCancelled:
        _update(task_id, status="cancelled", ended_at=time.time())
    except Exception as exc:  # noqa: BLE001 - surfaced to the user via the task log
        ctx.log(f"ERROR: {exc}")
        ctx.flush()
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
