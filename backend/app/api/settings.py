"""Settings endpoints — read and update the DB-backed configuration."""
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import auth, config, stash

router = APIRouter(prefix="/api")


@router.get("/settings")
def get_settings(_: str = Depends(auth.current_user)):
    return config.get_all()


def _options_mode(value) -> str:
    if value not in ("stash", "custom"):
        raise ValueError(value)
    return value


def _scan_options(value) -> dict:
    if not isinstance(value, dict):
        raise TypeError(value)
    if any(not isinstance(v, bool) for v in value.values()):
        raise TypeError(value)
    return {str(k): v for k, v in value.items()}


def _exclude_patterns(value) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(v, str) for v in value):
        raise TypeError(value)
    # Drop blanks and duplicates, keep the given order.
    return list(dict.fromkeys(v.strip() for v in value if v.strip()))


# Keys whose value needs more than the type-of-default coercion below.
_VALIDATORS = {
    "stash_scan_options_mode": _options_mode,
    "stash_scan_options":      _scan_options,
    "scan_exclude_patterns":   _exclude_patterns,
}


def _coerce(key: str, value):
    """Coerce ``value`` to the type implied by ``config.DEFAULTS[key]``.

    Raises (TypeError, ValueError) if it can't be -- letting e.g. an empty
    numeric field through as JSON ``null`` would silently store ``None`` for
    a setting that every reader assumes it can safely ``int()``/``float()``
    without its own checks (a bad value here used to reach as far as flipping
    an unrelated, already-successful task's status to 'error').
    """
    if key in _VALIDATORS:
        return _VALIDATORS[key](value)
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


class StashTestIn(BaseModel):
    url: str
    api_key: str = ""


@router.post("/settings/stash/test")
def test_stash(req: StashTestIn, _: str = Depends(auth.current_user)):
    """Check the given (possibly unsaved) Stash URL/API key."""
    try:
        version = stash.test_connection(req.url.strip(), req.api_key.strip())
    except stash.StashError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, "version": version}


@router.post("/settings/stash/scan-options")
def stash_scan_options(req: StashTestIn, _: str = Depends(auth.current_user)):
    """Scan flags the given Stash instance accepts, plus its configured
    defaults -- for the custom-options editor (works with unsaved values)."""
    try:
        info = stash.scan_options_info(req.url.strip(), req.api_key.strip())
    except stash.StashError as exc:
        return {"ok": False, "error": str(exc)}
    return {"ok": True, **info}
