"""Scan exclusion patterns (``scan_exclude_patterns``).

Each pattern is an ``fnmatch`` glob matched case-sensitively against a single
file or directory *name* -- never a full path -- so ``.*`` hides dotfiles and
dot-directories at any depth, ``@eaDir`` skips every NAS thumbnail directory,
and ``*_original`` skips exiftool backups. A matching directory excludes its
whole subtree.

Excluded files never enter the inventory. Rows that already exist for a path
that becomes excluded are marked missing by the next scan of their scope and
removed by the maintenance cleanup.
"""
from fnmatch import fnmatchcase
from pathlib import PurePosixPath

from .. import config, paths


def patterns() -> list[str]:
    return [p for p in (config.get("scan_exclude_patterns") or []) if p]


def is_excluded(name: str, pats: list[str]) -> bool:
    return any(fnmatchcase(name, p) for p in pats)


def path_excluded(path: str, pats: list[str], root: str | None = None) -> bool:
    """Whether any component of ``path`` below the media root is excluded.
    Components of the root itself are not checked (the root may well sit
    under a dot-directory)."""
    if not pats:
        return False
    root_path = PurePosixPath(root or str(paths.media_root()))
    p = PurePosixPath(path)
    try:
        parts = p.relative_to(root_path).parts
    except ValueError:
        return False
    return any(is_excluded(part, pats) for part in parts)
