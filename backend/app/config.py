"""Access to the configuration stored in the database.

Values are kept as JSON in the `settings` table. DEFAULTS apply until a value
has been set explicitly.
"""
import json

from . import db

DEFAULTS = {
    "media_root":            "/media",
    "scan_schedule_enabled": False,
    "scan_schedule_time":    "03:00",        # HH:MM, server-local time
    "scan_schedule_days":    [0, 1, 2, 3, 4, 5, 6],  # Mon=0..Sun=6; all 7 = daily
    # --- Duplicate detection (comparison-time only; changing these just needs a
    #     fresh duplicate scan, never re-enrichment) ---
    "phash_threshold":       8,      # Hamming distance for image pHash
    "video_frame_threshold": 10,     # Hamming distance per sampled video frame
    "video_min_matches":     4,      # required matches out of 5 frames
    "duration_tolerance":    3.0,    # seconds, duration pre-filter for 5-frame compare
    "deep_enabled":          True,   # run the deep (edge-block) video pass at all
    "deep_threshold":        10,     # Hamming distance per deep-compare edge frame
    "deep_min_fraction":     0.3,    # fraction of a block's frames that must match
    "worker_count":          4,      # parallel threads during enrichment
}


def get(key: str, default=None):
    con = db.connect()
    row = con.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    con.close()
    if row is None:
        return DEFAULTS.get(key, default)
    return json.loads(row["value"])


def get_all() -> dict:
    con = db.connect()
    rows = con.execute("SELECT key, value FROM settings").fetchall()
    con.close()
    result = dict(DEFAULTS)
    for r in rows:
        result[r["key"]] = json.loads(r["value"])
    return result


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


def set(key: str, value) -> None:
    set_many({key: value})
