"""Cheap pre-check: which directories changed since the last successful scan.

Stats every directory (not file) under ``root`` and returns those whose own
mtime is at or after ``cutoff`` -- i.e. that had an entry added, removed, or
renamed since then. A flagged directory's subtree is not stat-ed further:
scanning that directory through the existing scoped ``run_inventory_scan``
already recurses through everything beneath it, so a flagged ancestor makes
stat-ing its descendants redundant.

A directory's mtime is untouched by content changes to an existing file under
an unchanged name (e.g. an in-place re-encode) -- that case stays invisible to
this check. The periodic full scan remains the safety net for it.
"""
import os
from pathlib import Path


def _reraise(exc: OSError) -> None:
    raise exc


def find_changed_dirs(root: Path, cutoff: float) -> list[Path]:
    """A directory that fails to list its own children raises instead of
    being silently treated as "no changes" -- otherwise an unmounted or
    suddenly unreadable ``root`` would report zero changed directories, the
    caller would advance its cutoff anyway, and everything under it would go
    unnoticed until the next full scan. A single directory vanishing between
    being listed by its parent and being stat-ed here (a normal race in an
    actively-changing library) is not the same thing and is skipped instead
    -- the removal is still visible via its parent's mtime.
    """
    changed: list[Path] = []
    for dirpath, dirnames, _filenames in os.walk(root, onerror=_reraise):
        try:
            mtime = os.stat(dirpath).st_mtime
        except OSError:
            continue
        if mtime >= cutoff:
            changed.append(Path(dirpath))
            dirnames[:] = []  # subtree covered by scanning dirpath itself
    return changed
