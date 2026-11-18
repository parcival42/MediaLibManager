import { useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { Button, Card, Input, PageHeader } from '../components/ui'
import RenameRulesEditor from '../components/RenameRulesEditor'
import MaintenancePanel from '../components/MaintenancePanel'

type Settings = Record<string, string | number | boolean | number[]>
type SectionKey = 'library' | 'duplicates' | 'rename' | 'metadata' | 'stash' | 'maintenance'

const SECTIONS: { key: SectionKey; labelKey: string }[] = [
  { key: 'library', labelKey: 'nav_library' },
  { key: 'duplicates', labelKey: 'nav_duplicates' },
  { key: 'rename', labelKey: 'nav_rename' },
  { key: 'metadata', labelKey: 'nav_metadata' },
  { key: 'stash', labelKey: 'settings_stash_title' },
  { key: 'maintenance', labelKey: 'settings_maintenance_title' },
]

// Labels for the known settings keys (mirrors backend config.DEFAULTS), grouped
// by the main-function area they configure.
const LIBRARY_FIELDS: { key: string; labelKey: string }[] = [
  { key: 'media_root', labelKey: 'settings_field_media_root' },
  { key: 'worker_count', labelKey: 'settings_field_worker_count' },
  { key: 'task_history_retention_days', labelKey: 'settings_field_task_retention' },
  { key: 'enrich_settle_seconds', labelKey: 'settings_field_enrich_settle' },
]

const WEEKDAYS: { idx: number; key: string }[] = [
  { idx: 0, key: 'day_mon' },
  { idx: 1, key: 'day_tue' },
  { idx: 2, key: 'day_wed' },
  { idx: 3, key: 'day_thu' },
  { idx: 4, key: 'day_fri' },
  { idx: 5, key: 'day_sat' },
  { idx: 6, key: 'day_sun' },
]

// scan_schedule_time/days are stored on the backend in UTC (the container's
// local clock), since Docker containers commonly run UTC regardless of where
// the user is. The UI converts to/from the browser's timezone so the fields
// shown here match the user's wall clock. The anchor for the weekday/DST
// arithmetic is "today" rather than a fixed historical date — anchoring to a
// fixed date (e.g. a January date) would apply *that date's* DST offset
// year-round, which is wrong for roughly half the year whenever the current
// season's DST state differs from the anchor's. Anchoring to today means the
// conversion can still drift by the DST offset for occurrences on the other
// side of the next transition — an accepted rough edge for a personal scan
// schedule, not worth a full timezone-aware recurrence engine.
function utcToLocal(timeUtc: string, daysUtc: number[]): { time: string; days: number[] } {
  const [h, m] = timeUtc.split(':').map(Number)
  const today = new Date()
  const todayUtcIdx = (today.getUTCDay() + 6) % 7 // Mon=0..Sun=6
  const days = new Set<number>()
  let hours = 0
  let minutes = 0
  for (const dayUtc of daysUtc) {
    const delta = (dayUtc - todayUtcIdx + 7) % 7
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + delta, h, m))
    days.add((d.getDay() + 6) % 7)
    hours = d.getHours()
    minutes = d.getMinutes()
  }
  return { time: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`, days: [...days].sort() }
}

function localToUtc(timeLocal: string, daysLocal: number[]): { time: string; days: number[] } {
  const [h, m] = timeLocal.split(':').map(Number)
  const today = new Date()
  const todayLocalIdx = (today.getDay() + 6) % 7 // Mon=0..Sun=6
  const days = new Set<number>()
  // With no day selected, still convert the time (anchored on today) instead
  // of falling back to 00:00 and losing the configured time.
  const d0 = new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m)
  let hours = d0.getUTCHours()
  let minutes = d0.getUTCMinutes()
  for (const dayLocal of daysLocal) {
    const delta = (dayLocal - todayLocalIdx + 7) % 7
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + delta, h, m)
    days.add((d.getUTCDay() + 6) % 7)
    hours = d.getUTCHours()
    minutes = d.getUTCMinutes()
  }
  return { time: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`, days: [...days].sort() }
}

