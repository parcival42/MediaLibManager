"""Directory browse endpoint — lists immediate subdirectories under the media
root, for the directory-scope picker (e.g. on the Duplicates page)."""
from fastapi import APIRouter, Depends, HTTPException

from .. import auth, paths

router = APIRouter(prefix="/api")


@router.get("/browse")
def browse(path: str | None = None, _: str = Depends(auth.current_user)):
    try:
        target = paths.resolve_within_root(path)
    except ValueError:
        raise HTTPException(status_code=400, detail="path outside media root")
    if not target.is_dir():
        raise HTTPException(status_code=404, detail="directory not found")

    entries = []
    try:
        for p in sorted(target.iterdir(), key=lambda p: p.name.lower()):
            if p.is_dir() and not p.name.startswith("."):
                entries.append({"name": p.name, "path": str(p)})
    except PermissionError:
        pass
    return {"path": str(target), "directories": entries}
