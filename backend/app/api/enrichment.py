"""Enrichment endpoints — global progress and the error list for the Tasks page."""
from fastapi import APIRouter, Depends

from .. import auth, db
from ..enrich import worker

router = APIRouter(prefix="/api")

ERROR_LIMIT = 200


@router.get("/enrichment/status")
def enrichment_status(_: str = Depends(auth.current_user)):
    return worker.status()


@router.get("/enrichment/errors")
def enrichment_errors(_: str = Depends(auth.current_user)):
    con = db.connect()
    rows = con.execute(
        "SELECT id, path, error FROM files "
        "WHERE present = 1 AND enrich_status = 'error' "
        "ORDER BY enriched_at DESC LIMIT ?",
        (ERROR_LIMIT,),
    ).fetchall()
    con.close()
    return [dict(r) for r in rows]
