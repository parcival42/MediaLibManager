# Quick strip/replace for filenames — design

## Intent

Removing or replacing a few words/phrases/characters across a directory is
possible today via rename rules + strip filters, but that is too cumbersome for
ad-hoc cleanups. A rule-free mode: pick a path, enter terms, choose
remove/replace and recursive, review affected files, confirm per file.

## Goals

- Rule-free, one-off bulk edit of filenames under one directory.
- Mode "remove" (default) or "replace" (all terms replaced with one replacement text).
- Recursive toggle.
- Preview of affected files with per-file checkbox and select all / deselect all.
- Confirm applies only the selected files.

## Non-goals

- Undo, regular expressions, saving term lists, renaming directories, touching
  file extensions, automatic/unattended runs.

## Approaches

1. **Second tab on the Rename page, reusing the task/preview/apply plumbing (chosen).**
   Directory tree, result list with checkboxes and select-all already exist
   there; backend reuses `rules._apply_strip_filter`-style matching,
   `rules.next_free_name` and the disk+DB rename pattern of `apply_renames`.
2. Generate a temporary rule + assignment and run the normal rename flow —
   rejected: pollutes the rule tables and the assignment is recursive-only.
3. Pure filesystem walk independent of the DB — rejected: renamed files would
   desync from `files.path` until the next scan.

## Behaviour

- **Input:** directory (from the tree), terms (one per line, empty lines ignored),
  mode `remove` | `replace`, replacement text (replace mode only), recursive flag.
- **Matching:** case-insensitive. Terms whose edge character is alphanumeric
  only match as whole tokens on that side (existing `rules.word_pattern`: `HD` does
  not hit `HDR`); non-alphanumeric edges match anywhere (`[` is removed everywhere).
  Same rule for both modes.
- **Scope:** only the stem; the extension is preserved. Only `present = 1`
  files from the DB. Non-recursive = files whose parent directory equals the
  selected path exactly.
- **Cleanup after substitution:** collapse runs of spaces, trim ` -._` at the
  ends (same as the filename segment). Result empty or unchanged -> file is not
  listed.
- **Collisions:** resolved with `_1`, `_2`, ... like the rule rename; preview
  simulates it in path order and flags `collision: true`.
- **Apply:** server recomputes each new name from the same parameters (never
  trusts client names), checks filesystem + DB for collisions, renames on disk,
  updates `files.path`, rolls the disk rename back on DB error, per-file errors
  don't abort the batch. Invalidates the cached rule previews.
- **Execution:** preview and apply run through the task queue with progress,
  like the rule rename; full preview result cached outside `tasks.result`.

## UI

Rename page gets a tab switch: "Rules" | "Quick edit". Quick edit:

```
[ directory tree ]   Terms (one per line)
                     ( ) Remove  ( ) Replace with [______]
                     [x] Recursive
                     [Preview]

[Select all] [Deselect all]                       [Apply (n)]
[x] old name  ->  new name   (collision badge)
```

UI strings DE/EN via `i18n.tsx`.

## Left to the builder

Endpoint names, module layout (likely `rename/quick.py` + routes in
`api/rename.py`), exact component split in the frontend.