function ScheduleFields({ form, setForm }: { form: Settings; setForm: (f: Settings) => void }) {
  const { t } = useI18n()
  const enabled = Boolean(form.scan_schedule_enabled)
  const daysUtc = Array.isArray(form.scan_schedule_days) ? form.scan_schedule_days : []
  const timeUtc = String(form.scan_schedule_time ?? '03:00')
  const local = utcToLocal(timeUtc, daysUtc.length ? daysUtc : [0])
  const localDays = daysUtc.length ? local.days : []

  const setLocal = (time: string, days: number[]) => {
    const utc = localToUtc(time, days)
    setForm({ ...form, scan_schedule_time: utc.time, scan_schedule_days: utc.days })
  }

  const toggleDay = (idx: number) => {
    const next = localDays.includes(idx) ? localDays.filter((d) => d !== idx) : [...localDays, idx].sort()
    setLocal(local.time, next)
  }

  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4">
      <span className="text-xs font-medium text-ink-2">{t('settings_schedule_title')}</span>
      <label className="flex items-center gap-2 text-sm text-ink-1">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setForm({ ...form, scan_schedule_enabled: e.target.checked })}
        />
        {t('settings_schedule_enabled')}
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-ink-2">{t('settings_schedule_time')}</span>
        <Input
          type="time"
          className="w-32"
          value={local.time}
          onChange={(e) => setLocal(e.target.value, localDays)}
        />
      </label>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-ink-2">{t('settings_schedule_days')}</span>
        <div className="flex gap-1.5">
          {WEEKDAYS.map((d) => (
            <button
              key={d.idx}
              type="button"
              onClick={() => toggleDay(d.idx)}
              className={`h-8 w-10 rounded-lg text-xs font-medium transition ${
                localDays.includes(d.idx)
                  ? 'bg-gradient-to-br from-accent to-accent-2 text-bg'
                  : 'border border-line bg-surface-3 text-ink-2 hover:text-ink-1'
              }`}
            >
              {t(d.key)}
            </button>
          ))}
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm text-ink-1">
        <input
          type="checkbox"
          checked={Boolean(form.scan_schedule_cleanup_enabled)}
          onChange={(e) => setForm({ ...form, scan_schedule_cleanup_enabled: e.target.checked })}
        />
        {t('settings_schedule_cleanup_enabled')}
      </label>
      <p className="text-xs text-ink-3">{t('settings_schedule_local_hint')}</p>
    </div>
  )
}

function DirWatchFields({ form, setForm }: { form: Settings; setForm: (f: Settings) => void }) {
  const { t } = useI18n()
  const enabled = Boolean(form.dir_watch_enabled)

  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4">
      <span className="text-xs font-medium text-ink-2">{t('settings_dir_watch_title')}</span>
      <label className="flex items-center gap-2 text-sm text-ink-1">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setForm({ ...form, dir_watch_enabled: e.target.checked })}
        />
        {t('settings_dir_watch_enabled')}
      </label>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-ink-2">{t('settings_dir_watch_interval')}</span>
        <Input
          type="number"
          min={1}
          className="w-32"
          value={(form.dir_watch_interval_minutes as number) ?? 5}
          onChange={(e) => setForm({ ...form, dir_watch_interval_minutes: e.target.value })}
        />
      </label>
      <p className="text-xs text-ink-3">{t('settings_dir_watch_hint')}</p>
    </div>
  )
}

function AutoStripFields({ form, setForm }: { form: Settings; setForm: (f: Settings) => void }) {
  const { t } = useI18n()
  const enabled = Boolean(form.metadata_auto_strip_enabled)

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-2 text-sm text-ink-1">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setForm({ ...form, metadata_auto_strip_enabled: e.target.checked })}
        />
        {t('settings_auto_strip_enabled')}
      </label>
      <p className="text-xs text-ink-3">{t('settings_auto_strip_hint')}</p>
    </div>
  )
}

