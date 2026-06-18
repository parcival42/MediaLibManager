"""Background enrichment worker.

A single daemon thread keeps the media DB "warm": it repeatedly picks the
cheapest outstanding work across the whole library and advances those files by
one enrichment stage. Stages, in cost order:

    0 -> 1  metadata   (ffprobe / image header, exiftool Title-Comment flag)
    1 -> 2  pHash       (image pHash + thumbnail, video frame pHashes)
    2 -> 3  MD5         (full-file read, done last)

Ordering by ``enrich_stage ASC`` makes stage 0 finish for the whole library
before stage 1 begins, so features that only need metadata (rename) become
usable long before the expensive MD5 pass completes.

The work state lives entirely in the ``files`` rows, so the worker resumes
naturally after a restart. It pauses whenever a task is running (see
``tasks.runner``) to avoid touching files an action is modifying.
"""
import os
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor

from .. import config, db, paths
from ..tasks import runner
from . import images, tools, videos

# How many files to pull and process per cycle. A few multiples of the worker
# count keeps every thread busy without holding a huge selection in memory.
def _batch_size(worker_count: int) -> int:
    return max(8, worker_count * 4)


IDLE_SLEEP = 3.0   # seconds to wait when there is nothing pending
PAUSE_SLEEP = 1.0  # seconds to wait while a task is running
ERROR_MAX = 500    # truncate stored error messages

_thread: threading.Thread | None = None
_stop = threading.Event()
_current_file: str | None = None

# Per-stage completion samples for the phase ETA, each entry (finished_at, size).
# Stages 0/1 estimate remaining time by file count, stage 2 (MD5) by bytes —
# MD5 cost scales with file size, not file count. Kept per stage so a phase
# transition does not poison the rate with the previous phase's (very different)
# pace. Guarded by a lock because several worker threads append concurrently and
# status() iterates to sum bytes.
SAMPLES_MAX = 100
MIN_SAMPLES = 8
_stage_samples: list[deque] = [deque(maxlen=SAMPLES_MAX) for _ in range(3)]
_samples_lock = threading.Lock()


def _phase_rate(stage: int) -> float | None:
    """Recent throughput for one stage: files/sec for stages 0-1, bytes/sec for
    stage 2 (MD5). ``None`` until enough samples accrue or no time has elapsed."""
    with _samples_lock:
        samples = list(_stage_samples[stage])
    if len(samples) < MIN_SAMPLES:
        return None
    window = samples[-1][0] - samples[0][0]
    if window <= 0:
        return None
    if stage == 2:
        # Bytes finished within the window (all but the sample marking its start).
        done_bytes = sum(sz for _, sz in samples[1:])
        return done_bytes / window if done_bytes > 0 else None
    return (len(samples) - 1) / window


def _do_stage(row) -> tuple[int, dict]:
    """Compute the columns produced by advancing ``row`` exactly one stage."""
    stage = row["enrich_stage"]
    ftype = row["type"]
    path = row["path"]

    if stage == 0:  # metadata
        if ftype == "image":
            return 1, images.image_meta(path)
        if ftype in ("video", "audio"):
            return 1, videos.video_meta(path, ftype)
        return 1, {}
    if stage == 1:  # pHash + thumbnail
        if ftype == "image":
            return 2, images.image_phash_thumb(path)
        if ftype == "video":
            return 2, videos.video_frames_thumb(path, row["duration"])
        return 2, {}
    # stage 2 -> 3: MD5 for every type
    return 3, {"md5": tools.md5sum(path)}


def _process_one(row) -> None:
    """Advance a single file by one stage and persist the outcome."""
    global _current_file
    _current_file = os.path.relpath(row["path"], str(paths.media_root()))
    src_stage = row["enrich_stage"]
    succeeded = False
    try:
        new_stage, cols = _do_stage(row)
        cols["enrich_stage"] = new_stage
        cols["error"] = None
        if new_stage >= 3:
            cols["enrich_status"] = "done"
            cols["enriched_at"] = time.time()
        succeeded = True
    except Exception as exc:  # noqa: BLE001 - recorded on the row, worker continues
        cols = {"enrich_status": "error", "error": str(exc)[:ERROR_MAX],
                "enriched_at": time.time()}

    assignments = ", ".join(f"{k} = ?" for k in cols)
    con = db.connect()
    con.execute(f"UPDATE files SET {assignments} WHERE id = ?",
                (*cols.values(), row["id"]))
    con.commit()
    con.close()
    # Record the finished step against the stage it completed, for the phase ETA.
    # Errors are terminal and don't reflect steady-state throughput, so skip them.
    if succeeded and src_stage < 3:
        with _samples_lock:
            _stage_samples[src_stage].append((time.time(), row["size"] or 0))


