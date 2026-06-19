"""Rule/segment model and target-name computation.

A rule is an ordered list of segments joined by a separator. Each segment has a
``source`` (the building block) and a few source-specific options — no
conditional logic, deliberately simple:

    literal     -- fixed text                       {"text": str}
    dirname     -- directory name N levels under the assignment directory
                                                      {"level": int}
    resolution  -- "WIDTHxHEIGHT" (video/image) or the audio marker
    duration    -- formatted duration (video/audio)
    filename    -- the original file stem, with optional transforms and
                   user-defined strip filters
                   {"transforms": [str, ...], "strip_filter_ids": [int, ...]}

Resolution/duration are read from the already-enriched ``files`` row instead
of shelling out to ffprobe/exiftool per file, and the segment model replaces a
single hardcoded template, so any segment order and count is supported.
"""
import os
import re

# Fixed marker used in place of a resolution for audio files (no width/height).
AUDIO_LABEL = "audio"


def _clean_special_chars(raw: str) -> str:
    """Replace non-printable/non-Latin characters with "_" and collapse runs."""
    cleaned = re.sub(r"[^\x20-\x7EÀ-ɏ]+", "_", raw)
    return re.sub(r"_+", "_", cleaned).strip("_")


def _apply_strip_filter(stem: str, f: dict) -> str:
    """Apply a single user-defined strip filter to ``stem``.

    Type 'strings':      each entry (str) is removed as a whole word, case-insensitive.
    Type 'replace_chars': each entry ({"from": str, "to": str}) replaces occurrences of
                          ``from`` with ``to``.
    """
    entries = f.get("entries") or []
    if f.get("type") == "strings":
        for term in entries:
            if term:
                stem = re.sub(r"\b" + re.escape(term) + r"\b", "", stem, flags=re.I)
    elif f.get("type") == "replace_chars":
        for entry in entries:
            src, dst = entry.get("from", ""), entry.get("to", "")
            if src:
                stem = stem.replace(src, dst)
    return re.sub(r" {2,}", " ", stem).strip()


def _format_duration(seconds: float) -> str:
    total = int(round(seconds))
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _join(values: list[str], separator: str) -> str:
    """Join non-empty values only, so a missing/empty segment never leaves a
    dangling separator behind."""
    return separator.join(v for v in values if v)


def _render_dirname(seg: dict, assignment_dir: str, path: str) -> tuple[str, bool]:
    level = int(seg.get("level", 1))
    try:
        rel = os.path.relpath(path, assignment_dir)
    except ValueError:
        return "", False
    components = rel.split(os.sep)[:-1]  # directory parts, excluding the filename
    if level < 1 or level > len(components):
        return "", False
    return components[level - 1], False


def _render_resolution(file_row: dict) -> tuple[str, bool]:
    ftype = file_row.get("type")
    if ftype == "audio":
        return AUDIO_LABEL, False
    if ftype in ("video", "image"):
        width, height = file_row.get("width"), file_row.get("height")
        if width and height:
            return f"{width}x{height}", False
        return "", True  # not enriched yet
    return "", False


def _render_duration(file_row: dict) -> tuple[str, bool]:
    ftype = file_row.get("type")
    if ftype not in ("video", "audio"):
        return "", False
    duration = file_row.get("duration")
    if duration:
        return _format_duration(duration), False
    return "", True  # not enriched yet


def _render_filename(raw: str, seg: dict, filters_by_id: dict) -> str:
    value = raw
    for fid in seg.get("strip_filter_ids") or []:
        f = filters_by_id.get(int(fid))
        if f:
            value = _apply_strip_filter(value, f)
    if "clean_special_chars" in (seg.get("transforms") or []):
        value = _clean_special_chars(value)
    value = re.sub(r" {2,}", " ", value)
    return value.strip(" -.")


def build_target_name(rule: dict, assignment_dir: str, file_row: dict, filters_by_id: dict) -> str | None:
    """Compute the target filename (with extension) for ``file_row``.

    Returns ``None`` when a required value (resolution/duration) hasn't been
    enriched yet — the caller should treat the file as pending, not render a
    name with a blank field.

    The "filename" segment is fed the current stem with the prefix made up of
    the segments rendered *before* it stripped off first, when present. That
    keeps the rule idempotent: re-running it on an already-renamed file
    recovers the original title instead of re-prepending the name/resolution
    on every run. The prefix is computed from the rule itself, so it works for
    any segment order/count.
    """
    segments = rule["segments"]
    separator = rule.get("separator") or " - "
    current_name = os.path.basename(file_row["path"])
    stem, ext = os.path.splitext(current_name)

    rendered: list[str] = []
    missing = False
    for seg in segments:
        source = seg.get("source")
        if source == "literal":
            value, seg_missing = seg.get("text", ""), False
        elif source == "dirname":
            value, seg_missing = _render_dirname(seg, assignment_dir, file_row["path"])
        elif source == "resolution":
            value, seg_missing = _render_resolution(file_row)
        elif source == "duration":
            value, seg_missing = _render_duration(file_row)
        elif source == "filename":
            prefix_val = _join(rendered, separator)
            prefix = prefix_val + separator if prefix_val else ""
            raw = stem[len(prefix):] if prefix and stem.startswith(prefix) else stem
            value, seg_missing = _render_filename(raw, seg, filters_by_id), False
        else:
            value, seg_missing = "", False
        missing = missing or seg_missing
        rendered.append(value)

    if missing:
        return None

    name = _join(rendered, separator)
    return f"{name}{ext}" if name else None


def next_free_name(newname: str, taken) -> str:
    """Append ``_1``, ``_2``, … until ``taken(candidate)`` is false.

    ``taken`` is a predicate over candidate basenames, so callers can check
    whatever sources of truth matter to them (filesystem, DB, an in-memory
    set for preview's simulation — or several at once). Note the quirk of
    using the second-to-last dot-separated part as the stem when the name has
    more than one dot (e.g. "video.file.mp4" -> stem "file").
    """
    if not taken(newname):
        return newname

    parts = newname.split(".")
    suffix = parts[-1]
    prefix = parts[-2] if len(parts) >= 2 else parts[0]

    cnt = 1
    candidate = newname
    while taken(candidate):
        candidate = f"{prefix}_{cnt}.{suffix}"
        cnt += 1
    return candidate