function StashFields({ form, setForm }: { form: Settings; setForm: (f: Settings) => void }) {
  const { t } = useI18n()
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null)

  const runTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await api<{ ok: boolean; version?: string; error?: string }>('/api/settings/stash/test', {
        method: 'POST',
        body: JSON.stringify({ url: String(form.stash_url ?? ''), api_key: String(form.stash_api_key ?? '') }),
      })
      setTestResult(
        r.ok
          ? { ok: true, text: `${t('settings_stash_test_ok')} ${r.version ?? ''}`.trim() }
          : { ok: false, text: r.error ?? t('settings_stash_test_failed') },
      )
    } catch (e) {
      setTestResult({ ok: false, text: (e as Error).message })
    } finally {
      setTesting(false)
    }
  }

  const text = (key: string, labelKey: string, props: Record<string, string> = {}) => (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-ink-2">{t(labelKey)}</span>
      <Input
        {...props}
        value={String(form[key] ?? '')}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    </label>
  )

  return (
    <div className="flex flex-col gap-4">
      <label className="flex items-center gap-2 text-sm text-ink-1">
        <input
          type="checkbox"
          checked={Boolean(form.stash_enabled)}
          onChange={(e) => setForm({ ...form, stash_enabled: e.target.checked })}
        />
        {t('settings_stash_enabled')}
      </label>
      <p className="text-xs text-ink-3">{t('settings_stash_hint')}</p>
      {text('stash_url', 'settings_stash_url', { placeholder: 'http://<stash-host>:9999' })}
      {text('stash_api_key', 'settings_stash_api_key', { type: 'password', autoComplete: 'off' })}
      {text('stash_media_path', 'settings_stash_media_path', { placeholder: '/data' })}
      <p className="-mt-2 text-xs text-ink-3">{t('settings_stash_media_path_hint')}</p>
      <label className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-ink-2">{t('settings_stash_delay')}</span>
        <Input
          type="number"
          min={0}
          className="w-32"
          value={(form.stash_scan_delay_minutes as number) ?? 5}
          onChange={(e) => setForm({ ...form, stash_scan_delay_minutes: e.target.value })}
        />
      </label>
      <p className="-mt-2 text-xs text-ink-3">{t('settings_stash_delay_hint')}</p>
      <div className="flex items-center gap-3">
        <Button type="button" size="sm" variant="subtle" onClick={runTest} disabled={testing || !form.stash_url}>
          {t('settings_stash_test')}
        </Button>
        {testResult && (
          <span className={`text-sm ${testResult.ok ? 'text-ok' : 'text-danger'}`}>{testResult.text}</span>
        )}
      </div>
    </div>
  )
}

const DUPLICATE_FIELDS: { key: string; labelKey: string }[] = [
  { key: 'phash_threshold', labelKey: 'settings_field_phash_threshold' },
  { key: 'color_threshold', labelKey: 'settings_field_color_threshold' },
  { key: 'video_frame_threshold', labelKey: 'settings_field_video_frame_threshold' },
  { key: 'video_min_matches', labelKey: 'settings_field_video_min_matches' },
  { key: 'duration_tolerance', labelKey: 'settings_field_duration_tolerance' },
  { key: 'deep_threshold', labelKey: 'settings_field_deep_threshold' },
  { key: 'deep_min_fraction', labelKey: 'settings_field_deep_min_fraction' },
]

const ALL_FIELDS = [...LIBRARY_FIELDS, ...DUPLICATE_FIELDS]

function FieldSection({
  fields,
  form,
  setForm,
  onSave,
  busy,
  saved,
  error,
  children,
}: {
  fields: { key: string; labelKey: string }[]
  form: Settings
  setForm: (f: Settings) => void
  onSave: (e: React.FormEvent) => void
  busy: boolean
  saved: boolean
  error?: string | null
  children?: ReactNode
}) {
  const { t } = useI18n()
  return (
    <Card className="max-w-2xl p-6">
      <form onSubmit={onSave} className="flex flex-col gap-4">
        {fields.map((f) => (
          <label key={f.key} className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-ink-2">{t(f.labelKey)}</span>
            <Input
              type={f.key === 'media_root' ? 'text' : 'number'}
              // Without step="any" the browser's form validation rejects
              // fractional values (0.05, 0.3, 3.0) and blocks submit entirely.
              step={f.key === 'media_root' ? undefined : 'any'}
              value={(form[f.key] as string | number) ?? ''}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
            />
          </label>
        ))}
        {children}
        <div className="mt-2 flex items-center gap-3">
          <Button type="submit" disabled={busy}>
            {t('save')}
          </Button>
          {saved && <span className="text-sm text-ok">{t('settings_saved')}</span>}
          {error && <span className="text-sm text-danger">{error}</span>}
        </div>
      </form>
    </Card>
  )
}

