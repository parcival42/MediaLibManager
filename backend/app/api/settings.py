"""Settings endpoints — read and update the DB-backed configuration."""
from fastapi import APIRouter, Depends

from .. import auth, config

router = APIRouter(prefix="/api")


@router.get("/settings")
def get_settings(_: str = Depends(auth.current_user)):
    return config.get_all()


@router.put("/settings")
def update_settings(values: dict, _: str = Depends(auth.current_user)):
    # Only persist known keys to avoid arbitrary writes.
    allowed = {k: v for k, v in values.items() if k in config.DEFAULTS}
    config.set_many(allowed)
    return config.get_all()
