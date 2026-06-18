"""FastAPI application entry point.

Wires up routers, initializes the database, marks orphaned tasks as interrupted
on startup, and serves the built frontend (SPA fallback) when present.
"""
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import db, scheduler
from .api import auth as auth_api
from .api import browse as browse_api
from .api import dedup as dedup_api
from .api import enrichment as enrichment_api
from .api import library as library_api
from .api import maintenance as maintenance_api
from .api import metadata as metadata_api
from .api import rename as rename_api
from .api import scan as scan_api
from .api import settings as settings_api
from .api import stats as stats_api
from .api import tasks as tasks_api
from .enrich import worker as enrich_worker
from .rename import engine as rename_engine
from .tasks import runner as task_runner

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init_db()
    rename_engine.ensure_default_rule()
    # A running/queued task can only be stale after a restart (no resume model).
    con = db.connect()
    con.execute(
        "UPDATE tasks SET status = 'interrupted', ended_at = ? "
        "WHERE status IN ('running', 'queued')",
        (time.time(),),
    )
    con.commit()
    con.close()
    # Start the serial task worker, then keep the media DB warm: the enrichment
    # worker runs for the app's lifetime (and yields whenever a task is active).
    task_runner.start_worker()
    enrich_worker.start()
    scheduler.start()
    yield
    scheduler.stop()
    enrich_worker.stop()


app = FastAPI(title="MediaLibManager", lifespan=lifespan)

app.include_router(auth_api.router)
app.include_router(browse_api.router)
app.include_router(settings_api.router)
app.include_router(scan_api.router)
app.include_router(tasks_api.router)
app.include_router(library_api.router)
app.include_router(enrichment_api.router)
app.include_router(dedup_api.router)
app.include_router(rename_api.router)
app.include_router(metadata_api.router)
app.include_router(maintenance_api.router)
app.include_router(stats_api.router)


@app.get("/api/health")
def health():
    return {"status": "ok"}


# Serve the built frontend in production. In development the Vite dev server
# runs separately and proxies /api to this backend, so STATIC_DIR is absent.
if (STATIC_DIR / "index.html").exists():
    assets = STATIC_DIR / "assets"
    if assets.exists():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{full_path:path}")
    def spa_fallback(full_path: str):
        if full_path.startswith("api"):
            raise HTTPException(status_code=404, detail="not found")
        candidate = STATIC_DIR / full_path
        if candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(STATIC_DIR / "index.html")
