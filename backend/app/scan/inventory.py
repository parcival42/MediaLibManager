"""Stage 1: fast inventory scan.

Walks the filesystem and records each file's existence (path, type, size, mtime,
device+inode) without opening any file. Reconciles the result against the
database:

- unchanged file (same size + mtime)        -> keep enrichment
- changed file (size/mtime differ)           -> reset enrichment to 'pending'
- new path matching a missing inode+size+mtime -> rename: move path, keep enrichment
- otherwise new path                          -> insert as 'pending'
- path gone and not matched as a rename       -> mark present = 0

The expensive per-file work (hashes, metadata, thumbnails) happens later in the
background enrichment worker.
"""
import os
import time
from pathlib import Path

from .. import db

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".tiff", ".tif", ".heic", ".heif"}
VIDEO_EXT = {".mp4", ".mkv", ".avi", ".mov", ".m4v", ".webm", ".wmv", ".flv"}
AUDIO_EXT = {".mp3", ".aac", ".flac", ".wav", ".ogg", ".m4a", ".opus", ".wma"}


def classify(name: str) -> str:
    ext = os.path.splitext(name)[1].lower()
    if ext in VIDEO_EXT:
        return "video"
    if ext in IMAGE_EXT:
        return "image"
    if ext in AUDIO_EXT:
        return "audio"
    return "other"


def run_inventory_scan(scope: Path, ctx=None) -> dict:
    """Scan ``scope`` recursively and reconcile it against the database.

    ``ctx`` is an optional task context exposing ``log`` and ``progress``.
    """
    def log(msg: str) -> None:
        if ctx:
            ctx.log(msg)

    def progress(pct: float) -> None:
        if ctx:
            ctx.progress(pct)

    def check_cancelled() -> None:
        if ctx:
            ctx.raise_if_cancelled()

    scope = scope.resolve()
    scope_str = str(scope)
    log(f"Scanning {scope_str}")

    # Phase 1: walk the filesystem.
    current: dict[str, os.stat_result] = {}
    for dirpath, _dirnames, filenames in os.walk(scope):
        check_cancelled()
        for fn in filenames:
            p = os.path.join(dirpath, fn)
            try:
                current[p] = os.stat(p)
            except OSError:
                continue
        if len(current) % 2000 == 0 and current:
            log(f"Discovered {len(current)} files…")
    progress(40)
    log(f"Found {len(current)} files on disk.")

    # Last chance to bail before any DB writes; the reconciliation below commits
    # as a single transaction and should not be interrupted midway.
    check_cancelled()

    con = db.connect()
    # Existing rows within scope (the scope dir itself or anything beneath it).
    like = scope_str.rstrip(os.sep) + os.sep + "%"
    rows = con.execute(
        "SELECT id, path, size, mtime, st_dev, st_ino FROM files WHERE path = ? OR path LIKE ?",
        (scope_str, like),
    ).fetchall()
    by_path = {r["path"]: r for r in rows}

    fs_paths = set(current)
    db_paths = set(by_path)
    now = time.time()
    added = fs_paths - db_paths
    missing = db_paths - fs_paths

    n_new = n_changed = n_renamed = n_removed = n_unchanged = 0

    # Files present in both: detect changes.
    for p in fs_paths & db_paths:
        r = by_path[p]
        st = current[p]
        if r["size"] == st.st_size and r["mtime"] == st.st_mtime:
            con.execute("UPDATE files SET present = 1, last_seen = ? WHERE id = ?", (now, r["id"]))
            n_unchanged += 1
        else:
            con.execute(
                "UPDATE files SET type = ?, size = ?, mtime = ?, st_dev = ?, st_ino = ?, "
                "present = 1, enrich_stage = 0, enrich_status = 'pending', "
                "md5 = NULL, phash = NULL, frame_hashes = NULL, frames_b64 = NULL, "
                "edge_hashes = NULL, error = NULL, last_seen = ? "
                "WHERE id = ?",
                (classify(os.path.basename(p)), st.st_size, st.st_mtime,
                 st.st_dev, st.st_ino, now, r["id"]),
            )
            n_changed += 1

    # Rename detection: match new paths to missing rows by inode + size + mtime.
    missing_by_key: dict[tuple, list] = {}
    for p in missing:
        r = by_path[p]
        missing_by_key.setdefault((r["st_dev"], r["st_ino"], r["size"], r["mtime"]), []).append(r)

    for p in added:
        st = current[p]
        key = (st.st_dev, st.st_ino, st.st_size, st.st_mtime)
        bucket = missing_by_key.get(key)
        if bucket:
            r = bucket.pop()
            missing.discard(r["path"])
            con.execute(
                "UPDATE files SET path = ?, present = 1, last_seen = ? WHERE id = ?",
                (p, now, r["id"]),
            )
            n_renamed += 1
        else:
            con.execute(
                "INSERT INTO files(path, type, size, mtime, st_dev, st_ino, present, "
                "enrich_stage, enrich_status, first_seen, last_seen) "
                "VALUES(?, ?, ?, ?, ?, ?, 1, 0, 'pending', ?, ?)",
                (p, classify(os.path.basename(p)), st.st_size, st.st_mtime,
                 st.st_dev, st.st_ino, now, now),
            )
            n_new += 1

    # Whatever is still missing has truly disappeared. `last_seen` is
    # deliberately left untouched here -- it means "last confirmed present",
    # not "last scan"; re-stamping it to `now` would make every re-scan show
    # today's date for a file that has been gone for months.
    for p in missing:
        con.execute("UPDATE files SET present = 0 WHERE id = ?", (by_path[p]["id"],))
        n_removed += 1

    con.commit()
    con.close()
    progress(100)

    summary = {
        "found": len(current),
        "new": n_new,
        "changed": n_changed,
        "renamed": n_renamed,
        "removed": n_removed,
        "unchanged": n_unchanged,
    }
    log(f"Done: {summary}")
    return summary
