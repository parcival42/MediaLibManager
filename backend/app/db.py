"""SQLite access and schema for MediaLibManager.

A single database file under MEDIALIB_DATA (volume `/data`). The schema already
covers every planned milestone so that later areas do not require migrations.
"""
import os
import sqlite3
from pathlib import Path

DATA_DIR = Path(os.environ.get("MEDIALIB_DATA", "/data"))
DB_PATH = DATA_DIR / "medialib.db"

SCHEMA = """
-- Central inventory + enrichment (stage 1 + stage 2)
CREATE TABLE IF NOT EXISTS files (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    path              TEXT UNIQUE NOT NULL,
    type              TEXT,                       -- video / image / audio / other
    size              INTEGER,
    mtime             REAL,
    st_dev            INTEGER,                    -- rename detection
    st_ino            INTEGER,
    present           INTEGER NOT NULL DEFAULT 1, -- 0 = missing at last scan
    enrich_stage      INTEGER NOT NULL DEFAULT 0, -- 0 none / 1 meta / 2 phash / 3 md5
    enrich_status     TEXT NOT NULL DEFAULT 'pending', -- pending / done / error
    md5               TEXT,
    phash             TEXT,
    frame_hashes      TEXT,                       -- JSON array of 5 frame pHashes (video)
    frames_b64        TEXT,                       -- JSON array of 5 frame preview JPEGs (video)
    edge_hashes       TEXT,                       -- JSON {start:[],end:[]} deep-compare pHashes (video)
    width             INTEGER,
    height            INTEGER,
    duration          REAL,
    codec             TEXT,
    bitrate           INTEGER,
    has_title_comment INTEGER,
    thumbnail_b64     TEXT,
    error             TEXT,
    enriched_at       REAL,
    first_seen        REAL,
    last_seen         REAL
);
CREATE INDEX IF NOT EXISTS idx_files_status ON files(enrich_status);
CREATE INDEX IF NOT EXISTS idx_files_inode  ON files(st_dev, st_ino);
CREATE INDEX IF NOT EXISTS idx_files_md5    ON files(md5);
CREATE INDEX IF NOT EXISTS idx_files_type   ON files(type);
CREATE INDEX IF NOT EXISTS idx_files_size   ON files(size);

-- Pairs of files the user has marked as "not duplicates". Stored as normalised
-- (file_id_a < file_id_b) edges; the rebuild skips DSU unions for these pairs.
-- Survives every rebuild because it is independent of duplicate_groups/members.
CREATE TABLE IF NOT EXISTS dedup_ignores (
    file_id_a INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    file_id_b INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    ignored_at REAL,
    PRIMARY KEY (file_id_a, file_id_b),
    CHECK (file_id_a < file_id_b)
);

-- Derived duplicate groups
CREATE TABLE IF NOT EXISTS duplicate_groups (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL,                     -- exact_image / exact_video / exact_other / visual / video / deep
    created_at REAL
);
CREATE TABLE IF NOT EXISTS duplicate_members (
    group_id INTEGER NOT NULL REFERENCES duplicate_groups(id) ON DELETE CASCADE,
    file_id  INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, file_id)
);

-- Generic task queue + history
CREATE TABLE IF NOT EXISTS tasks (
    id         TEXT PRIMARY KEY,
    type       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'queued',    -- queued/running/done/error/cancelled/interrupted
    params     TEXT,
    progress   REAL NOT NULL DEFAULT 0,
    log        TEXT,
    result     TEXT,
    created_at REAL,
    started_at REAL,
    ended_at   REAL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);

-- Rename rules (building blocks) + per-directory assignment
CREATE TABLE IF NOT EXISTS rename_rules (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    segments   TEXT NOT NULL,                     -- JSON
    separator  TEXT NOT NULL DEFAULT ' - ',
    created_at REAL
);
CREATE TABLE IF NOT EXISTS rule_assignments (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    directory TEXT NOT NULL,                      -- applies recursively, deepest path wins
    rule_id   INTEGER NOT NULL REFERENCES rename_rules(id) ON DELETE CASCADE
);

-- Metadata removal log
CREATE TABLE IF NOT EXISTS metadata_history (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    path           TEXT,
    modified_at    TEXT,
    duration_check TEXT,
    phash_check    TEXT,
    backup_path    TEXT,
    status         TEXT,
    errormsg       TEXT
);

-- Configuration (key/value, value stored as JSON)
CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- Auth
CREATE TABLE IF NOT EXISTS users (
    username      TEXT PRIMARY KEY,
    password_hash TEXT NOT NULL,
    salt          TEXT NOT NULL,
    created_at    REAL
);

-- Deletion history
CREATE TABLE IF NOT EXISTS delete_history (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    path       TEXT,
    filename   TEXT,
    size       INTEGER,
    deleted_at REAL
);
"""


def connect() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA foreign_keys=ON")
    # The enrichment worker writes from several threads at once; WAL plus a
    # busy timeout lets those writes serialize instead of failing immediately.
    con.execute("PRAGMA busy_timeout=5000")
    return con


# Columns added to `files` after the initial schema shipped. Applied on startup
# so existing databases pick them up without a manual migration.
_ADDED_FILE_COLUMNS = {
    "frames_b64":      "TEXT",
    "edge_hashes":     "TEXT",
    "mean_saturation": "REAL",
}


def _migrate(con: sqlite3.Connection) -> None:
    existing = {row["name"] for row in con.execute("PRAGMA table_info(files)")}
    for name, decl in _ADDED_FILE_COLUMNS.items():
        if name not in existing:
            con.execute(f"ALTER TABLE files ADD COLUMN {name} {decl}")


def init_db() -> None:
    con = connect()
    con.executescript(SCHEMA)
    _migrate(con)
    con.commit()
    con.close()
