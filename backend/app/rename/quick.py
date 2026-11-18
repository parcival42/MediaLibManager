"""Rule-free bulk removal/replacement of words, phrases or characters in filenames.

A lightweight alternative to rules + strip filters for one-off cleanups: pick
a directory, enter terms, remove them (or replace them with one fixed text),
optionally recursive. Only the stem is touched; the extension is preserved.

Matching uses the same token logic as the "strings" strip filter
(``rules.word_pattern``): case-insensitive, and a term whose edge character is
alphanumeric only matches as a whole token on that side ("HD" does not hit
"HDR"), while non-alphanumeric edges match anywhere ("[" is removed
everywhere).

Preview and apply share the engine's helpers (``simulate_collisions``,
``apply_batch``): both run through the task queue, the full preview result
goes into the engine's preview cache (fetched via the regular
``GET /api/rename/preview/{task_id}``), and apply recomputes every target from
the same parameters instead of trusting client-supplied names.
"""
import os
import re

from .. import db
from . import engine, rules


def normalize_terms(terms: list[str]) -> list[str]:
    """Trim terms, drop empty ones and case-insensitive duplicates, and sort
    longest first so a phrase wins over a shorter term it contains.

    A whitespace-only term is kept as-is (so a plain space can be removed or
    replaced); any other term is trimmed so a stray trailing space doesn't
    stop it from matching at the end of a name."""
    seen: set[str] = set()
    out: list[str] = []
    for term in terms:
        term = term.strip("\r\n")
        term = term.strip() or term
        if term and term.lower() not in seen:
            seen.add(term.lower())
            out.append(term)
    return sorted(out, key=len, reverse=True)


def compute_target(path: str, terms: list[str], replacement: str) -> str | None:
    """New filename for ``path``, or ``None`` if no term matches, nothing
    changes, or the stem would end up empty.

    All terms are matched in a single pass (one alternation, longest first),
    so in replace mode a later term never matches text an earlier
    replacement just inserted. Space/edge cleanup only runs when a term
    actually matched -- otherwise unrelated files with e.g. a leading "_"
    would show up as "affected".
    """
    current_name = os.path.basename(path)
    stem, ext = os.path.splitext(current_name)
    pattern = "|".join(f"(?:{rules.word_pattern(t)})" for t in terms)
    value, count = re.subn(pattern, lambda _m: replacement, stem, flags=re.I)
    if count == 0:
        return None
    value = re.sub(r" {2,}", " ", value).strip(" -._")
    if not value:
        return None
    target = f"{value}{ext}"
    return None if target == current_name else target


def _in_scope(path: str, directory: str, recursive: bool) -> bool:
    parent = os.path.dirname(path)
    base = directory.rstrip("/")
    if parent == base:
        return True
    return recursive and parent.startswith(base + "/")


def preview(ctx, directory: str, recursive: bool, terms: list[str], replacement: str) -> dict:
    """Compute proposed renames for present files in scope.

    Collision suffixes are simulated against every known path in scope
    (regardless of ``present``), the same way ``engine.preview`` does, so
    preview and apply agree.
    """
    ctx.log(f"Scope: {directory} ({'recursive' if recursive else 'this directory only'})")
    ctx.log(f"Terms: {', '.join(terms)}")
    con = db.connect()
    try:
        scope_sql, scope_params = db.under_dir(directory)
        files = [
            dict(r) for r in con.execute(
                f"SELECT id, path FROM files WHERE present = 1 AND {scope_sql}", scope_params
            ).fetchall()
            if _in_scope(r["path"], directory, recursive)
        ]
        all_paths = [r["path"] for r in con.execute(
            f"SELECT path FROM files WHERE {scope_sql}", scope_params
        ).fetchall()]
    finally:
        con.close()

    ctx.progress(5)
    candidates: list[dict] = []
    for f in files:
        target = compute_target(f["path"], terms, replacement)
        if target is not None:
            candidates.append({
                "file_id": f["id"],
                "path": f["path"],
                "directory": os.path.dirname(f["path"]),
                "current_name": os.path.basename(f["path"]),
                "target": target,
            })
    ctx.progress(20)
    renames = engine.simulate_collisions(
        candidates, engine.taken_names_by_dir(all_paths), ctx, progress_from=20
    )

    ctx.log(f"Done — {len(renames)} of {len(files)} files affected.")
    engine.cache_preview(ctx.task_id, {"renames": renames, "pending": []})
    return {"rename_count": len(renames)}


def apply(file_ids: list[int], directory: str, recursive: bool, terms: list[str],
          replacement: str, ctx) -> dict:
    """Rename the selected files, recomputing each target server-side.

    Files that are gone, no longer in scope (e.g. renamed/moved since the
    preview) or would no longer change are skipped.
    """
    if not file_ids:
        return {"renamed": 0, "skipped": 0, "errors": 0, "renamed_ids": []}

    # Rule previews cached per scope would otherwise keep showing old names.
    engine.invalidate_recent_previews()

    con = db.connect()
    try:
        placeholders = ",".join("?" * len(file_ids))
        rows = [dict(r) for r in con.execute(
            f"SELECT id, path, present FROM files WHERE id IN ({placeholders})", file_ids
        ).fetchall()]
    finally:
        con.close()

    def target_for(f: dict) -> str | None:
        if not _in_scope(f["path"], directory, recursive):
            return None
        return compute_target(f["path"], terms, replacement)

    result = engine.apply_batch(rows, target_for, ctx)
    result["skipped"] += len(file_ids) - len(rows)  # ids no longer in the DB
    return result
