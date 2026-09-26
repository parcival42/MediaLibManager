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
``scan.dir_check``), not files, and collects the ones that actually changed
since ``_dir_cutoff`` into a *single* ``dir_watch: true`` task (deliberately
*not* ``scheduled: true``, so it stays invisible to the full-scan due-check
above) that scans them one after another via
``inventory.run_inventory_scan_batch``. One task rather than one per changed
directory means a busy tick (many directories changed at once) only pauses
the enrichment worker for one task's lifetime instead of fragmenting it
across as many pause/resume cycles as there are changed directories.

The check fires on clock-aligned minute boundaries (like cron's ``*/N``),
not "N minutes after whenever it last ran": with a 5-minute interval it runs
at :00/:05/:10/..., not at e.g. :23/:28/:33 depending on when the setting was
saved. This makes the loop's own tick *phase* load-bearing: the four checks
take non-zero time (DB connections, a tasks-table scan), so a naive fixed
60-second wait would drift a little later every tick and eventually skip a
minute value outright -- silently dropping an aligned check about once per
cycle. ``_loop()`` instead re-aligns its wait to ``60 - (now % 60)`` each
time so every wall-clock minute is visited exactly once. ``_dir_check_last_slot``
(absolute minutes since the epoch) still de-dupes on top of that, mainly so
an early return from ``_stop.wait()`` can't fire the same minute twice.
Skipping a slot (e.g. because a task was active) does not reschedule
anything -- it simply waits for the next aligned minute, same as cron would.

``_dir_cutoff`` is a single timestamp, not a per-directory table: a
directory's mtime only advances, so "mtime >= cutoff" is enough to know it
changed since then, without remembering its previous value. It only advances
past a batch's sweep-start time once that batch's task finished as ``done``
-- if it errored or got cancelled, the cutoff stays put so the next check
re-covers the same directories (harmless: scoped scans are cheap and
idempotent) rather than silently skipping one that was never actually
reconciled. The cutoff is process-local and resets to "now" on every
restart (matching the rest of the task system's "no resume" model) — the
daily full scan is what catches anything missed across a restart.

Two more settings piggyback on this same loop:

- ``scan_schedule_cleanup_enabled`` chains a ``maintenance_cleanup`` task
  right after the scheduled full scan (see ``maintenance.cleanup``) -- the
  scan's own ``present`` flag never deletes a row (a missing path might be a
  pending rename), so this is what actually removes rows for files that are
  really gone. Queued unconditionally after the scan; cleanup re-verifies
  every row itself and has its own guard against mass-deleting on a bad
  mount, so it does not need to know whether the scan succeeded.

``metadata_auto_strip_enabled`` is *not* driven by this loop. Polling for
strip candidates on a fixed timer meant it could fire in the middle of a
large enrichment backlog, pausing the enrichment worker for a strip batch
just to go back to enriching more of the same backlog seconds later. Instead
the enrichment worker (``enrich.worker``) triggers it itself, right after it
drains its pending work and would otherwise idle -- see that module's
``_maybe_trigger_auto_strip``. It uses the same
``metadata.strip.auto_candidate_ids()`` eligibility as the manual "Remove
metadata" UI, minus files that already failed the integrity check once.

The dir-watch pre-check deliberately never creates a task row when nothing
changed (that's the whole point -- most ticks do nothing), which makes it
invisible by default. ``dir_watch_status()`` exposes the process-local state
behind it (last run, what that run found, any exception) so the UI can show
something without spamming the task history with empty runs. Each of the
three checks in ``_loop()`` is wrapped separately (``_guarded``) so one
throwing does not also skip the others for that tick, and so the exception
lands in ``_last_error`` under its own name instead of one shared, anonymous
"something failed" log line.
"""
import json
import logging
import threading
import time
from datetime import datetime, timedelta

from . import config, db, paths
from .maintenance import cleanup
from .scan import dir_check, inventory
from .tasks import runner

log = logging.getLogger(__name__)

_thread: threading.Thread | None = None
_stop = threading.Event()

# Directory-mtime fast path state (process-local, reset in start()).
_dir_cutoff = 0.0
_dir_check_last_run = 0.0            # display only
_dir_check_last_slot: int | None = None  # absolute minute id; de-dupes within one aligned minute
_dir_batch_task_id: str | None = None
_dir_batch_cutoff: float | None = None
_dir_last_changed_count: int | None = None
_dir_last_enqueued_count: int | None = None

# Per-check last exception, keyed by check name (process-local, reset in start()).
_last_error: dict[str, str | None] = {
    "trigger": None, "dir_batch": None, "dir_check": None,
}


def _last_scheduled_scan_at() -> float | None:
    """Most recent ``created_at`` of a *successfully completed* scan the
    scheduler itself created.

    Inspects ``params`` in Python rather than matching the JSON string so this
    stays correct if scan params ever gain extra keys. Manual scans (started
    from the UI) never carry the ``scheduled`` marker, so they are invisible
    here and never affect the daily schedule.

    Only ``status = 'done'`` counts as "today's scan already happened" --
    otherwise a scan that got marked ``interrupted`` by a container restart
    right around the scheduled time (or one that errored/was cancelled)
    would still count, and the real scan would then silently never run for
    the rest of that day.
    """
    con = db.connect()
    rows = con.execute(
        "SELECT params, created_at FROM tasks WHERE type = 'scan' AND status = 'done' "
        "ORDER BY created_at DESC"
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

    if config.get("scan_schedule_cleanup_enabled"):
        cleanup_task_id = runner.create_task("maintenance_cleanup", {"scheduled": True})
        runner.enqueue(cleanup_task_id, cleanup.run_cleanup)


def _poll_dir_batch() -> None:
    """Resolve the previous dir-watch batch task, if any, before starting another.

    Cutoff only advances once that task is confirmed 'done' -- see the module
    docstring for why a partial failure must leave it in place.
    """
    global _dir_cutoff, _dir_batch_task_id, _dir_batch_cutoff
    if not _dir_batch_task_id:
        return
    con = db.connect()
    row = con.execute("SELECT status FROM tasks WHERE id = ?", (_dir_batch_task_id,)).fetchone()
    con.close()
    status = row["status"] if row else None
    if status in ("queued", "running"):
        return  # still in flight
    if status == "done":
        _dir_cutoff = _dir_batch_cutoff
    _dir_batch_task_id = None
    _dir_batch_cutoff = None


def _next_aligned_epoch(interval_minutes: int, now: float | None = None) -> float:
    """Next clock-aligned minute boundary strictly after the start of the
    current minute -- e.g. interval=5 at 21:23:xx returns 21:25:00."""
    dt = datetime.fromtimestamp(now if now is not None else time.time())
    total = dt.hour * 60 + dt.minute
    minutes_ahead = interval_minutes - (total % interval_minutes)
    return (dt.replace(second=0, microsecond=0) + timedelta(minutes=minutes_ahead)).timestamp()


def _maybe_dir_check() -> None:
    global _dir_cutoff, _dir_check_last_run, _dir_check_last_slot
    global _dir_batch_task_id, _dir_batch_cutoff
    global _dir_last_changed_count, _dir_last_enqueued_count

    if not config.get("dir_watch_enabled") or _dir_batch_task_id:
        return

    interval = max(1, int(config.get("dir_watch_interval_minutes")))
    now_dt = datetime.now()
    if (now_dt.hour * 60 + now_dt.minute) % interval != 0:
        return
    slot = int(time.time() // 60)
    if slot == _dir_check_last_slot:
        return  # this aligned minute is already handled
    if runner.any_task_active():
        return  # skip this slot entirely; retry at the next aligned minute

    _dir_check_last_slot = slot
    _dir_check_last_run = time.time()
    root = paths.media_root()
    changed = dir_check.find_changed_dirs(root, _dir_cutoff)
    _dir_last_changed_count = len(changed)
    if not changed:
        _dir_last_enqueued_count = 0
        _dir_cutoff = _dir_check_last_run
        return

    # One task for every changed directory in this tick, not one task each --
    # see the module docstring for why that matters to the enrichment worker.
    task_id = runner.create_task(
        "scan", {"directories": [str(s) for s in changed], "dir_watch": True},
    )
    runner.enqueue(task_id, lambda ctx: inventory.run_inventory_scan_batch(changed, ctx))
    _dir_batch_task_id = task_id
    _dir_batch_cutoff = _dir_check_last_run
    _dir_last_enqueued_count = len(changed)


def dir_watch_status() -> dict:
    """Process-local diagnostic snapshot for the Settings UI -- see the module
    docstring for why this exists instead of a task-history row per tick."""
    interval_minutes = max(1, int(config.get("dir_watch_interval_minutes")))
    return {
        "enabled": config.get("dir_watch_enabled"),
        "interval_minutes": interval_minutes,
        "cutoff": _dir_cutoff or None,
        "last_check_at": _dir_check_last_run or None,
        "next_check_at": _next_aligned_epoch(interval_minutes),
        "dirs_changed_last_check": _dir_last_changed_count,
        "tasks_enqueued_last_check": _dir_last_enqueued_count,
        "batch_in_flight": bool(_dir_batch_task_id),
        "last_error": _last_error["dir_check"],
    }


def _guarded(name: str, fn) -> None:
    """Run one check in isolation: an exception here must not also skip the
    other checks in this tick (they used to share one try/except), and gets
    recorded under its own name in ``_last_error`` instead of one generic,
    anonymous log line -- see ``dir_watch_status()``."""
    try:
        fn()
        _last_error[name] = None
    except Exception as exc:
        _last_error[name] = str(exc)
        log.exception("%s check failed; will retry on the next tick", name)


def _loop() -> None:
    # An unhandled exception here would silently kill this daemon thread for
    # the rest of the process's life (nothing restarts it) -- the nightly scan
    # would then just never fire again until the container is restarted, with
    # no visible error. Catch and log instead so the loop keeps checking.
    while not _stop.is_set():
        _guarded("trigger", _maybe_trigger)
        _guarded("dir_batch", _poll_dir_batch)
        _guarded("dir_check", _maybe_dir_check)
        # Re-align to the wall clock instead of waiting a fixed 60s
        # from whenever the checks above finished: their own runtime (DB
        # connections, a tasks-table scan) would otherwise make the tick phase
        # drift later each time until it skips a minute value outright -- which
        # for the clock-aligned dir-watch check above means silently missing
        # an aligned minute. This keeps every wall-clock minute visited once.
        _stop.wait(60.0 - (time.time() % 60.0) + 1.0)


def start() -> None:
    """Start the scheduler thread (idempotent)."""
    global _thread, _dir_cutoff, _dir_check_last_run, _dir_check_last_slot
    global _dir_batch_task_id, _dir_batch_cutoff
    global _dir_last_changed_count, _dir_last_enqueued_count
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _dir_cutoff = time.time()
    _dir_check_last_run = 0.0
    _dir_check_last_slot = None
    _dir_batch_task_id = None
    _dir_batch_cutoff = None
    _dir_last_changed_count = None
    _dir_last_enqueued_count = None
    for key in _last_error:
        _last_error[key] = None
    _thread = threading.Thread(target=_loop, name="scan-scheduler", daemon=True)
    _thread.start()


def stop() -> None:
    """Signal the scheduler to stop and wait briefly for it to finish."""
    _stop.set()
    if _thread:
        _thread.join(timeout=5)
