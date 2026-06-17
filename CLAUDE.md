# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Conventions

1. **Code is English only** — comments, identifiers, function/method names, docstrings.
   User-facing UI text may be multilingual (DE/EN), but the source code itself is English.
2. **Use neutral placeholders for paths and data** — never hardcode real filesystem
   paths or real content/category names into code, comments, or examples. Use generic
   placeholders (`/media`, `/data`, `<media-root>`, `CategoryA`…) so the codebase stays
   environment-agnostic.

## Project in one line

MediaLibManager combines three capabilities (file renaming, MP4 metadata stripping,
duplicate detection) into one Docker app with a FastAPI backend, a React + Vite + Tailwind
web UI, and a single SQLite database — built around a central media DB with a two-stage
scan (fast inventory → background enrichment) and a serial SQLite-backed task queue.

## Layout

- `backend/` — FastAPI app (`app/`), modular by area: `scan`, `enrich`, `dedup`,
  `rename`, `metadata`, `tasks`, `api`.
- `frontend/` — React + Vite + TypeScript + Tailwind SPA.
- `Dockerfile` — multi-stage (Node build → Python runtime with ffmpeg/exiftool/file).

## Commands

```bash
# Backend (dev)
cd backend && pip install -r requirements.txt
uvicorn app.main:app --reload --port 8080

# Frontend (dev, proxies /api to :8080)
cd frontend && npm install && npm run dev

# Full app via Docker
docker compose up --build
```

Environment: `AUTH_SECRET` (session signing; set a fixed value so sessions survive
restarts), `MEDIALIB_DATA` (DB/working dir, default `/data`). All other configuration
lives in the `settings` table and is edited via the Settings page.

## Helper scripts (PowerShell, in `scripts/`)

The scripts run against the running container and assume the media library is mounted at
`/media` and the data dir at `/data`.

- **`scripts/generate-testmedia.ps1 [-Clean]`** — generates a synthetic fixture set into
  the media volume via the container's ffmpeg: real files (video / image / audio), broken
  files (ffprobe-error path) and one duplicate pair per detection kind (exact / visual /
  video / deep). `-Clean` wipes the fixtures first. Expected after scan + enrich +
  duplicate rebuild: exact 2, visual 1, video 1, deep 1, plus 2 files in `error`.
- **`scripts/smoke-test.ps1 [-Rebuild] [-Fresh] [-Media]`** — end-to-end check of the
  scan + enrichment happy path against the container; prints a PASS/FAIL verdict.
  `-Rebuild` rebuilds the image, `-Fresh` wipes the data dir, `-Media` regenerates the
  *base* fixtures (no duplicates — use `generate-testmedia.ps1` for dedup data). Does not
  yet assert duplicate detection.

A typical cold run: `docker compose build` → `generate-testmedia.ps1 -Clean` →
`docker compose up` → scan + enrich + "Find duplicates" in the UI.
