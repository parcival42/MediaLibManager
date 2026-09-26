"""Access to the configuration stored in the database.

Values are kept as JSON in the `settings` table. DEFAULTS apply until a value
has been set explicitly.

Reads are cached in memory: every ``get``/``get_all`` used to open its own
SQLite connection (plus the PRAGMA setup in ``db.connect()``) just to read
one value, which added up once several background loops (scan scheduler,
dir-watch, auto-strip) started polling config every tick. ``set``/``set_many``
are the only way settings change in this app, and they update the cache
directly, so it never goes stale for in-process reads -- there is no TTL
because nothing outside this module writes to the `settings` table. This
relies on the app running as a single process (see the Dockerfile's plain
``uvicorn`` entrypoint, no ``--workers``); a multi-process deployment would
need a shared invalidation signal instead.
"""
import json
import threading

from . import db

DEFAULTS = {
    "media_root":            "/media",
    "scan_schedule_enabled": False,
    "scan_schedule_time":    "03:00",        # HH:MM, server-local time
    "scan_schedule_days":    [0, 1, 2, 3, 4, 5, 6],  # Mon=0..Sun=6; all 7 = daily
    "scan_schedule_cleanup_enabled": False,  # also run the stale-row cleanup after the scheduled scan
    # --- Directory-mtime fast path (cheap pre-check between full scans) ---
    "dir_watch_enabled":          False,
    "dir_watch_interval_minutes": 5,
    # --- Automatic Title/Comment metadata stripping ---
    "metadata_auto_strip_enabled": False,
    # --- Task history ---
    "task_history_retention_days": 30,  # finished task rows older than this get pruned
    # --- Enrichment ---
    "enrich_settle_seconds": 120,  # skip a freshly-changed file until its recorded mtime is this old
    # --- Duplicate detection (comparison-time only; changing these just needs a
    #     fresh duplicate scan, never re-enrichment) ---
    "phash_threshold":       8,      # Hamming distance for image pHash
    "video_frame_threshold": 10,     # Hamming distance per sampled video frame
    "video_min_matches":     4,      # required matches out of 5 frames
    "duration_tolerance":    3.0,    # seconds, duration pre-filter for 5-frame compare
    "deep_enabled":          True,   # run the deep (edge-block) video pass at all
    "deep_threshold":        10,     # Hamming distance per deep-compare edge frame
    "deep_min_fraction":     0.3,    # fraction of a block's frames that must match
    "color_threshold":       0.05,   # mean saturation at/below this = greyscale (B/W); colour and B/W versions never group
    "worker_count":          4,      # parallel threads during enrichment
}

_cache: dict | None = None
_cache_lock = threading.Lock()


def _load() -> dict:
    con = db.connect()
    rows = con.execute("SELECT key, value FROM settings").fetchall()
    con.close()
    result = dict(DEFAULTS)
    for r in rows:
        result[r["key"]] = json.loads(r["value"])
    return result


def _ensure_cache() -> dict:
    global _cache
    with _cache_lock:
        if _cache is None:
            _cache = _load()
        return _cache


def get(key: str, default=None):
    return _ensure_cache().get(key, default)


def get_all() -> dict:
    return dict(_ensure_cache())


def set_many(values: dict) -> None:
    con = db.connect()
    for k, v in values.items():
        con.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            (k, json.dumps(v)),
        )
    con.commit()
    con.close()

    global _cache
    with _cache_lock:
        if _cache is None:
            _cache = _load()
        else:
            _cache.update(values)


def set(key: str, value) -> None:
    set_many({key: value})
