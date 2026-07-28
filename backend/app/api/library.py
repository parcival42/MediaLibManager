"""Library endpoints — paginated listing, single item, and ranged media streaming."""
import base64
import binascii
import mimetypes
import os
import sqlite3
import subprocess
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel

from .. import auth, db, paths

router = APIRouter(prefix="/api")

CHUNK = 1024 * 256
# thumbnail_b64 is deliberately excluded: the frontend fetches it via the
# dedicated /media/{id}/thumb route instead, which keeps this listing payload
# small and lets the browser cache thumbnails by URL (see media_thumbnail below).
LIST_COLUMNS = ("id, path, type, size, enrich_status, enrich_stage, "
                "width, height, duration, error, last_seen")


@router.get("/library")
def list_library(
    _: str = Depends(auth.current_user),
    offset: int = 0,
    limit: int = Query(default=100, le=500),
    type: str | None = None,
    q: str | None = None,
    status: str | None = None,
    missing: bool = False,
):
    """``missing=True`` flips the view to files the last scan could no longer
    find on disk (``present = 0``) instead of the normal present-only listing
    -- see ``maintenance/cleanup.py`` for what eventually removes those rows."""
    where = ["present = 0" if missing else "present = 1"]
    params: list = []
    if type:
        where.append("type = ?")
        params.append(type)
    if status:
        where.append("enrich_status = ?")
        params.append(status)
    if q:
        where.append("path LIKE ?")
        params.append(f"%{q}%")
    clause = (" WHERE " + " AND ".join(where)) if where else ""

    con = db.connect()
    total = con.execute(f"SELECT COUNT(*) AS c FROM files{clause}", params).fetchone()["c"]
    rows = con.execute(
        f"SELECT {LIST_COLUMNS} FROM files{clause} ORDER BY path LIMIT ? OFFSET ?",
        (*params, limit, offset),
    ).fetchall()
    con.close()

    items = []
    for r in rows:
        item = dict(r)
        item["filename"] = os.path.basename(item["path"])
        items.append(item)
    return {"total": total, "offset": offset, "limit": limit, "items": items}


@router.get("/library/{file_id}")
def get_file(file_id: int, _: str = Depends(auth.current_user)):
    con = db.connect()
    row = con.execute(
        f"SELECT {LIST_COLUMNS}, codec, bitrate, has_title_comment, mtime "
        "FROM files WHERE id = ?",
        (file_id,),
    ).fetchone()
    con.close()
    if not row:
        raise HTTPException(status_code=404, detail="file not found")
    item = dict(row)
    item["filename"] = os.path.basename(item["path"])
    return item


@router.post("/library/{file_id}/reenrich")
def reenrich_file(file_id: int, _: str = Depends(auth.current_user)):
    """Reset a single file to ``pending`` so the worker re-derives everything.

    Existing derived values are cleared; the continuous worker prioritises
    stage-0 files, so this is processed promptly.
    """
    con = db.connect()
    cur = con.execute(
        "UPDATE files SET enrich_stage = 0, enrich_status = 'pending', "
        "md5 = NULL, phash = NULL, frame_hashes = NULL, frames_b64 = NULL, "
        "edge_hashes = NULL, width = NULL, "
        "height = NULL, duration = NULL, codec = NULL, bitrate = NULL, "
        "has_title_comment = NULL, thumbnail_b64 = NULL, error = NULL, "
        "enriched_at = NULL WHERE id = ?",
        (file_id,),
    )
    con.commit()
    con.close()
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="file not found")
    return {"status": "pending"}


class RenameIn(BaseModel):
    new_name: str


@router.post("/library/{file_id}/rename")
def rename_file(file_id: int, body: RenameIn, _: str = Depends(auth.current_user)):
    """Rename a single file to an explicit, user-chosen name — independent of
    any rename rule. Rejects on a name collision instead of auto-suffixing:
    the user picked this name deliberately, so they should pick a different
    one rather than silently get a ``_1``."""
    new_name = body.new_name.strip()
    if not new_name or "/" in new_name or "\\" in new_name:
        raise HTTPException(status_code=400, detail="invalid filename")

    con = db.connect()
    row = con.execute("SELECT path FROM files WHERE id = ?", (file_id,)).fetchone()
    if not row:
        con.close()
        raise HTTPException(status_code=404, detail="file not found")

    old_path = Path(row["path"])
    if not old_path.is_file():
        con.close()
        raise HTTPException(status_code=404, detail="file no longer on disk")

    new_path = old_path.parent / new_name
    if new_path == old_path:
        con.close()
        return {"path": str(old_path), "filename": old_path.name}
    # files.path is UNIQUE regardless of `present`, so also reject a name a
    # stale (no-longer-on-disk) row already claims, not just a real file.
    taken = new_path.exists() or con.execute(
        "SELECT 1 FROM files WHERE path = ? AND id != ?", (str(new_path), file_id)
    ).fetchone() is not None
    if taken:
        con.close()
        raise HTTPException(status_code=409, detail="a file with that name already exists")

    try:
        old_path.rename(new_path)
    except OSError as exc:
        con.close()
        raise HTTPException(status_code=500, detail=str(exc))

    try:
        con.execute("UPDATE files SET path = ? WHERE id = ?", (str(new_path), file_id))
        con.commit()
    except sqlite3.Error as exc:
        con.rollback()
        new_path.rename(old_path)  # keep disk and DB from disagreeing
        con.close()
        raise HTTPException(status_code=409, detail=str(exc))
    con.close()
    return {"path": str(new_path), "filename": new_path.name}