def _claim_batch(limit: int) -> list:
    con = db.connect()
    rows = con.execute(
        "SELECT id, path, type, enrich_stage, duration, size FROM files "
        "WHERE present = 1 AND enrich_status = 'pending' "
        "ORDER BY enrich_stage ASC, path ASC LIMIT ?",
        (limit,),
    ).fetchall()
    con.close()
    return rows


def _loop() -> None:
    global _current_file
    while not _stop.is_set():
        # Yield to any running task (scan / action) to avoid file conflicts.
        if runner.any_task_active():
            _current_file = None
            _stop.wait(PAUSE_SLEEP)
            continue

        worker_count = max(1, int(config.get("worker_count")))
        batch = _claim_batch(_batch_size(worker_count))
        if not batch:
            _current_file = None
            _stop.wait(IDLE_SLEEP)
            continue

        if worker_count == 1:
            for row in batch:
                if _stop.is_set():
                    return
                _process_one(row)
        else:
            with ThreadPoolExecutor(max_workers=worker_count) as pool:
                pool.map(_process_one, batch)


def start() -> None:
    """Start the worker thread (idempotent)."""
    global _thread
    if _thread and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_loop, name="enrich-worker", daemon=True)
    _thread.start()


def stop() -> None:
    """Signal the worker to stop and wait briefly for it to finish."""
    _stop.set()
    if _thread:
        _thread.join(timeout=5)


def status() -> dict:
    """Aggregate enrichment progress across all present files."""
    con = db.connect()
    row = con.execute(
        "SELECT COUNT(*) AS total, "
        "SUM(CASE WHEN enrich_status = 'done' THEN 1 ELSE 0 END) AS done, "
        "SUM(CASE WHEN enrich_status = 'error' THEN 1 ELSE 0 END) AS error, "
        "SUM(CASE WHEN enrich_status = 'pending' THEN 1 ELSE 0 END) AS pending, "
        "SUM(CASE WHEN enrich_status = 'error' THEN 3 ELSE enrich_stage END) AS stage_sum, "
        "SUM(CASE WHEN enrich_status = 'pending' AND enrich_stage = 0 THEN 1 ELSE 0 END) AS ps0, "
        "SUM(CASE WHEN enrich_status = 'pending' AND enrich_stage = 1 THEN 1 ELSE 0 END) AS ps1, "
        "SUM(CASE WHEN enrich_status = 'pending' AND enrich_stage = 2 THEN 1 ELSE 0 END) AS ps2, "
        "SUM(CASE WHEN enrich_status = 'pending' AND enrich_stage = 2 THEN size ELSE 0 END) AS pbytes2 "
        "FROM files WHERE present = 1"
    ).fetchone()
    con.close()

    total = row["total"] or 0
    stage_sum = row["stage_sum"] or 0
    # Each file needs three stages; weight by stage for a smooth progress bar.
    # Errored files are terminal (the worker won't retry them on its own), so
    # they count as fully weighted — otherwise the bar would stall below 100%
    # forever whenever any file fails.
    percent = round(100 * stage_sum / (total * 3), 1) if total else 100.0
    pending = row["pending"] or 0
    paused = runner.any_task_active()

    # Current phase (lowest stage still pending) and remaining files in it.
    frontier_stage: int | None = None
    pending_in_phase = 0
    phase_done = 0
    phase_total = 0
    for s in range(3):
        count = row[f"ps{s}"] or 0
        if count > 0:
            frontier_stage = s
            pending_in_phase = count
            beyond = sum(row[f"ps{ss}"] or 0 for ss in range(s + 1, 3))
            phase_done = beyond + (row["done"] or 0)
            phase_total = phase_done + pending_in_phase
            break

    # Per-phase ETA from that phase's own recent throughput. Stage 2 (MD5) is
    # estimated over remaining bytes; stages 0/1 over remaining file count.
    eta_seconds: float | None = None
    if not paused and frontier_stage is not None:
        rate = _phase_rate(frontier_stage)
        if rate:
            if frontier_stage == 2:
                eta_seconds = round((row["pbytes2"] or 0) / rate)
            else:
                eta_seconds = round(pending_in_phase / rate)

    return {
        "total": total,
        "done": row["done"] or 0,
        "error": row["error"] or 0,
        "pending": pending,
        # Work is three stages per file; the bar (and these counters) are
        # weighted by stage so they advance from the first phase, unlike the
        # file-level `pending` which only drops in the final (MD5) phase.
        "steps_total": total * 3,
        "steps_done": stage_sum,
        "steps_pending": total * 3 - stage_sum,
        "percent": percent,
        "paused": paused,
        "active": pending > 0,
        "current_file": None if paused else _current_file,
        "frontier_stage": frontier_stage,
        "phase_done": phase_done if frontier_stage is not None else None,
        "phase_total": phase_total if frontier_stage is not None else None,
        "eta_seconds": eta_seconds,
    }
