"""Optional Stash (stashapp) integration: trigger a targeted library scan.

After an action changes files on disk (rename, metadata strip), Stash would
otherwise only notice on its own next scan. When ``stash_enabled`` is set,
``notify_changed`` asks Stash via its GraphQL API (``metadataScan``) to rescan
just the affected directories. Stash recognises a renamed file by its
fingerprint, so a rename keeps the scene's metadata instead of creating a new
entry.

Stash usually runs in its own container and sees the library under a
different mount point; ``stash_media_path`` is that path, and every local path
below ``media_root`` is rewritten onto it. Empty means "same path as here".

Scan options: a bare ``metadataScan(paths)`` leaves every generate flag
(covers, previews, sprites, phashes, ...) off, unlike a scan started from
Stash's own UI, which sends the scan defaults configured in Stash. So the
request carries those defaults too (``stash_scan_options_mode = "stash"``), or
the user's own selection layered on top of them (``"custom"``). The flag names
differ between Stash versions, so they are discovered via schema
introspection instead of being hardcoded.

Failures never propagate: Stash being down must not turn an otherwise
successful rename/strip into an error. They are logged, and the affected
directories stay buffered for a retry (see the buffer section below).
"""
import json
import logging
import math
import os
import threading
import time
import urllib.error
import urllib.request

from . import config, db, paths

log = logging.getLogger(__name__)

TIMEOUT = 10  # seconds per request
# Above this many distinct directories a single scan of the whole library is
# cheaper for both sides than a huge path list.
MAX_SCAN_PATHS = 100
# Cap on the directory list returned by ``status()``.
STATUS_MAX_DIRS = 500
# Minimum wait before retrying a failed request (also with a zero scan delay,
# which would otherwise retry in a tight loop while Stash is down).
RETRY_MIN_SECONDS = 60
# After a restart, a batch that was already due is sent this long after
# startup instead of immediately (Stash may be starting alongside this app).
STARTUP_GRACE_SECONDS = 30


class StashError(Exception):
    pass


