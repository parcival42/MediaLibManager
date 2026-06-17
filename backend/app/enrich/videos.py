"""Video/audio enrichment: ffprobe metadata, then frame pHashes + thumbnail."""
import json

import imagehash

from . import tools
from .images import make_preview_b64, make_thumbnail_b64


def _first_video_stream(streams: list[dict]) -> dict | None:
    for s in streams:
        if s.get("codec_type") == "video":
            return s
    return None


def video_meta(path: str, ftype: str) -> dict:
    """Stage 1: duration, codec, dimensions, bitrate, and Title/Comment flag.

    Audio files only yield a duration; the Title/Comment check is video-only
    (it feeds the later metadata-stripping feature).
    """
    info = tools.ffprobe(path)
    fmt = info.get("format", {})
    cols: dict = {}

    duration = fmt.get("duration")
    if duration is not None:
        cols["duration"] = float(duration)
    bit_rate = fmt.get("bit_rate")
    if bit_rate is not None:
        cols["bitrate"] = int(bit_rate)

    if ftype == "video":
        vs = _first_video_stream(info.get("streams", []))
        if vs:
            cols["codec"] = vs.get("codec_name")
            if vs.get("width"):
                cols["width"] = int(vs["width"])
            if vs.get("height"):
                cols["height"] = int(vs["height"])
        cols["has_title_comment"] = 1 if tools.has_title_or_comment(path) else 0

    return cols


def video_frames_thumb(path: str, duration: float | None) -> dict:
    """Stage 2 for video. Produces everything the dedup passes need:

    * pHashes of five frames at fixed positions (for the 5-frame compare),
    * a base64 preview of each of those five frames (the UI frame strip),
    * a mid-point thumbnail,
    * the deep-compare edge hashes (start/end blocks).
    """
    if not duration or duration <= 0:
        raise tools.ToolError("no duration available for frame sampling")

    hashes: list[str] = []
    previews: list[str] = []
    thumbnail: str | None = None
    for frac in tools.FRAME_POSITIONS:
        frame = tools.extract_frame(path, duration * frac)
        hashes.append(str(imagehash.phash(frame)))
        previews.append(make_preview_b64(frame))
        if frac == 0.5:
            thumbnail = make_thumbnail_b64(frame)

    cols: dict = {
        "frame_hashes": json.dumps(hashes),
        "frames_b64": json.dumps(previews),
        "edge_hashes": json.dumps(_edge_hashes(path, duration)),
    }
    if thumbnail:
        cols["thumbnail_b64"] = thumbnail
    return cols


def _edge_hashes(path: str, duration: float) -> dict:
    """Deep-compare hashes: one pHash per second from the first and last block."""
    n = tools.DEEP_BLOCK_SECONDS
    start = tools.extract_block_phashes(path, 0.0, n)
    end = tools.extract_block_phashes(path, max(0.0, duration - n), n)
    return {"start": start, "end": end}
