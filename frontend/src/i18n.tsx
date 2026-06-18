/**
 * Minimal runtime i18n (DE/EN) for the app shell. The full translation set is
 * expanded in a later milestone; this provides the mechanism and the language
 * toggle. The chosen language is persisted in localStorage.
 */
import { createContext, useContext, useState, type ReactNode } from 'react'

export type Lang = 'de' | 'en'

const STRINGS: Record<string, { de: string; en: string }> = {
  nav_overview: { de: 'Übersicht', en: 'Overview' },
  nav_library: { de: 'Bibliothek', en: 'Library' },
  nav_duplicates: { de: 'Duplikate', en: 'Duplicates' },
  nav_rename: { de: 'Umbenennen', en: 'Rename' },
  nav_metadata: { de: 'Metadaten', en: 'Metadata' },
  nav_tasks: { de: 'Tasks', en: 'Tasks' },
  nav_statistics: { de: 'Statistik', en: 'Statistics' },
  nav_settings: { de: 'Einstellungen', en: 'Settings' },

  enrichment: { de: 'Anreicherung', en: 'Enrichment' },
  enrich_done: { de: 'Anreicherung fertig', en: 'Enrichment complete' },
  enrich_paused: { de: 'Anreicherung pausiert', en: 'Enrichment paused' },
  enrich_remaining: { de: 'verbleibend', en: 'remaining' },
  enrich_steps_remaining: { de: 'Schritte verbleibend', en: 'steps remaining' },
  reenrich: { de: 'Neu anreichern', en: 'Re-enrich' },
  enrich_error: { de: 'Anreicherungsfehler', en: 'Enrichment error' },
  reenrich_queued: { de: 'Zur Neuanreicherung eingereiht.', en: 'Queued for re-enrichment.' },
  rename_action: { de: 'Umbenennen', en: 'Rename' },
  rename_placeholder: { de: 'Neuer Dateiname', en: 'New filename' },
  rename_confirm: { de: 'OK', en: 'OK' },
  rename_cancel: { de: 'Abbrechen', en: 'Cancel' },
  rename_conflict: { de: 'Eine Datei mit diesem Namen existiert bereits.', en: 'A file with that name already exists.' },
  logout: { de: 'Abmelden', en: 'Sign out' },

  login_title: { de: 'Anmelden', en: 'Sign in' },
  setup_title: { de: 'Ersteinrichtung', en: 'First-time setup' },
  setup_first_run: { de: 'Ersteinrichtung', en: 'First-time setup' },
  setup_info: {
    de: 'Es existiert noch kein Benutzerkonto. Lege jetzt das Admin-Konto an — es hat vollen Zugriff auf die App.',
    en: 'No user account exists yet. Create the admin account now — it will have full access to the app.',
  },
  confirm_password: { de: 'Passwort bestätigen', en: 'Confirm password' },
  passwords_mismatch: { de: 'Passwörter stimmen nicht überein.', en: 'Passwords do not match.' },
  setup_btn: { de: 'Konto anlegen', en: 'Create account' },
  username: { de: 'Benutzername', en: 'Username' },
  password: { de: 'Passwort', en: 'Password' },
  submit: { de: 'Anmelden', en: 'Sign in' },

  settings_saved: { de: 'Gespeichert.', en: 'Saved.' },
  save: { de: 'Speichern', en: 'Save' },
  settings_metadata_empty: {
    de: 'Für Metadaten gibt es aktuell keine Einstellungen.',
    en: 'No settings for Metadata yet.',
  },

  scan: { de: 'Scan starten', en: 'Start scan' },
  scanning: { de: 'Scan läuft…', en: 'Scanning…' },
  search: { de: 'Suchen…', en: 'Search…' },
  all_types: { de: 'Alle Typen', en: 'All types' },
  type_video: { de: 'Video', en: 'Video' },
  type_image: { de: 'Bild', en: 'Image' },
  type_audio: { de: 'Audio', en: 'Audio' },
  type_other: { de: 'Sonstige', en: 'Other' },
  no_files: { de: 'Keine Dateien. Starte einen Scan, um die Bibliothek zu erfassen.', en: 'No files. Start a scan to index the library.' },
  files_total: { de: 'Dateien', en: 'files' },
  lib_missing_toggle: { de: 'Fehlende Dateien', en: 'Missing files' },
  lib_missing_total: { de: 'fehlende Dateien', en: 'missing files' },
  lib_missing_badge: { de: 'Fehlt', en: 'Missing' },
  lib_missing_none: {
    de: 'Keine fehlenden Dateien. Alle Einträge wurden beim letzten Scan auf der Festplatte gefunden.',
    en: 'No missing files. Every entry was found on disk at the last scan.',
  },
  close: { de: 'Schließen', en: 'Close' },
  download: { de: 'Herunterladen', en: 'Download' },
  detail_resolution: { de: 'Auflösung', en: 'Resolution' },
  detail_duration: { de: 'Dauer', en: 'Duration' },
  detail_path: { de: 'Pfad', en: 'Path' },

  ov_subtitle: {
    de: 'Zentrale Verwaltung deiner Mediensammlung.',
    en: 'Central control for your media collection.',
  },
  ov_library_desc: {
    de: 'Bestand durchsuchen, filtern und Details ansehen.',
    en: 'Browse, filter and inspect your indexed files.',
  },
  ov_dup_desc: {
    de: 'Exakte und visuell ähnliche Duplikate finden.',
    en: 'Find exact and visually similar duplicates.',
  },
  ov_rename_desc: {
    de: 'Dateien regelbasiert umbenennen (Vorschau + Anwenden).',
    en: 'Rename files by rules (preview then apply).',
  },
  ov_meta_desc: {
    de: 'Title/Comment entfernen — mit Backup und Integritätscheck.',
    en: 'Strip title/comment — with backup and integrity check.',
  },
  files_indexed: { de: 'Dateien erfasst', en: 'files indexed' },
  status: { de: 'Status', en: 'Status' },
  size: { de: 'Größe', en: 'Size' },
  no_preview: { de: 'Keine Vorschau im Browser möglich — bitte herunterladen.', en: 'No in-browser preview — please download.' },

  tasks_subtitle: {
    de: 'Laufende und vergangene Hintergrund-Tasks. Es läuft immer nur ein Task gleichzeitig.',
    en: 'Running and past background tasks. Only one task runs at a time.',
  },
  tasks_none: { de: 'Noch keine Tasks.', en: 'No tasks yet.' },
  tasks_section_queue: { de: 'Warteschlange', en: 'Queue' },
  tasks_section_history: { de: 'Verlauf', en: 'History' },
  tasks_queue_empty: { de: 'Keine laufenden oder gequeueten Tasks.', en: 'No running or queued tasks.' },
  enrich_errors_label: { de: 'Fehler', en: 'Errors' },
  enrich_error_unknown: { de: 'Keine Fehlermeldung.', en: 'No error message.' },
  enrich_phase_0: { de: 'Metadaten', en: 'Metadata' },
  enrich_phase_1: { de: 'Hashing', en: 'Hashing' },
  enrich_phase_2: { de: 'MD5', en: 'MD5' },
  enrich_phase_eta: { de: 'Phase ETA', en: 'Phase ETA' },
  task_cancel: { de: 'Abbrechen', en: 'Cancel' },
  task_cancelling: { de: 'Wird abgebrochen…', en: 'Cancelling…' },
  task_details: { de: 'Details', en: 'Details' },
  task_params: { de: 'Parameter', en: 'Parameters' },
  task_result: { de: 'Ergebnis', en: 'Result' },
  task_log: { de: 'Log', en: 'Log' },
  task_no_log: { de: 'Keine Log-Ausgaben.', en: 'No log output.' },
  task_started: { de: 'Gestartet', en: 'Started' },
  task_duration: { de: 'Dauer', en: 'Duration' },

  task_type_scan: { de: 'Inventur-Scan', en: 'Inventory scan' },
  task_type_dedup_rebuild: { de: 'Duplikatsuche', en: 'Duplicate scan' },
  task_type_delete: { de: 'Dateien löschen', en: 'Delete files' },

  dup_subtitle: {
    de: 'Exakte und visuell ähnliche Duplikate, gruppiert. Auswählen und löschen gibt Speicher frei.',
    en: 'Exact and visually similar duplicates, grouped. Select and delete to reclaim space.',
  },
  dup_rebuild: { de: 'Duplikate suchen', en: 'Find duplicates' },
  dup_rebuilding: { de: 'Suche läuft…', en: 'Scanning…' },
  dup_deep_enabled: { de: 'Deep-Vergleich (Video)', en: 'Deep compare (video)' },
  dup_deep_enabled_hint: {
    de: 'Vergleicht jedes noch nicht gruppierte Video mit jedem anderen (kein Vorfilter). Bei großen, überwiegend einzigartigen Bibliotheken sehr langsam — dann ausschalten. Gilt ab der nächsten Suche.',
    en: 'Compares every not-yet-grouped video against every other (no prefilter). Very slow on large, mostly-unique libraries — turn off then. Applies from the next scan.',
  },
  dup_none: { de: 'Keine Duplikate gefunden. Starte die Suche, sobald die Anreicherung läuft.', en: 'No duplicates found. Run a scan once enrichment has progressed.' },
  dup_groups_count: { de: 'Gruppen', en: 'groups' },
  dup_reclaimable: { de: 'freigebbar', en: 'reclaimable' },
  dup_kind_exact_image: { de: 'Exakt (Bild)', en: 'Exact (image)' },
  dup_kind_exact_video: { de: 'Exakt (Video)', en: 'Exact (video)' },
  dup_kind_exact_other: { de: 'Exakt (Sonstige)', en: 'Exact (other)' },
  dup_kind_visual: { de: 'Ähnliches Bild', en: 'Similar image' },
  dup_kind_video: { de: 'Ähnliches Video', en: 'Similar video' },
  dup_kind_deep: { de: 'Ähnlich (Deep)', en: 'Similar (deep)' },
  dup_keep: { de: 'Behalten', en: 'Keep' },
  dup_delete_label: { de: 'Löschen', en: 'Delete' },
  dup_duplicate_label: { de: 'Duplikat', en: 'Duplicate' },
  dup_no_preview: { de: 'Keine Vorschau', en: 'No preview' },
  dup_open_preview: { de: 'Klick: Vergleich · Mittelklick: neuer Tab', en: 'Click: compare · middle-click: new tab' },
  dup_lb_new_tab: { de: 'Neuer Tab', en: 'New tab' },
  dup_lb_hint: { de: '← → zum Wechseln · Esc schließt', en: '← → to switch · Esc closes' },
  dup_phash_dist: { de: 'pHash-Distanz', en: 'pHash distance' },
  dup_saturation: { de: 'Sättigung', en: 'Saturation' },
  dup_frames_match: { de: 'Frames gleich', en: 'frames match' },
  dup_select_others: { de: 'Alle Vorschläge selektieren', en: 'Select all suggestions' },
  dup_deselect_all: { de: 'Auswahl aufheben', en: 'Clear selection' },
  dup_selected_count: { de: 'ausgewählt', en: 'selected' },
  dup_delete: { de: 'Auswahl löschen', en: 'Delete selected' },
  dup_deleting: { de: 'Wird gelöscht…', en: 'Deleting…' },
  dup_delete_confirm: {
    de: 'Ausgewählte Dateien endgültig von der Festplatte löschen?',
    en: 'Permanently delete the selected files from disk?',
  },

  dup_ignore_group: { de: 'Gruppe ignorieren', en: 'Ignore group' },
  dup_ignore_group_undo: { de: 'Ignoriert — rückgängig', en: 'Ignored — undo' },
  dup_ignore_group_hint: {
    de: 'Diese Gruppe beim nächsten Suchlauf ignorieren. Nochmal klicken macht es rückgängig. Neue ähnliche Dateien werden weiterhin gefunden.',
    en: 'Ignore this group on the next scan. Click again to undo. New similar files will still be detected.',
  },
  dup_select_group: { de: 'Gruppe auswählen', en: 'Select group' },
  dup_ignore_selected: { de: 'Ausgewählte ignorieren', en: 'Ignore selected' },

  dup_scope_choose: { de: 'Verzeichnis wählen', en: 'Choose directory' },
  dup_scope_all: { de: 'Gesamte Bibliothek', en: 'Entire library' },
  dup_scope_label: { de: 'Bereich', en: 'Scope' },
  dup_scope_clear: { de: 'Zurücksetzen', en: 'Reset' },
  dup_tree_error: { de: 'Verzeichnis konnte nicht geladen werden.', en: 'Could not load directory.' },

  task_status_queued: { de: 'In Warteschlange', en: 'Queued' },
  task_status_running: { de: 'Läuft', en: 'Running' },
  task_status_done: { de: 'Fertig', en: 'Done' },
  task_status_error: { de: 'Fehler', en: 'Error' },
  task_status_cancelled: { de: 'Abgebrochen', en: 'Cancelled' },
  task_status_interrupted: { de: 'Unterbrochen', en: 'Interrupted' },
  task_type_rename: { de: 'Umbenennen', en: 'Rename' },
  task_type_metadata_strip: { de: 'Metadaten entfernen', en: 'Strip metadata' },
  task_type_maintenance_cleanup: { de: 'Datenbank-Cleanup', en: 'Database cleanup' },

  ren_subtitle: {
    de: 'Dateien nach den in den Einstellungen definierten Regeln umbenennen. Vorschau prüfen, dann anwenden.',
    en: 'Rename files using the rules defined in Settings. Check the preview, then apply.',
  },
  ren_refresh: { de: 'Vorschau aktualisieren', en: 'Refresh preview' },
  ren_none: { de: 'Keine Umbenennungen nötig.', en: 'No renames needed.' },
  ren_proposed_count: { de: 'Vorschläge', en: 'proposed' },
  ren_collisions: { de: 'Kollisionen', en: 'collisions' },
  ren_pending_count: { de: 'wartet auf Anreicherung', en: 'pending enrichment' },
  ren_select_all: { de: 'Alle auswählen', en: 'Select all' },
  ren_apply: { de: 'Auswahl anwenden', en: 'Apply selected' },
  ren_applying: { de: 'Wird angewendet…', en: 'Applying…' },
  ren_apply_confirm: { de: 'Ausgewählte Dateien jetzt umbenennen?', en: 'Rename the selected files now?' },
  ren_collision_badge: { de: 'Kollision', en: 'Collision' },
  ren_rule_label: { de: 'Regel', en: 'Rule' },
  ren_pending_section: { de: 'Wartet auf Anreicherung', en: 'Pending enrichment' },

  ren_rules_title: { de: 'Umbenenn-Regeln', en: 'Rename rules' },
  ren_rules_subtitle: {
    de: 'Baukasten aus Segmenten, die zu einem Dateinamen zusammengesetzt werden.',
    en: 'Building blocks that are assembled into a filename.',
  },
  ren_rules_none: { de: 'Keine Regeln angelegt.', en: 'No rules yet.' },
  ren_rule_new: { de: 'Neue Regel', en: 'New rule' },
  ren_rule_name: { de: 'Name', en: 'Name' },
  ren_rule_separator: { de: 'Trennzeichen', en: 'Separator' },
  ren_rule_edit: { de: 'Bearbeiten', en: 'Edit' },
  ren_rule_delete: { de: 'Löschen', en: 'Delete' },
  ren_rule_cancel: { de: 'Abbrechen', en: 'Cancel' },
  ren_rule_delete_confirm: {
    de: 'Regel wirklich löschen? Zuordnungen, die sie verwenden, werden mitentfernt.',
    en: 'Delete this rule? Assignments using it will be removed too.',
  },
  ren_segment_add: { de: 'Segment hinzufügen', en: 'Add segment' },
  ren_segment_literal: { de: 'Freitext', en: 'Literal text' },
  ren_segment_dirname: { de: 'Verzeichnisname', en: 'Directory name' },
  ren_segment_resolution: { de: 'Auflösung', en: 'Resolution' },
  ren_segment_duration: { de: 'Dauer', en: 'Duration' },
  ren_segment_filename: { de: 'Originaldateiname', en: 'Original filename' },
  ren_segment_level: { de: 'Ebene', en: 'Level' },
  ren_segment_text: { de: 'Text', en: 'Text' },
  ren_segment_strip_scene_tags: { de: 'Scene-Tags entfernen', en: 'Strip scene tags' },
  ren_segment_clean_special_chars: { de: 'Sonderzeichen bereinigen', en: 'Clean special characters' },
  ren_segment_remove: { de: 'Entfernen', en: 'Remove' },
  ren_segment_up: { de: 'Nach oben', en: 'Move up' },
  ren_segment_down: { de: 'Nach unten', en: 'Move down' },

  md_subtitle: {
    de: 'Videos mit eingebetteten Title-/Comment-Tags. Entfernen prüft Dauer, Stream-Anzahl und Frame-Hashes, bevor das Ergebnis übernommen wird.',
    en: 'Videos carrying embedded Title/Comment tags. Stripping verifies duration, stream count, and frame hashes before committing the result.',
  },
  md_refresh: { de: 'Liste aktualisieren', en: 'Refresh list' },
  md_candidates_count: { de: 'Kandidaten', en: 'candidates' },
  md_select_all: { de: 'Alle auswählen', en: 'Select all' },
  md_strip: { de: 'Metadaten entfernen', en: 'Strip metadata' },
  md_stripping: { de: 'Wird entfernt…', en: 'Stripping…' },
  md_strip_confirm: {
    de: 'Title-/Comment-Tags aus den ausgewählten Dateien entfernen?',
    en: 'Strip Title/Comment tags from the selected files?',
  },
  md_none: {
    de: 'Keine Kandidaten. Entweder gibt es keine Title-/Comment-Tags, oder die Anreicherung läuft noch.',
    en: 'No candidates. Either nothing carries a Title/Comment tag, or enrichment is still catching up.',
  },
  md_no_fields: {
    de: 'Felder nicht lesbar (evtl. extern bereits entfernt)',
    en: 'Fields unreadable (may already be stripped externally)',
  },
  md_history: { de: 'Verlauf', en: 'History' },
  md_status_ok: { de: 'OK', en: 'OK' },
  md_status_failed: { de: 'Fehlgeschlagen', en: 'Failed' },
  md_status_error: { de: 'Fehler', en: 'Error' },

  settings_schedule_title: { de: 'Geplanter Scan', en: 'Scheduled scan' },
  settings_schedule_enabled: { de: 'Automatischen Scan aktivieren', en: 'Enable automatic scan' },
  settings_schedule_time: { de: 'Uhrzeit', en: 'Time' },
  settings_schedule_days: { de: 'Wochentage', en: 'Days' },
  settings_schedule_local_hint: {
    de: 'Zeiten in deiner Zeitzone (Browser); intern als UTC gespeichert.',
    en: 'Times in your timezone (browser); stored internally as UTC.',
  },
  day_mon: { de: 'Mo', en: 'Mon' },
  day_tue: { de: 'Di', en: 'Tue' },
  day_wed: { de: 'Mi', en: 'Wed' },
  day_thu: { de: 'Do', en: 'Thu' },
  day_fri: { de: 'Fr', en: 'Fri' },
  day_sat: { de: 'Sa', en: 'Sat' },
  day_sun: { de: 'So', en: 'Sun' },

  settings_field_media_root: { de: 'Medienpfad', en: 'Media root' },
  settings_field_worker_count: { de: 'Enrichment-Worker', en: 'Worker count' },
  settings_field_phash_threshold: { de: 'Bild-pHash-Schwellwert (Hamming)', en: 'Image pHash threshold (Hamming)' },
  settings_field_video_frame_threshold: { de: 'Video-Frame-Schwellwert (Hamming)', en: 'Video frame threshold (Hamming)' },
  settings_field_video_min_matches: { de: 'Video min. Frame-Treffer (von 5)', en: 'Video min. frame matches (of 5)' },
  settings_field_duration_tolerance: { de: 'Dauertoleranz (s)', en: 'Duration tolerance (s)' },
  settings_field_deep_threshold: { de: 'Deep-Compare-Schwellwert (Hamming)', en: 'Deep compare threshold (Hamming)' },
  settings_field_deep_min_fraction: { de: 'Deep-Compare min. Trefferquote (0–1)', en: 'Deep compare min. match fraction (0–1)' },
  settings_field_color_threshold: { de: 'Graustufen-Schwelle (Sättigung ≤ = S/W, 0–1)', en: 'Greyscale cutoff (saturation ≤ = B/W, 0–1)' },
  settings_maintenance_title: { de: 'Datenbank-Wartung', en: 'Database maintenance' },
  maint_subtitle: {
    de: 'Prüft für jeden Datenbank-Eintrag, ob die Datei noch auf der Festplatte existiert, und entfernt fehlende Einträge endgültig aus der Datenbank.',
    en: 'Checks every database entry against disk and permanently removes the ones whose file is gone.',
  },
  maint_total_files: { de: 'Einträge gesamt', en: 'total entries' },
  maint_marked_missing: { de: 'vom letzten Scan als fehlend markiert', en: 'marked missing (last scan)' },
  maint_run_cleanup: { de: 'Cleanup ausführen', en: 'Run cleanup' },
  maint_cleaning: { de: 'Prüfe…', en: 'Checking…' },
  maint_cleanup_confirm: {
    de: 'Alle Einträge prüfen und fehlende Dateien endgültig aus der Datenbank entfernen? Das lässt sich nicht rückgängig machen.',
    en: 'Check all entries and permanently remove missing files from the database? This cannot be undone.',
  },
  maint_result_checked: { de: 'Geprüft:', en: 'Checked:' },
  maint_result_removed: { de: 'Entfernt:', en: 'Removed:' },

  maint_color_title: { de: 'Farbdaten nachberechnen', en: 'Backfill colour data' },
  maint_color_subtitle: {
    de: 'Berechnet den Farbwert (Sättigung) für Bilder, die vor Einführung dieser Funktion verarbeitet wurden — aus dem gespeicherten Vorschaubild, ohne die Originaldateien zu lesen. Nötig, damit Farb- und Schwarz-Weiß-Versionen nicht mehr als Duplikate gelten.',
    en: 'Computes the colour value (saturation) for images processed before this feature existed — from the stored thumbnail, without reading the original files. Required so colour and black-and-white versions are no longer treated as duplicates.',
  },
  maint_color_run: { de: 'Farbdaten nachberechnen', en: 'Backfill colour data' },
  maint_color_running: { de: 'Berechne…', en: 'Computing…' },
  maint_color_pending: { de: 'Bilder ohne Farbwert', en: 'images without colour value' },
  maint_color_none: { de: 'Alle Bilder haben Farbdaten.', en: 'All images have colour data.' },
  maint_color_filled: { de: 'Berechnet:', en: 'Filled:' },
  maint_color_failed: { de: 'Fehlgeschlagen:', en: 'Failed:' },

  maint_ignores_title: { de: 'Ignorierte Gruppen', en: 'Ignored groups' },
  maint_ignores_subtitle: {
    de: 'Gruppen, die du über „Gruppe ignorieren" als keine Duplikate markiert hast. Sie bleiben bei jedem Suchlauf ausgeblendet. Der Reset löscht die gesamte Ignorier-Liste — die Gruppen erscheinen beim nächsten Suchlauf wieder.',
    en: 'Groups you marked as non-duplicates via "Ignore group". They stay hidden on every scan. Reset clears the entire ignore list — those groups reappear on the next scan.',
  },
  maint_ignores_count: { de: 'ignorierte Gruppen', en: 'ignored groups' },
  maint_ignores_reset: { de: 'Ignorier-Liste zurücksetzen', en: 'Reset ignore list' },
  maint_ignores_confirm: {
    de: 'Die gesamte Ignorier-Liste löschen? Alle ignorierten Gruppen erscheinen beim nächsten Suchlauf wieder.',
    en: 'Clear the entire ignore list? All ignored groups will reappear on the next scan.',
  },

  ren_assignments_title: { de: 'Zuordnungen', en: 'Assignments' },
  ren_assignments_subtitle: {
    de: 'Eine Regel pro Verzeichnis, rekursiv — die tiefste Zuordnung gewinnt.',
    en: 'One rule per directory, recursive — the deepest assignment wins.',
  },
  ren_assignment_add: { de: 'Zuordnung hinzufügen', en: 'Add assignment' },
  ren_assignment_none: { de: 'Keine Zuordnungen.', en: 'No assignments.' },
  ren_choose_directory: { de: 'Verzeichnis wählen', en: 'Choose directory' },

  stats_subtitle: {
    de: 'Bestand, Deduplizierung und Metadaten-Bereinigung auf einen Blick.',
    en: 'Library composition, deduplication and metadata cleanup at a glance.',
  },
  stats_library_title: { de: 'Bibliothek', en: 'Library' },
  stats_files_total: { de: 'Dateien erfasst', en: 'files indexed' },
  stats_total_size: { de: 'Gesamtgröße', en: 'Total size' },
  stats_dedup_title: { de: 'Deduplizierung', en: 'Deduplication' },
  stats_dedup_removed: { de: 'Dateien entfernt', en: 'files removed' },
  stats_dedup_freed: { de: 'Speicher freigegeben', en: 'space reclaimed' },
  stats_dedup_empty: {
    de: 'Noch keine Duplikate gelöscht.',
    en: 'No duplicates deleted yet.',
  },
  stats_metadata_title: { de: 'Metadaten entfernt', en: 'Metadata stripped' },
  stats_metadata_stripped: { de: 'Dateien bereinigt', en: 'files cleaned' },
  stats_metadata_failed: { de: 'fehlgeschlagen', en: 'failed' },
  stats_metadata_errors: { de: 'Fehler', en: 'errors' },
  stats_metadata_empty: {
    de: 'Noch keine Metadaten entfernt.',
    en: 'No metadata stripped yet.',
  },
}

interface I18nCtx {
  lang: Lang
  setLang: (l: Lang) => void
  t: (key: keyof typeof STRINGS | string) => string
}

const Ctx = createContext<I18nCtx>({ lang: 'de', setLang: () => {}, t: (k) => String(k) })

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>((localStorage.getItem('lang') as Lang) || 'de')
  const setLang = (l: Lang) => {
    localStorage.setItem('lang', l)
    setLangState(l)
  }
  const t = (key: string) => STRINGS[key]?.[lang] ?? key
  return <Ctx.Provider value={{ lang, setLang, t }}>{children}</Ctx.Provider>
}

export const useI18n = () => useContext(Ctx)
