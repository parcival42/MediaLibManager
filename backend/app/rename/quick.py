"""Rule-free bulk removal/replacement of words, phrases or characters in filenames.

A lightweight alternative to rules + strip filters for one-off cleanups: pick
a directory, enter terms, remove them (or replace them with one fixed text),
optionally recursive. Only the stem is touched; the extension is preserved.

Matching uses the same token logic as the "strings" strip filter
(``rules.word_pattern``): case-insensitive, and a term whose edge character is
alphanumeric only matches as a whole token on that side ("HD" does not hit
"HDR"), while non-alphanumeric edges match anywhere ("[" is removed
everywhere).

Preview and apply mirror ``engine.preview`` / ``engine.apply_renames``: both run
through the task queue, the full preview result goes into the engine's preview
cache (fetched via the regular ``GET /api/rename/preview/{task_id}``), and
apply recomputes every target from the same parameters instead of trusting
client-supplied names.
"""
import os
import re
from collections import defaultdict

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
    if parent == directory:
        return True
    return recursive and parent.startswith(directory.rstrip(os.sep) + os.sep)


def _like_prefix(directory: str) -> str:
    return directory.rstrip(os.sep) + os.sep + "%"


def preview(ctx, directory: str, recursive: bool, terms: list[str], replacement: str) -> dict:
    """Compute proposed renames for present files in scope.

    Collision suffixes are simulated in path order against every known path
    in the affected directories (regardless of ``present``), the same way
    ``engine.preview`` does, so preview and apply agree.
    """
    ctx.log(f"Scope: {directory} ({'recursive' if recursive else 'this directory only'})")
    ctx.log(f"Terms: {', '.join(terms)}")
    con = db.connect()
    try:
        like = _like_prefix(directory)
        files = [
            dict(r) for r in con.execute(
                "SELECT id, path FROM files WHERE present = 1 AND path LIKE ?", (like,)
            ).fetchall()
            if _in_scope(r["path"], directory, recursive)
        ]
        all_paths = [r["path"] for r in con.execute(
            "SELECT path FROM files WHERE path LIKE ?", (like,)
        ).fetchall()]
    finally:
        con.close()

    ctx.progress(5)
    taken_by_dir: dict[str, set[str]] = defaultdict(set)
    for p in all_paths:
        taken_by_dir[os.path.dirname(p)].add(os.path.basename(p))

    files.sort(key=lambda f: f["path"])
    total = len(files)
    step = max(1, total // 50)
    renames: list[dict] = []
    for i, f in enumerate(files, start=1):
        ctx.raise_if_cancelled()
        target = compute_target(f["path"], terms, replacement)
        if target is not None:
            own = os.path.basename(f["path"])
            parent = os.path.dirname(f["path"])
            taken = taken_by_dir[parent]
            final = rules.next_free_name(target, lambda n: n in taken and n != own)
            taken.discard(own)
            taken.add(final)
            if final != own:
                renames.append({
                    "file_id": f["id"],
                    "path": f["path"],
                    "directory": parent,
                    "current_name": own,
                    "new_name": final,
                    "collision": final != target,
                })
        if i % step == 0 or i == total:
            ctx.progress(5 + 95 * i / total)

    ctx.log(f"Done — {len(renames)} of {total} files affected.")
    engine.cache_preview(ctx.task_id, {"renames": renames, "pending": []})
    return {"rename_count": len(renames)}


def apply(file_ids: list[int], directory: str, recursive: bool, terms: list[str],
          replacement: str, ctx) -> dict:
    """Rename the selected files, recomputing each target server-side.

    Files that are gone, no longer in scope (e.g. renamed/moved since the
    preview) or would no longer change are skipped. Per-file errors are
    logged and the batch continues.
    """
    if not file_ids:
        return {"renamed": 0, "skipped": 0, "errors": 0, "renamed_ids": []}

    # Rule previews cached per scope would otherwise keep showing old names.
    engine.invalidate_recent_previews()

    con = db.connect()
    try:
        placeholders = ",".join("?" * len(file_ids))
        rows = con.execute(
            f"SELECT id, path, present FROM files WHERE id IN ({placeholders})", file_ids
        ).fetchall()
        ordered = sorted((dict(r) for r in rows), key=lambda r: r["path"])
        skipped = len(file_ids) - len(ordered)
        renamed = errors = 0
        renamed_ids: list[int] = []
        total = len(ordered)

        for i, f in enumerate(ordered, start=1):
            ctx.raise_if_cancelled()
            target = None
            if f["present"] and _in_scope(f["path"], directory, recursive):
                target = compute_target(f["path"], terms, replacement)
            if target is None:
                skipped += 1
            else:
                outcome = engine.rename_one(con, f["id"], f["path"], target, ctx)
                if outcome == "renamed":
                    renamed += 1
                    renamed_ids.append(f["id"])
                elif outcome == "error":
                    errors += 1
                else:
                    skipped += 1
            ctx.progress(100 * i / total)

        return {"renamed": renamed, "skipped": skipped, "errors": errors, "renamed_ids": renamed_ids}
    finally:
        con.close()