def _graphql(url: str, api_key: str, query: str, variables: dict | None = None) -> dict:
    endpoint = url.rstrip("/")
    if not endpoint.endswith("/graphql"):
        endpoint += "/graphql"
    body = json.dumps({"query": query, "variables": variables or {}}).encode()
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if api_key:
        headers["ApiKey"] = api_key
    req = urllib.request.Request(endpoint, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            payload = json.loads(resp.read().decode() or "{}")
    except urllib.error.HTTPError as exc:
        raise StashError(f"HTTP {exc.code} from Stash") from exc
    except (urllib.error.URLError, OSError, ValueError) as exc:
        raise StashError(f"Stash not reachable: {exc}") from exc
    if payload.get("errors"):
        raise StashError("; ".join(e.get("message", "?") for e in payload["errors"]))
    return payload.get("data") or {}


def test_connection(url: str, api_key: str) -> str:
    """Return the Stash version string, or raise ``StashError``."""
    if not url:
        raise StashError("no Stash URL configured")
    data = _graphql(url, api_key, "query { version { version } }")
    return (data.get("version") or {}).get("version") or "unknown"


# --- Scan options -----------------------------------------------------------

_SCHEMA_QUERY = """
query {
  input: __type(name: "ScanMetadataInput") {
    inputFields { name type { kind name ofType { kind name } } }
  }
  options: __type(name: "ScanMetadataOptions") { fields { name } }
}
"""


def _is_boolean(type_ref: dict | None) -> bool:
    if not type_ref:
        return False
    if type_ref.get("kind") == "NON_NULL":
        type_ref = type_ref.get("ofType") or {}
    return type_ref.get("kind") == "SCALAR" and type_ref.get("name") == "Boolean"


def scan_options_info(url: str, api_key: str) -> dict:
    """Boolean scan flags this Stash accepts, and its configured defaults.

    Returns ``{"flags": [...], "stash_defaults": {flag: bool}}``. ``flags`` are
    the Boolean fields of ``ScanMetadataInput`` (what a request may carry);
    the defaults come from ``configuration.defaults.scan`` for the flags that
    type also has. A Stash whose scan defaults were never saved reports
    ``null`` there, which maps to all-false -- the same as its scan dialog.
    """
    if not url:
        raise StashError("no Stash URL configured")
    schema = _graphql(url, api_key, _SCHEMA_QUERY)
    input_fields = ((schema.get("input") or {}).get("inputFields")) or []
    flags = sorted(f["name"] for f in input_fields if _is_boolean(f.get("type")))
    option_fields = {f["name"] for f in ((schema.get("options") or {}).get("fields") or [])}
    readable = [f for f in flags if f in option_fields]

    defaults: dict[str, bool] = {f: False for f in flags}
    if readable:
        data = _graphql(
            url, api_key,
            "query { configuration { defaults { scan { %s } } } }" % " ".join(readable),
        )
        scan = (((data.get("configuration") or {}).get("defaults") or {}).get("scan")) or {}
        for f in readable:
            defaults[f] = bool(scan.get(f))
    return {"flags": flags, "stash_defaults": defaults}


def _resolve_scan_options(url: str, api_key: str) -> dict[str, bool]:
    """The generate flags to send with a scan, per ``stash_scan_options_mode``."""
    info = scan_options_info(url, api_key)
    options = dict(info["stash_defaults"])
    if config.get("stash_scan_options_mode") == "custom":
        custom = config.get("stash_scan_options") or {}
        for flag in info["flags"]:
            if flag in custom:
                options[flag] = bool(custom[flag])
        unknown = sorted(set(custom) - set(info["flags"]))
        if unknown:
            log.info("ignoring scan options this Stash does not know: %s", ", ".join(unknown))
    return options


def to_stash_path(path: str) -> str:
    """Map a local path below ``media_root`` onto Stash's view of the library."""
    stash_root = (config.get("stash_media_path") or "").rstrip("/")
    if not stash_root:
        return path
    # The resolved root, same as the paths stored in the DB (a symlinked or
    # relative media_root setting would otherwise never match them).
    local_root = str(paths.media_root()).rstrip("/")
    if path == local_root:
        return stash_root
    if local_root and path.startswith(local_root + "/"):
        return stash_root + path[len(local_root):]
    return path


def _collapse(directories: set[str]) -> list[str]:
    """Drop directories already covered by a scanned ancestor."""
    out: list[str] = []
    for d in sorted(directories):
        if not any(d == p or d.startswith(p.rstrip("/") + "/") for p in out):
            out.append(d)
    return out


def scan_directories(directories: set[str]) -> tuple[str, dict[str, bool]]:
    """Start a Stash scan of ``directories`` (local paths).

    Returns the job id and the generate flags that were sent.
    """
    url = config.get("stash_url") or ""
    api_key = config.get("stash_api_key") or ""
    dirs = _collapse(directories)
    if len(dirs) > MAX_SCAN_PATHS:
        dirs = [str(paths.media_root())]
    scan_paths = [to_stash_path(d) for d in dirs]
    # Options are best-effort: a Stash version without introspection or the
    # configuration defaults must still get the plain scan (and an unreachable
    # Stash fails at the mutation below anyway, which triggers the retry).
    try:
        options = _resolve_scan_options(url, api_key)
    except StashError as exc:
        log.warning("could not determine Stash scan options, scanning without: %s", exc)
        options = {}
    data = _graphql(
        url, api_key,
        "mutation($input: ScanMetadataInput!) { metadataScan(input: $input) }",
        {"input": {**options, "paths": scan_paths}},
    )
    return str(data.get("metadataScan")), options


# --- Buffered scan requests -------------------------------------------------
#
# Changed directories are collected and sent as one scan request
# ``stash_scan_delay_minutes`` after the *first* change of a batch, rounded up
# to the next full minute, so a series of renames doesn't fire a Stash scan
# every minute or two. The timer is not restarted by later changes -- with a
# sliding window, continuous editing would postpone the scan indefinitely.
#
# The buffer is mirrored into the ``stash_pending`` table: ``start()`` reloads
# it after a restart, and a directory leaves it only once Stash accepted a
# scan covering it. A failed request keeps everything and retries after the
# scan delay (at least ``RETRY_MIN_SECONDS``). A directory changed again while
# a request was in flight carries a newer ``last_changed_at`` than the one
# sent, so it stays buffered for the next round.

_pending: dict[str, float] = {}  # directory -> last_changed_at
_timer: threading.Timer | None = None
_pending_lock = threading.Lock()
# Serializes whole flushes (timer firing vs. "send now"), so the same batch
# is never sent twice concurrently. Never taken while holding _pending_lock.
_flush_lock = threading.Lock()
# Bookkeeping for ``status()``, all guarded by ``_pending_lock``.
_queued_at: float | None = None  # first change of the current batch
_due_at: float | None = None     # when the timer fires
_last: dict | None = None        # outcome of the most recent flush


def _due_time(now: float, delay: float) -> float:
    """``now + delay``, rounded up to the next full minute (no delay: ``now``)."""
    if delay <= 0:
        return now
    return math.ceil((now + delay) / 60) * 60


def _delay_seconds() -> float:
    return max(0.0, float(config.get("stash_scan_delay_minutes") or 0)) * 60


def _schedule_locked(queued_at: float, due_at: float) -> None:
    """Arm the timer for ``due_at``. Caller holds ``_pending_lock`` and has
    checked that no timer is armed."""
    global _timer, _queued_at, _due_at
    _queued_at = queued_at
    _due_at = due_at
    _timer = threading.Timer(max(0.0, due_at - time.time()), _on_timer)
    _timer.daemon = True
    _timer.name = "stash-scan-timer"
    _timer.start()


def _remove_sent_locked(snapshot: dict[str, float]) -> None:
    """Drop the directories covered by a sent request -- unless changed again
    since. Caller holds ``_pending_lock``."""
    done = [d for d, changed in snapshot.items() if _pending.get(d) == changed]
    for d in done:
        del _pending[d]
    con = db.connect()
    try:
        con.executemany(
            "DELETE FROM stash_pending WHERE directory = ? AND last_changed_at <= ?",
            [(d, snapshot[d]) for d in done],
        )
        con.commit()
    finally:
        con.close()


def _flush() -> None:
    with _flush_lock:
        _flush_serialized()


def _on_timer() -> None:
    """Timer entry point. A timer that fired while a "send now" was in
    progress may have been superseded by the time it gets the flush lock
    (e.g. replaced by a retry timer); only the currently armed one flushes."""
    with _flush_lock:
        with _pending_lock:
            current = _timer is threading.current_thread()
        if current:
            _flush_serialized()


def _flush_serialized() -> None:
    global _timer, _queued_at, _due_at, _last
    with _pending_lock:
        snapshot = dict(_pending)
        batch_queued_at = _queued_at
        if _timer is not None:
            _timer.cancel()  # no-op when running inside the timer itself
        _timer = None
        _queued_at = None
        _due_at = None
    if not snapshot:
        return

    result: dict = {"at": time.time(), "directories": len(snapshot),
                    "ok": False, "job_id": None, "error": None, "options": None}
    # Disabled meanwhile: drop the batch (nothing would ever send it, and
    # re-enabling must not fire a scan for changes made long ago).
    drop = False
    if not config.get("stash_enabled") or not config.get("stash_url"):
        result["error"] = "Stash integration disabled or no URL configured"
        drop = True
    else:
        try:
            result["job_id"], result["options"] = scan_directories(set(snapshot))
            result["ok"] = True
            log.info("Stash scan started for %d directories (job %s)",
                     len(snapshot), result["job_id"])
        except StashError as exc:
            result["error"] = str(exc)
            log.warning("Stash scan could not be started, will retry: %s", exc)
        except Exception as exc:  # noqa: BLE001 - background thread, nothing to propagate to
            result["error"] = f"unexpected error: {exc}"
            log.exception("unexpected error triggering Stash scan, will retry")

    with _pending_lock:
        if result["ok"] or drop:
            try:
                _remove_sent_locked(snapshot)
            except Exception:  # noqa: BLE001
                # The scan went out; at worst the rows are sent again later.
                log.exception("could not clear sent Stash directories")
        if _pending and _timer is None:
            now = time.time()
            if result["ok"] or drop:
                # Leftovers changed during the send: a fresh batch.
                _schedule_locked(now, _due_time(now, _delay_seconds()))
            else:
                _schedule_locked(batch_queued_at or now,
                                 _due_time(now, max(_delay_seconds(), RETRY_MIN_SECONDS)))
        if not result["ok"] and not drop:
            result["retry_at"] = _due_at
        _last = result


def flush_now() -> None:
    """Send the buffered scan request immediately instead of waiting for the timer."""
    _flush()


def start() -> None:
    """Reload the persisted buffer and re-arm its timer. Called at startup."""
    con = db.connect()
    try:
        rows = con.execute(
            "SELECT directory, first_queued_at, last_changed_at FROM stash_pending"
        ).fetchall()
    finally:
        con.close()
    if not rows:
        return
    with _pending_lock:
        for r in rows:
            _pending[r["directory"]] = r["last_changed_at"]
        if _timer is None:
            queued_at = min(r["first_queued_at"] for r in rows)
            due_at = max(_due_time(queued_at, _delay_seconds()),
                         time.time() + STARTUP_GRACE_SECONDS)
            _schedule_locked(queued_at, due_at)
    log.info("restored %d pending Stash scan directories", len(rows))


def stop() -> None:
    """Disarm the timer; the persisted buffer is picked up again by ``start``."""
    global _timer
    with _pending_lock:
        if _timer is not None:
            _timer.cancel()
            _timer = None


def status() -> dict:
    """Snapshot of the buffer for the UI: pending directories, due time, last result."""
    with _pending_lock:
        pending = sorted(_pending)
        return {
            "enabled": bool(config.get("stash_enabled") and config.get("stash_url")),
            "pending": bool(pending),
            "pending_count": len(pending),
            "directories": pending[:STATUS_MAX_DIRS],
            "queued_at": _queued_at,
            "due_at": _due_at,
            "last": dict(_last) if _last else None,
        }


def notify_changed(file_paths, log_fn=None) -> None:
    """Schedule a Stash rescan of the directories containing ``file_paths``.

    Returns immediately; the request goes out with the next buffered flush
    (see above). No-op when the integration is disabled or nothing changed.
    ``log_fn`` (e.g. a task's ``ctx.log``) gets a note that a scan is queued.
    """
    if not config.get("stash_enabled") or not config.get("stash_url"):
        return
    directories = {os.path.dirname(p) for p in file_paths if p}
    if not directories:
        return
    now = time.time()
    with _pending_lock:
        for d in directories:
            _pending[d] = now
        try:
            con = db.connect()
            try:
                con.executemany(
                    "INSERT INTO stash_pending(directory, first_queued_at, last_changed_at) "
                    "VALUES(?, ?, ?) ON CONFLICT(directory) DO UPDATE SET "
                    "last_changed_at = excluded.last_changed_at",
                    [(d, now, now) for d in directories],
                )
                con.commit()
            finally:
                con.close()
        except Exception:  # noqa: BLE001 - the in-memory buffer still sends it
            log.exception("could not persist pending Stash directories")
        if _timer is None:
            _schedule_locked(now, _due_time(now, _delay_seconds()))
        due_at = _due_at
    if log_fn:
        try:
            when = time.strftime("%H:%M", time.localtime(due_at)) if due_at else "now"
            log_fn(f"Stash scan queued for {len(directories)} "
                   f"director{'y' if len(directories) == 1 else 'ies'} "
                   f"(sent at {when})")
        except Exception:  # noqa: BLE001
            pass
