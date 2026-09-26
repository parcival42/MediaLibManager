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


def find_changed_dirs(root: Path, cutoff: float) -> list[Path]:
    changed: list[Path] = []
    for dirpath, dirnames, _filenames in os.walk(root):
        try:
            mtime = os.stat(dirpath).st_mtime
        except OSError:
            continue
        if mtime >= cutoff:
            changed.append(Path(dirpath))
            dirnames[:] = []  # subtree covered by scanning dirpath itself
    return changed
