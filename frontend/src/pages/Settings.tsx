import { useEffect, useState, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { Button, Card, Input, PageHeader } from '../components/ui'
import RenameRulesEditor from '../components/RenameRulesEditor'
import MaintenancePanel from '../components/MaintenancePanel'

type Settings = Record<string, string | number | boolean | number[]>
type SectionKey = 'library' | 'duplicates' | 'rename' | 'metadata' | 'maintenance'

const SECTIONS: { key: SectionKey; labelKey: string }[] = [
  { key: 'library', labelKey: 'nav_library' },
  { key: 'duplicates', labelKey: 'nav_duplicates' },
  { key: 'rename', labelKey: 'nav_rename' },
  { key: 'metadata', labelKey: 'nav_metadata' },
  { key: 'maintenance', labelKey: 'settings_maintenance_title' },
]

// Labels for the known settings keys (mirrors backend config.DEFAULTS), grouped
// by the main-function area they configure.
const LIBRARY_FIELDS: { key: string; labelKey: string }[] = [
  { key: 'media_root', labelKey: 'settings_field_media_root' },
  { key: 'worker_count', labelKey: 'settings_field_worker_count' },
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
  let hours = 0
  let minutes = 0
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
      <p className="text-xs text-ink-3">{t('settings_schedule_local_hint')}</p>
    </div>
  )
}

const DUPLICATE_FIELDS: { key: string; labelKey: string }[] = [
  { key: 'phash_threshold', labelKey: 'settings_field_phash_threshold' },
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
  children,
}: {
  fields: { key: string; labelKey: string }[]
  form: Settings
  setForm: (f: Settings) => void
  onSave: (e: React.FormEvent) => void
  busy: boolean
  saved: boolean
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

  const save = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setSaved(false)
    // Coerce non-string fields back to numbers before sending.
    const payload: Settings = {}
    for (const f of ALL_FIELDS) {
      const v = form[f.key]
      payload[f.key] = f.key === 'media_root' ? String(v ?? '') : Number(v)
    }
    payload.scan_schedule_enabled = Boolean(form.scan_schedule_enabled)
    payload.scan_schedule_time = String(form.scan_schedule_time ?? '03:00')
    payload.scan_schedule_days = Array.isArray(form.scan_schedule_days) ? form.scan_schedule_days : []
    const updated = await api<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(payload) })
    setForm(updated)
    setSaved(true)
    setBusy(false)
  }

  const selectSection = (key: SectionKey) => {
    setSaved(false)
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
            >
              <ScheduleFields form={form} setForm={setForm} />
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
            />
          )}
          {section === 'rename' && <RenameRulesEditor />}
          {section === 'metadata' && (
            <p className="text-sm text-ink-3">{t('settings_metadata_empty')}</p>
          )}
          {section === 'maintenance' && <MaintenancePanel />}
        </div>
      </div>
    </div>
  )
}
