"""Periodic inventory scan scheduler.

A daemon thread checks, once a minute, whether a full scan is due for today
under ``scan_schedule_*`` (see ``config.DEFAULTS``) and enqueues one via the
normal task queue if so. Disabled while ``scan_schedule_enabled`` is false.
Stage-1 scans are cheap (stat only), so this simply reuses
the same ``run_inventory_scan`` path the manual "Scan" button uses.

Scheduling is server-local-time, day-of-week based (no cron expressions, no
catch-up for days the app was down): every minute, if today's weekday is
enabled and the scheduler hasn't yet run at or after today's configured time,
trigger one. Moving the configured time later *after* today's run already
happened makes it due again the same day (the new target is later than the
last run); moving it earlier than the last run does not re-trigger before
tomorrow. The check only looks at scans the scheduler itself created (tagged
``scheduled: true`` in the task params) — manual scans never count against it
and are never blocked by it; the two are fully independent except that the
serial queue still runs them one at a time.

A second, independent mechanism (``dir_watch_*`` settings) runs a much cheaper
pre-check between full scans: it stats only directories (see
``scan.dir_check``), not files, and enqueues a scoped scan (the same
``run_inventory_scan`` the manual "Scan" button uses) for just the
directories that actually changed since ``_dir_cutoff``. Those tasks are
tagged ``dir_watch: true`` -- deliberately *not* ``scheduled: true`` -- so
they stay invisible to the full-scan due-check above.

``_dir_cutoff`` is a single timestamp, not a per-directory table: a
directory's mtime only advances, so "mtime >= cutoff" is enough to know it
changed since then, without remembering its previous value. It only advances
past a batch's sweep-start time once every task in that batch finished as
``done`` -- if any of them errored or got cancelled, the cutoff stays put so
the next check re-covers the same ground (harmless: scoped scans are cheap
and idempotent) rather than silently skipping a directory that was never
actually reconciled. The cutoff is process-local and resets to "now" on every
restart (matching the rest of the task system's "no resume" model) — the
daily full scan is what catches anything missed across a restart.
"""
import json
import logging
import threading
import time
from datetime import datetime

from . import config, db, paths
from .scan import dir_check, inventory
from .tasks import runner

log = logging.getLogger(__name__)

CHECK_INTERVAL = 60.0  # how often to re-check whether a scan is due

_thread: threading.Thread | None = None
_stop = threading.Event()

# Directory-mtime fast path state (process-local, reset in start()).
_dir_cutoff = 0.0
_dir_check_last_run = 0.0
_dir_batch_task_ids: set[str] = set()
_dir_batch_cutoff: float | None = None


def _last_scheduled_scan_at() -> float | None:
    """Most recent ``created_at`` of a scan the scheduler itself created.

    Inspects ``params`` in Python rather than matching the JSON string so this
    stays correct if scan params ever gain extra keys. Manual scans (started
    from the UI) never carry the ``scheduled`` marker, so they are invisible
    here and never affect the daily schedule.
    """
    con = db.connect()
    rows = con.execute(
        "SELECT params, created_at FROM tasks WHERE type = 'scan' ORDER BY created_at DESC"
    ).fetchall()
    con.close()
    for row in rows:
        if json.loads(row["params"]).get("scheduled"):
            return row["created_at"]
    return None


def _is_due(now: datetime) -> bool:
    if now.weekday() not in config.get("scan_schedule_days"):
        return False
    hour, minute = (int(p) for p in config.get("scan_schedule_time").split(":"))
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if now < target:
        return False

    last = _last_scheduled_scan_at()
    if last is None:
        return True
    return datetime.fromtimestamp(last) < target


def _maybe_trigger() -> None:
    if not config.get("scan_schedule_enabled") or runner.any_task_active():
        return
    if not _is_due(datetime.now()):
        return

    scope = paths.media_root()
    task_id = runner.create_task("scan", {"directory": str(scope), "scheduled": True})
    runner.enqueue(task_id, lambda ctx: inventory.run_inventory_scan(scope, ctx))


def _poll_dir_batch() -> None:
    """Resolve the previous dir-watch batch, if any, before starting another.

    Cutoff only advances once every task in the batch is confirmed 'done' --
    see the module docstring for why a partial failure must leave it in place.
    """
    global _dir_cutoff, _dir_batch_task_ids, _dir_batch_cutoff
    if not _dir_batch_task_ids:
        return
    con = db.connect()
    placeholders = ",".join("?" * len(_dir_batch_task_ids))
    rows = con.execute(
        f"SELECT status FROM tasks WHERE id IN ({placeholders})",
        tuple(_dir_batch_task_ids),
    ).fetchall()
    con.close()
    statuses = [r["status"] for r in rows]
    if any(s in ("queued", "running") for s in statuses):
        return  # still in flight
    if statuses and all(s == "done" for s in statuses):
        _dir_cutoff = _dir_batch_cutoff
    _dir_batch_task_ids = set()
    _dir_batch_cutoff = None


def _maybe_dir_check() -> None:
    global _dir_check_last_run, _dir_batch_task_ids, _dir_batch_cutoff

    if not config.get("dir_watch_enabled") or _dir_batch_task_ids:
        return
    now = time.time()
    interval = config.get("dir_watch_interval_minutes") * 60
    if now - _dir_check_last_run < interval:
        return
    if runner.any_task_active():
        return  # leave _dir_check_last_run alone so this retries next tick

    _dir_check_last_run = now
    root = paths.media_root()
    changed = dir_check.find_changed_dirs(root, _dir_cutoff)
    if not changed:
        _dir_cutoff = now
        return

    ids = set()
    for scope in changed:
        task_id = runner.create_task("scan", {"directory": str(scope), "dir_watch": True})
        runner.enqueue(task_id, lambda ctx, scope=scope: inventory.run_inventory_scan(scope, ctx))
        ids.add(task_id)
    _dir_batch_task_ids = ids
    _dir_batch_cutoff = now


def _loop() -> None:
    # An unhandled exception here would silently kill this daemon thread for
    # the rest of the process's life (nothing restarts it) -- the nightly scan
    # would then just never fire again until the container is restarted, with
    # no visible error. Catch and log instead so the loop keeps checking.
    while not _stop.is_set():
        try:
            _maybe_trigger()
            _poll_dir_batch()
            _maybe_dir_check()
        except Exception:
            log.exception("scheduled scan check failed; will retry in %ss", CHECK_INTERVAL)
        _stop.wait(CHECK_INTERVAL)


def start() -> None:
    """Start the scheduler thread (idempotent)."""
    global _thread, _dir_cutoff, _dir_check_last_run, _dir_batch_task_ids, _dir_batch_cutoff
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _dir_cutoff = time.time()
    _dir_check_last_run = 0.0
    _dir_batch_task_ids = set()
    _dir_batch_cutoff = None
    _thread = threading.Thread(target=_loop, name="scan-scheduler", daemon=True)
    _thread.start()


def stop() -> None:
    """Signal the scheduler to stop and wait briefly for it to finish."""
    _stop.set()
    if _thread:
        _thread.join(timeout=5)
