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
"""
import json
import threading
from datetime import datetime

from . import config, db, paths
from .scan import inventory
from .tasks import runner

CHECK_INTERVAL = 60.0  # how often to re-check whether a scan is due

_thread: threading.Thread | None = None
_stop = threading.Event()


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


def _loop() -> None:
    while not _stop.is_set():
        _maybe_trigger()
        _stop.wait(CHECK_INTERVAL)


def start() -> None:
    """Start the scheduler thread (idempotent)."""
    global _thread
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, name="scan-scheduler", daemon=True)
    _thread.start()


def stop() -> None:
    """Signal the scheduler to stop and wait briefly for it to finish."""
    _stop.set()
    if _thread:
        _thread.join(timeout=5)
