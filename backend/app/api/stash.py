"""Stash integration status: the buffered scan request and its last outcome."""
from fastapi import APIRouter, Depends

from .. import auth, stash

router = APIRouter(prefix="/api")


@router.get("/stash/status")
def stash_status(_: str = Depends(auth.current_user)):
    return stash.status()


@router.post("/stash/flush")
def stash_flush(_: str = Depends(auth.current_user)):
    """Send the buffered scan request now instead of waiting for the delay."""
    stash.flush_now()
    return stash.status()
