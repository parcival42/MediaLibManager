"""Enrichment endpoints — global progress and the error list for the Tasks page."""
from fastapi import APIRouter, Depends, HTTPException

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


@router.post("/enrichment/errors/{file_id}/retry")
def retry_enrichment_error(file_id: int, _: str = Depends(auth.current_user)):
    result = worker.retry_file(file_id)
    if result == "not_found":
        raise HTTPException(status_code=404, detail="file not found")
    return {"status": result}
