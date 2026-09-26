"""Settings endpoints — read and update the DB-backed configuration."""
from fastapi import APIRouter, Depends, HTTPException

from .. import auth, config

router = APIRouter(prefix="/api")


@router.get("/settings")
def get_settings(_: str = Depends(auth.current_user)):
    return config.get_all()


def _coerce(key: str, value):
    """Coerce ``value`` to the type implied by ``config.DEFAULTS[key]``.

    Raises (TypeError, ValueError) if it can't be -- letting e.g. an empty
    numeric field through as JSON ``null`` would silently store ``None`` for
    a setting that every reader assumes it can safely ``int()``/``float()``
    without its own checks (a bad value here used to reach as far as flipping
    an unrelated, already-successful task's status to 'error').
    """
    default = config.DEFAULTS[key]
    if isinstance(default, bool):
        return bool(value)
    if isinstance(default, int):  # after the bool check -- bool is an int subclass
        return int(value)
    if isinstance(default, float):
        return float(value)
    return value  # str, list, ... -- accepted as given


@router.put("/settings")
def update_settings(values: dict, _: str = Depends(auth.current_user)):
    # Only persist known keys to avoid arbitrary writes, and reject the whole
    # request if any of them can't be coerced to its expected type rather
    # than silently persisting a corrupt value (see _coerce's docstring).
    allowed = {}
    invalid = []
    for k, v in values.items():
        if k not in config.DEFAULTS:
            continue
        try:
            allowed[k] = _coerce(k, v)
        except (TypeError, ValueError):
            invalid.append(k)
    if invalid:
        raise HTTPException(status_code=400, detail=f"invalid value for: {', '.join(invalid)}")
    config.set_many(allowed)
    return config.get_all()
