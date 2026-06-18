import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { formatSize, formatDuration } from '../utils'
import { Button, EmptyState, PageHeader } from '../components/ui'
import { IconFolder } from '../components/icons'
import DirectoryTree from '../components/DirectoryTree'

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

interface Task {
  status: string
  progress: number
}

/** Poll a task until it reaches a terminal state, then fire `onDone` once. */
function useTaskPolling(taskId: string | null, onDone: () => void) {
  const task = useQuery<Task>({
    queryKey: ['task', taskId],
    queryFn: () => api<Task>(`/api/tasks/${taskId}`),
    enabled: !!taskId,
    refetchInterval: (query) => {
      const s = query.state.data?.status
      return s && s !== 'running' && s !== 'queued' ? false : 800
    },
  })
  useEffect(() => {
    const s = task.data?.status
    if (s && s !== 'running' && s !== 'queued') onDone()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.data?.status])
  return task
}

const STATUS_BADGE: Record<string, string> = {
  ok: 'bg-ok/15 text-ok',
  failed: 'bg-warn/15 text-warn',
  error: 'bg-danger/15 text-danger',
}

export default function Metadata() {
  const { t } = useI18n()
  const [selected, setSelected] = useState<Set<number>>(new Set())

  const [scope, setScope] = useState<string | null>(null)
  const [treeOpen, setTreeOpen] = useState(false)
  const treeRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!treeOpen) return
    const onClick = (e: globalThis.MouseEvent) => {
      if (treeRef.current && !treeRef.current.contains(e.target as Node)) setTreeOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [treeOpen])

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
  const stripping = stripMut.isPending || stripTask.data?.status === 'running'

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
          <Button onClick={() => list.refetch()} disabled={list.isFetching}>
            {t('md_refresh')}
          </Button>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="relative" ref={treeRef}>
          <Button size="sm" variant="subtle" onClick={() => setTreeOpen((o) => !o)}>
            <IconFolder width={15} height={15} />
            {scope ?? t('dup_scope_all')}
          </Button>
          {scope && (
            <button
              onClick={() => setScope(null)}
              title={t('dup_scope_clear')}
              className="ml-1.5 text-xs text-ink-3 hover:text-ink-1"
            >
              ✕
            </button>
          )}
          {treeOpen && (
            <div className="absolute left-0 top-full z-20 mt-2 max-h-80 w-80 overflow-auto rounded-xl border border-line bg-surface-2 p-2 shadow-card">
              <DirectoryTree
                value={scope}
                onSelect={(p) => {
                  setScope(p)
                  setTreeOpen(false)
                }}
              />
            </div>
          )}
        </div>
      </div>

      <div className="mb-2 flex items-center gap-4 text-sm text-ink-3">
        <span>
          {candidates.length.toLocaleString()} {t('md_candidates_count')}
        </span>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        {candidates.length > 0 && (
          <Button size="sm" variant="subtle" onClick={selectAll}>
            {t('md_select_all')}
          </Button>
        )}
        {selected.size > 0 && (
          <Button size="sm" variant="subtle" onClick={() => setSelected(new Set())}>
            {t('dup_deselect_all')}
          </Button>
        )}
        {selected.size > 0 && (
          <Button size="sm" onClick={onStrip} disabled={stripping}>
            {stripping
              ? `${t('md_stripping')} ${Math.round(stripTask.data?.progress ?? 0)}%`
              : `${t('md_strip')} (${selected.size})`}
          </Button>
        )}
      </div>

      {candidates.length === 0 && !list.isLoading ? (
        <EmptyState text={t('md_none')} />
      ) : (
        <div className="min-h-0 flex-1 space-y-1.5 overflow-auto pr-1">
          {candidates.map((c) => (
            <label
              key={c.id}
              className="flex cursor-pointer items-start gap-3 rounded-lg px-2.5 py-1.5 text-sm hover:bg-white/5"
            >
              <input
                type="checkbox"
                checked={selected.has(c.id)}
                onChange={() => toggle(c.id)}
                className="mt-1 h-3.5 w-3.5 shrink-0"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-3">
                  <span className="min-w-0 flex-1 truncate text-ink-1" title={c.path}>
                    {c.filename}
                  </span>
                  <span className="shrink-0 font-mono text-xs text-ink-3">
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
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-3">
            {t('md_history')}
          </div>
          <div className="space-y-1 text-xs">
            {history.data!.history.map((h) => (
              <div key={h.id} className="flex items-center gap-2 text-ink-3">
                <span
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                    STATUS_BADGE[h.status] ?? 'bg-white/5 text-ink-3'
                  }`}
                >
                  {t(`md_status_${h.status}`)}
                </span>
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
