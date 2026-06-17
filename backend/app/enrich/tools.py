"""Thin wrappers around the external media tools and hashing.

Each helper raises ``ToolError`` with a readable message when a tool is missing
or fails, so the worker can record it on the file row and move on. The tools
(``ffprobe``/``ffmpeg``/``exiftool``) ship in the Docker runtime image.
"""
import hashlib
import json
import os
import subprocess
from io import BytesIO

import imagehash
from PIL import Image

# Per-call timeout for the external tools (seconds). Frame extraction on a large
# file with a slow seek is the worst case, so this is generous.
PROBE_TIMEOUT = 60
FRAME_TIMEOUT = 120
BLOCK_TIMEOUT = 180  # decoding a multi-second edge block costs more than a seek

# Frame sample positions (fraction of duration) for video pHashes, matching the
# scheme reused by the dedup and metadata-integrity logic. Fixed on purpose:
# changing the count or positions would invalidate the whole library's stored
# frame hashes and force a full re-enrichment.
FRAME_POSITIONS = (0.1, 0.3, 0.5, 0.7, 0.9)

# Deep ("intensive") compare: pHash one frame per second from the first and last
# DEEP_BLOCK_SECONDS of a video. Catches re-encoded / trimmed copies whose fixed
# sample positions no longer line up. Also a fixed constant for the same reason.
DEEP_BLOCK_SECONDS = 30

_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


class ToolError(RuntimeError):
    """An external tool was unavailable or returned an error."""


def _run(cmd: list[str], timeout: int, binary: bool = False) -> bytes | str:
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            timeout=timeout,
            check=False,
        )
    except FileNotFoundError:
        raise ToolError(f"{cmd[0]} not found")
    except subprocess.TimeoutExpired:
        raise ToolError(f"{cmd[0]} timed out")
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip().splitlines()
        raise ToolError(f"{cmd[0]} failed: {err[-1] if err else proc.returncode}")
    return proc.stdout if binary else proc.stdout.decode("utf-8", "replace")


def ffprobe(path: str) -> dict:
    """Return the parsed ``-show_format -show_streams`` JSON for a media file."""
    out = _run(
        ["ffprobe", "-v", "quiet", "-print_format", "json",
         "-show_format", "-show_streams", path],
        PROBE_TIMEOUT,
    )
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        raise ToolError("ffprobe returned no parseable output")


def extract_frame(path: str, timestamp: float) -> Image.Image:
    """Decode a single frame at ``timestamp`` seconds into a PIL image.

    Seeking before ``-i`` keeps this fast even on long files.
    """
    raw = _run(
        ["ffmpeg", "-v", "quiet", "-ss", f"{timestamp:.3f}", "-i", path,
         "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"],
        FRAME_TIMEOUT,
        binary=True,
    )
    if not raw:
        raise ToolError("ffmpeg produced no frame")
    return Image.open(BytesIO(raw)).convert("RGB")


def _split_png_stream(data: bytes) -> list[bytes]:
    """Split the concatenated PNG stream from ``image2pipe`` into single PNGs."""
    frames: list[bytes] = []
    pos = 0
    while True:
        idx = data.find(_PNG_MAGIC, pos)
        if idx == -1:
            break
        nxt = data.find(_PNG_MAGIC, idx + len(_PNG_MAGIC))
        frames.append(data[idx:nxt] if nxt != -1 else data[idx:])
        if nxt == -1:
            break
        pos = nxt
    return frames


def extract_block_phashes(path: str, start: float, seconds: int) -> list[str]:
    """pHash one frame per second from ``seconds`` of video starting at ``start``.

    Frames are scaled tiny up front (pHash reduces to 32x32 internally anyway),
    which keeps the piped stream and per-frame decode cheap. Tolerant: returns
    whatever it managed to hash, ``[]`` on failure — the deep block is secondary
    to the main frame hashes.
    """
    try:
        raw = _run(
            ["ffmpeg", "-v", "quiet", "-ss", f"{max(0.0, start):.3f}", "-i", path,
             "-t", str(seconds), "-vf", "fps=1,scale=64:64",
             "-f", "image2pipe", "-vcodec", "png", "-"],
            BLOCK_TIMEOUT,
            binary=True,
        )
    except ToolError:
        return []
    hashes: list[str] = []
    for chunk in _split_png_stream(raw):
        try:
            with Image.open(BytesIO(chunk)) as im:
                hashes.append(str(imagehash.phash(im)))
        except Exception:  # noqa: BLE001 - skip an unreadable frame, keep the rest
            continue
    return hashes


def has_title_or_comment(path: str) -> bool:
    """True if the file carries a non-empty Title or Comment tag (exiftool)."""
    out = _run(["exiftool", "-s3", "-Title", "-Comment", path], PROBE_TIMEOUT)
    return bool(out.strip())


def strip_title_comment(path: str) -> str:
    """Remove the Title/Comment tags via exiftool, in place.

    Deliberately omits ``-overwrite_original``: exiftool then leaves its own
    backup copy at ``<path>_original`` (same directory, same filesystem)
    before modifying ``path``, so the caller can verify integrity and decide
    whether to discard or restore from it. Returns the backup path.
    """
    backup = f"{path}_original"
    if os.path.exists(backup):
        os.remove(backup)  # stale leftover from a crashed earlier run
    _run(
        ["exiftool", "-P", "-m", "-api", "LargeFileSupport=1", "-Title=", "-Comment=", path],
        PROBE_TIMEOUT,
    )
    return backup


def md5sum(path: str, chunk: int = 1024 * 1024) -> str:
    h = hashlib.md5()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(chunk), b""):
            h.update(block)
    return h.hexdigest()
