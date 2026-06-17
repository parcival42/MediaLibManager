"""Helpers around the configured media root, with path-safety checks."""
from pathlib import Path

from . import config


def media_root() -> Path:
    return Path(config.get("media_root")).resolve()


def resolve_within_root(p: str | None) -> Path:
    """Resolve ``p`` and ensure it lies within the media root.

    Returns the media root itself when ``p`` is empty. Raises ValueError if the
    resolved path escapes the root (guards against traversal).
    """
    root = media_root()
    if not p:
        return root
    candidate = Path(p).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError("path outside media root")
    return candidate
