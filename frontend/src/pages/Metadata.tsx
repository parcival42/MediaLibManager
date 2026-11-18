import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { formatSize, formatDuration } from '../utils'
import {
  Badge,
  Button,
  EmptyState,
  LoadingPane,
  PageHeader,
  SectionTitle,
  SelectionBar,
  type Tone,
} from '../components/ui'
import { IconRefresh } from '../components/icons'
import ScopePicker from '../components/ScopePicker'
import { useTaskPolling } from '../components/TaskProgress'

interface MetaField {
  name: string
  value: string
}

interface Candidate {
  id: number
  path: string
  filename: string
  size: number
  duration?: number
  fields: MetaField[]
}

interface HistoryItem {
  id: number
  path: string
  filename: string
  modified_at: string
  duration_check: string
  phash_check: string
  status: string
  errormsg: string | null
}

const STATUS_TONE: Record<string, Tone> = {
  ok: 'accent',
  failed: 'warn',
  error: 'danger',
}

export default function Metadata() {
  const { t } = useI18n()
  const [selected, setSelected] = useState<Set<number>>(new Set())

  const [scope, setScope] = useState<string | null>(null)

  const list = useQuery<{ candidates: Candidate[] }>({
    queryKey: ['metadata-candidates', scope],
    queryFn: () => api(`/api/metadata/candidates${scope ? `?directory=${encodeURIComponent(scope)}` : ''}`),
    refetchOnWindowFocus: false,
  })
  const candidates = list.data?.candidates ?? []

  const history = useQuery<{ history: HistoryItem[] }>({
    queryKey: ['metadata-history'],
    queryFn: () => api('/api/metadata/history?limit=50'),
    refetchOnWindowFocus: false,
  })

  // Selection starts empty on every (re)load -- stripping is an explicit,
  // deliberate action, never pre-selected.
  useEffect(() => {
    setSelected(new Set())
  }, [list.data])

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const selectAll = () => setSelected(new Set(candidates.map((c) => c.id)))

  const [stripId, setStripId] = useState<string | null>(null)
  const stripMut = useMutation({
    mutationFn: (ids: number[]) =>
      api<{ task_id: string }>('/api/metadata/strip', {
        method: 'POST',
        body: JSON.stringify({ file_ids: ids }),
      }),
    onSuccess: (d) => setStripId(d.task_id),
  })
  const stripTask = useTaskPolling(stripId, () => {
    list.refetch()
    history.refetch()
    setStripId(null)
  })
  // stripId stays set until a terminal status (covers 'queued'); a poll that
  // gave up must not keep the button disabled.
  const stripping = stripMut.isPending || (stripId !== null && !stripTask.isError)

  const onStrip = () => {
    if (!selected.size) return
    if (!window.confirm(t('md_strip_confirm'))) return
    stripMut.mutate([...selected])
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('nav_metadata')}
        subtitle={t('md_subtitle')}
        actions={
          <Button variant="subtle" onClick={() => list.refetch()} disabled={list.isFetching}>
            <IconRefresh />
            {t('md_refresh')}
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <ScopePicker value={scope} onChange={setScope} />
      </div>

      <SelectionBar
        summary={
          <span>
            {candidates.length.toLocaleString()} {t('md_candidates_count')}
          </span>
        }
        actions={
          <>
            <Button size="sm" variant="subtle" onClick={selectAll} disabled={candidates.length === 0}>
              {t('md_select_all')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
              {t('dup_deselect_all')}
            </Button>
            <Button size="sm" onClick={onStrip} disabled={stripping || selected.size === 0}>
              {stripping
                ? `${t('md_stripping')} ${Math.round(stripTask.data?.progress ?? 0)}%`
                : `${t('md_strip')} (${selected.size})`}
            </Button>
          </>
        }
      />

      {list.isLoading ? (
        <LoadingPane />
      ) : candidates.length === 0 ? (
        <EmptyState text={t('md_none')} />
      ) : (
        <div className="min-h-0 flex-1 space-y-1 overflow-auto pr-1">
          {candidates.map((c) => (
            <label
              key={c.id}
              className="flex cursor-pointer items-start gap-3 rounded-lg px-2.5 py-2 text-sm transition hover:bg-white/5"
            >
              <input
                type="checkbox"
                checked={selected.has(c.id)}
                onChange={() => toggle(c.id)}
                className="mt-0.5 h-4 w-4 shrink-0"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-ink-1" title={c.path}>
                    {c.filename}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-ink-3">
                    {c.duration ? formatDuration(c.duration) : '?'} · {formatSize(c.size)}
                  </span>
                </div>
                {c.fields.length > 0 ? (
                  <div className="mt-1 space-y-0.5">
                    {c.fields.map((f) => (
                      <div key={f.name} className="flex gap-2 text-xs">
                        <span className="shrink-0 font-medium text-ink-3">{f.name}</span>
                        <span className="min-w-0 flex-1 truncate text-ink-2" title={f.value}>
                          {f.value}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-1 text-xs italic text-ink-3">{t('md_no_fields')}</div>
                )}
              </div>
            </label>
          ))}
        </div>
      )}

      {(history.data?.history.length ?? 0) > 0 && (
        <div className="mt-4 max-h-44 shrink-0 overflow-auto border-t border-line pt-3 pr-1">
          <SectionTitle title={t('md_history')} size="sm" />
          <div className="space-y-1.5 text-xs">
            {history.data!.history.map((h) => (
              <div key={h.id} className="flex items-center gap-2 text-ink-3">
                <Badge tone={STATUS_TONE[h.status] ?? 'neutral'} className="w-24 justify-center">
                  {t(`md_status_${h.status}`)}
                </Badge>
                <span className="min-w-0 flex-1 truncate" title={h.path}>
                  {h.filename}
                </span>
                {h.errormsg && (
                  <span className="shrink-0 truncate text-danger" title={h.errormsg}>
                    {h.errormsg}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