def _ranged_response(path: str, request: Request) -> StreamingResponse | FileResponse:
    media_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
    file_size = os.path.getsize(path)
    range_header = request.headers.get("range")

    if not range_header:
        return FileResponse(path, media_type=media_type)

    # Parse a single "bytes=start-end" range.
    try:
        _, rng = range_header.split("=", 1)
        start_s, end_s = rng.split("-", 1)
        start = int(start_s) if start_s else 0
        end = int(end_s) if end_s else file_size - 1
    except ValueError:
        raise HTTPException(status_code=416, detail="invalid range")
    end = min(end, file_size - 1)
    if start > end:
        raise HTTPException(status_code=416, detail="invalid range")
    length = end - start + 1

    def iterator():
        with open(path, "rb") as f:
            f.seek(start)
            remaining = length
            while remaining > 0:
                chunk = f.read(min(CHUNK, remaining))
                if not chunk:
                    break
                remaining -= len(chunk)
                yield chunk

    headers = {
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
    }
    return StreamingResponse(iterator(), status_code=206, headers=headers, media_type=media_type)


@router.get("/media/{file_id}/transcode")
def transcode_media(file_id: int, _: str = Depends(auth.current_user)):
    """Stream a container-incompatible video through ffmpeg as fragmented MP4.

    Uses frag_keyframe+empty_moov so the browser can start playback immediately
    without a seekable moov atom. Seeking is limited to buffered content.
    The ffmpeg process is killed when the client disconnects.
    """
    con = db.connect()
    row = con.execute("SELECT path FROM files WHERE id = ?", (file_id,)).fetchone()
    con.close()
    if not row:
        raise HTTPException(status_code=404, detail="file not found")
    path = row["path"]
    try:
        paths.resolve_within_root(path)
    except ValueError:
        raise HTTPException(status_code=403, detail="forbidden")
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="file no longer on disk")

    cmd = [
        "ffmpeg", "-i", path,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-f", "mp4",
        "-movflags", "frag_keyframe+empty_moov",
        "pipe:1",
    ]

    def _stream():
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        try:
            while True:
                chunk = proc.stdout.read(CHUNK)
                if not chunk:
                    break
                yield chunk
        finally:
            proc.kill()
            proc.wait()

    return StreamingResponse(_stream(), media_type="video/mp4",
                             headers={"Cache-Control": "no-cache"})


@router.get("/media/{file_id}/thumb")
def media_thumbnail(file_id: int, _: str = Depends(auth.current_user)):
    """Serve the pre-computed thumbnail as a real JPEG response.

    The thumbnail is stored base64-encoded in ``files.thumbnail_b64``; decoding
    it back to bytes here (instead of inlining the base64 into list payloads)
    keeps listing JSON small and lets the browser cache and lazy-load thumbnails
    by URL. Cached for a day — short enough that a re-enrich (same file id, new
    thumbnail) is picked up soon, long enough to help repeat views.
    """
    con = db.connect()
    row = con.execute("SELECT thumbnail_b64 FROM files WHERE id = ?", (file_id,)).fetchone()
    con.close()
    if not row or not row["thumbnail_b64"]:
        raise HTTPException(status_code=404, detail="no thumbnail")
    try:
        data = base64.b64decode(row["thumbnail_b64"])
    except (binascii.Error, ValueError):
        raise HTTPException(status_code=404, detail="no thumbnail")
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=86400"},
    )


@router.get("/media/{file_id}")
def stream_media(file_id: int, request: Request, _: str = Depends(auth.current_user)):
    con = db.connect()
    row = con.execute("SELECT path FROM files WHERE id = ?", (file_id,)).fetchone()
    con.close()
    if not row:
        raise HTTPException(status_code=404, detail="file not found")
    path = row["path"]
    try:
        paths.resolve_within_root(path)
    except ValueError:
        raise HTTPException(status_code=403, detail="forbidden")
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="file no longer on disk")
    return _ranged_response(path, request)