export default function SettingsPage() {
  const { t } = useI18n()
  const { data } = useQuery({ queryKey: ['settings'], queryFn: () => api<Settings>('/api/settings') })
  const [section, setSection] = useState<SectionKey>('library')
  const [form, setForm] = useState<Settings>({})
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (data) setForm(data)
  }, [data])

  const [saveError, setSaveError] = useState<string | null>(null)

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setSaved(false)
    setSaveError(null)
    // Coerce non-string fields back to numbers before sending. An emptied
    // number field must not silently become 0 (Number('') === 0) -- e.g. a
    // deep_min_fraction of 0 would make every video match every other one.
    const invalid: string[] = []
    const num = (key: string, labelKey: string) => {
      const raw = form[key]
      const n = raw === '' || raw === null || raw === undefined ? NaN : Number(raw)
      if (Number.isNaN(n)) invalid.push(t(labelKey))
      return n
    }
    const payload: Settings = {}
    for (const f of ALL_FIELDS) {
      payload[f.key] = f.key === 'media_root' ? String(form[f.key] ?? '') : num(f.key, f.labelKey)
    }
    payload.scan_schedule_enabled = Boolean(form.scan_schedule_enabled)
    payload.scan_schedule_time = String(form.scan_schedule_time ?? '03:00')
    payload.scan_schedule_days = Array.isArray(form.scan_schedule_days) ? form.scan_schedule_days : []
    payload.dir_watch_enabled = Boolean(form.dir_watch_enabled)
    payload.dir_watch_interval_minutes = num('dir_watch_interval_minutes', 'settings_dir_watch_interval')
    payload.scan_schedule_cleanup_enabled = Boolean(form.scan_schedule_cleanup_enabled)
    payload.metadata_auto_strip_enabled = Boolean(form.metadata_auto_strip_enabled)
    payload.stash_enabled = Boolean(form.stash_enabled)
    payload.stash_url = String(form.stash_url ?? '').trim()
    payload.stash_api_key = String(form.stash_api_key ?? '').trim()
    payload.stash_media_path = String(form.stash_media_path ?? '').trim()
    payload.stash_scan_delay_minutes = num('stash_scan_delay_minutes', 'settings_stash_delay')
    if (invalid.length) {
      setSaveError(`${t('settings_invalid_fields')}: ${invalid.join(', ')}`)
      return
    }
    setBusy(true)
    try {
      const updated = await api<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(payload) })
      setForm(updated)
      setSaved(true)
    } catch (err) {
      setSaveError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const selectSection = (key: SectionKey) => {
    setSaved(false)
    setSaveError(null)
    setSection(key)
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t('nav_settings')} />

      <div className="flex min-h-0 flex-1 gap-6">
        <nav className="w-48 shrink-0 space-y-1">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              onClick={() => selectSection(s.key)}
              className={`block w-full rounded-xl px-3.5 py-2.5 text-left text-[13.5px] font-medium transition ${
                section === s.key
                  ? 'bg-gradient-to-br from-accent to-accent-2 text-bg shadow-glow'
                  : 'text-ink-2 hover:bg-white/5 hover:text-ink-1'
              }`}
            >
              {t(s.labelKey)}
            </button>
          ))}
        </nav>

        <div className="min-h-0 flex-1 overflow-auto">
          {section === 'library' && (
            <FieldSection
              fields={LIBRARY_FIELDS}
              form={form}
              setForm={setForm}
              onSave={save}
              busy={busy}
              saved={saved}
              error={saveError}
            >
              <ScheduleFields form={form} setForm={setForm} />
              <DirWatchFields form={form} setForm={setForm} />
            </FieldSection>
          )}
          {section === 'duplicates' && (
            <FieldSection
              fields={DUPLICATE_FIELDS}
              form={form}
              setForm={setForm}
              onSave={save}
              busy={busy}
              saved={saved}
              error={saveError}
            />
          )}
          {section === 'rename' && <RenameRulesEditor />}
          {section === 'metadata' && (
            <FieldSection fields={[]} form={form} setForm={setForm} onSave={save} busy={busy} saved={saved} error={saveError}>
              <AutoStripFields form={form} setForm={setForm} />
            </FieldSection>
          )}
          {section === 'stash' && (
            <FieldSection fields={[]} form={form} setForm={setForm} onSave={save} busy={busy} saved={saved} error={saveError}>
              <StashFields form={form} setForm={setForm} />
            </FieldSection>
          )}
          {section === 'maintenance' && <MaintenancePanel />}
        </div>
      </div>
    </div>
  )
}
