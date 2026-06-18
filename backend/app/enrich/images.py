"""Image enrichment: dimensions (cheap header read), then pHash + thumbnail."""
import base64
from io import BytesIO

import imagehash
import numpy as np
from PIL import Image, ImageOps

try:  # HEIC/HEIF support is optional but registered when available.
    from pillow_heif import register_heif_opener

    register_heif_opener()
except Exception:  # noqa: BLE001 - absence just means no HEIC decoding
    pass

THUMB_MAX = 320  # longest edge of the stored preview, in pixels
PREVIEW_MAX = (160, 120)  # size of a single frame in the video frame strip


def image_meta(path: str) -> dict:
    """Stage 1: read width/height from the header without decoding pixels."""
    with Image.open(path) as img:
        width, height = img.size
    return {"width": width, "height": height}


def make_thumbnail_b64(img: Image.Image) -> str:
    """Downscale ``img`` and return a base64-encoded JPEG (no data-URI prefix)."""
    thumb = ImageOps.exif_transpose(img).convert("RGB")
    thumb.thumbnail((THUMB_MAX, THUMB_MAX))
    buf = BytesIO()
    thumb.save(buf, format="JPEG", quality=72)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def make_preview_b64(img: Image.Image) -> str:
    """Small base64 JPEG (no data-URI prefix) for one frame of the strip."""
    p = ImageOps.exif_transpose(img).convert("RGB")
    p.thumbnail(PREVIEW_MAX)
    buf = BytesIO()
    p.save(buf, format="JPEG", quality=60)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def mean_saturation(img: Image.Image) -> float:
    """Mean HSV saturation (0.0 = greyscale, 1.0 = fully saturated).

    Public because the maintenance colour backfill recomputes the same value
    from a stored thumbnail for rows enriched before the column existed.
    """
    arr = np.array(img.convert("RGB"), dtype=np.float32) / 255.0
    mx = arr.max(axis=2)
    mn = arr.min(axis=2)
    sat = np.where(mx > 0, (mx - mn) / mx, 0.0)
    return float(sat.mean())


def image_phash_thumb(path: str) -> dict:
    """Stage 2: perceptual hash, mean saturation, and preview thumbnail."""
    with Image.open(path) as img:
        img.load()
        phash = str(imagehash.phash(img))
        saturation = mean_saturation(img)
        thumb = make_thumbnail_b64(img)
    return {"phash": phash, "mean_saturation": saturation, "thumbnail_b64": thumb}
