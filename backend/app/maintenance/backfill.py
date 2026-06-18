"""Backfill the per-image colour signal (``mean_saturation``) for rows that
were enriched before the column existed.

``mean_saturation`` is normally produced in enrichment stage 1->2
(``enrich/images.py``). Images that reached ``done`` before the column was
added carry ``NULL``, and the duplicate image pass treats ``NULL`` as "do not
gate on colour", so a colour image and its black-and-white version still group
together until the value is filled in.

This pass recomputes the saturation from the **already stored thumbnail** (a
320px RGB JPEG kept on every enriched image) — so it touches neither the
original file nor the MD5, runs entirely off the database, and is safe to
re-run (it only ever fills ``NULL`` rows). It goes through the serial task
queue like the stale-row cleanup, since it walks every image row.
"""
import base64
from io import BytesIO

from PIL import Image

from .. import db
from ..enrich.images import mean_saturation

_COMMIT_BATCH = 200

# Images whose colour signal is missing but whose thumbnail is available to
# recompute it from. Shared by the count and the run so both stay in sync.
_PENDING_WHERE = (
    "type = 'image' AND mean_saturation IS NULL "
    "AND thumbnail_b64 IS NOT NULL AND thumbnail_b64 != ''"
)


def pending_count() -> int:
    con = db.connect()
    n = con.execute(f"SELECT COUNT(*) AS c FROM files WHERE {_PENDING_WHERE}").fetchone()["c"]
    con.close()
    return n


def run_backfill(ctx) -> dict:
    con = db.connect()
    try:
        rows = con.execute(
            f"SELECT id, thumbnail_b64 FROM files WHERE {_PENDING_WHERE}"
        ).fetchall()
        total = len(rows)
        ctx.log(f"Backfilling colour for {total} image(s) from stored thumbnails.")

        filled = failed = 0
        for i, r in enumerate(rows, start=1):
            ctx.raise_if_cancelled()
            try:
                raw = base64.b64decode(r["thumbnail_b64"])
                with Image.open(BytesIO(raw)) as img:
                    sat = mean_saturation(img)
                con.execute(
                    "UPDATE files SET mean_saturation = ? WHERE id = ?", (sat, r["id"])
                )
                filled += 1
            except Exception:  # noqa: BLE001 - a broken thumbnail just stays NULL
                failed += 1
            if i % _COMMIT_BATCH == 0:
                con.commit()
                ctx.progress(95 * i / total if total else 95)

        con.commit()
        ctx.progress(100)
        ctx.log(f"Done: filled {filled}, failed {failed}.")
        return {"filled": filled, "failed": failed}
    finally:
        con.close()
