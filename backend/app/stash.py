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

Failures never propagate: Stash being down must not turn an otherwise
successful rename/strip into an error. They are only logged.
"""
import json
import logging
import os
import threading
import urllib.error
import urllib.request

from . import config

log = logging.getLogger(__name__)

TIMEOUT = 10  # seconds per request
# Above this many distinct directories a single scan of the whole library is
# cheaper for both sides than a huge path list.
MAX_SCAN_PATHS = 100


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


def to_stash_path(path: str) -> str:
    """Map a local path below ``media_root`` onto Stash's view of the library."""
    stash_root = (config.get("stash_media_path") or "").rstrip("/")
    if not stash_root:
        return path
    local_root = str(config.get("media_root") or "").rstrip("/")
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


def scan_directories(directories: set[str]) -> str:
    """Start a Stash scan of ``directories`` (local paths). Returns the job id."""
    dirs = _collapse(directories)
    if len(dirs) > MAX_SCAN_PATHS:
        dirs = [str(config.get("media_root"))]
    paths = [to_stash_path(d) for d in dirs]
    data = _graphql(
        config.get("stash_url") or "",
        config.get("stash_api_key") or "",
        "mutation($input: ScanMetadataInput!) { metadataScan(input: $input) }",
        {"input": {"paths": paths}},
    )
    return str(data.get("metadataScan"))


# --- Buffered scan requests -------------------------------------------------
#
# Changed directories are collected and sent as one scan request
# ``stash_scan_delay_minutes`` after the *first* change of a batch, so a series
# of renames doesn't fire a Stash scan every minute or two. The timer is not
# restarted by later changes -- with a sliding window, continuous editing
# would postpone the scan indefinitely. Pending directories live only in
# memory; a restart before the timer fires drops them (Stash's own scheduled
# scan still catches up).

_pending: set[str] = set()
_timer: threading.Timer | None = None
_pending_lock = threading.Lock()


def _flush() -> None:
    global _timer
    with _pending_lock:
        directories = set(_pending)
        _pending.clear()
        _timer = None
    if not directories or not config.get("stash_enabled") or not config.get("stash_url"):
        return
    try:
        job_id = scan_directories(directories)
        log.info("Stash scan started for %d directories (job %s)", len(directories), job_id)
    except StashError as exc:
        log.warning("Stash scan could not be started: %s", exc)
    except Exception:  # noqa: BLE001 - background thread, nothing to propagate to
        log.exception("unexpected error triggering Stash scan")


def notify_changed(file_paths, log_fn=None) -> None:
    """Schedule a Stash rescan of the directories containing ``file_paths``.

    Returns immediately; the request goes out with the next buffered flush
    (see above). No-op when the integration is disabled or nothing changed.
    ``log_fn`` (e.g. a task's ``ctx.log``) gets a note that a scan is queued.
    """
    global _timer
    if not config.get("stash_enabled") or not config.get("stash_url"):
        return
    directories = {os.path.dirname(p) for p in file_paths if p}
    if not directories:
        return
    delay = max(0.0, float(config.get("stash_scan_delay_minutes") or 0)) * 60
    with _pending_lock:
        _pending.update(directories)
        if _timer is None:
            _timer = threading.Timer(delay, _flush)
            _timer.daemon = True
            _timer.name = "stash-scan-timer"
            _timer.start()
    if log_fn:
        try:
            log_fn(f"Stash scan queued for {len(directories)} "
                   f"director{'y' if len(directories) == 1 else 'ies'} "
                   f"(sent in at most {round(delay / 60, 1):g} min)")
        except Exception:  # noqa: BLE001
            pass
