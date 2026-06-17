/**
 * Tasks page — the serial queue's window: one running (or queued) task at a
 * time plus the persisted history. Shows status, live progress and logs, and
 * lets the user cancel anything that has not finished.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { Button, EmptyState, PageHeader } from '../components/ui'
import { IconChevron } from '../components/icons'
import { formatDuration } from '../utils'

interface Task {
  id: string
  type: string
  status: string
  progress: number
  params?: Record<string, unknown>
  result?: Record<string, unknown>
  log?: string
  created_at?: number
  started_at?: number
  ended_at?: number
}

interface EnrichStatus {
  total: number
  done: number
  error: number
  pending: number
  percent: number
  paused: boolean
  active: boolean
  current_file: string | null
  frontier_stage: number | null
  phase_done: number | null
  phase_total: number | null
  eta_seconds: number | null
}

interface ErrorFile {
  id: number
  path: string
  error: string | null
}

const ACTIVE = new Set(['queued', 'running'])

const STATUS_STYLE: Record<string, string> = {
  queued: 'text-ink-3 border-line',
  running: 'text-accent border-accent/40',
  done: 'text-accent border-accent/40',
  error: 'text-danger border-danger/40',
  cancelled: 'text-warn border-warn/40',
  interrupted: 'text-warn border-warn/40',
}

function fmtTime(ts?: number): string {
  if (!ts) return '—'
  return new Date(ts * 1000).toLocaleString()
}

function fmtElapsed(t: Task): string {
  if (!t.started_at) return '—'
  const end = t.ended_at ?? Date.now() / 1000
  return formatDuration(Math.max(0, end - t.started_at)) || '0:00'
}

function StatusPill({ status }: { status: string }) {
  const { t } = useI18n()
  const style = STATUS_STYLE[status] ?? 'text-ink-3 border-line'
  const pulsing = status === 'running'
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${style}`}
    >
      <span
        className={`h-1.5 w-1.5 rounded-full bg-current ${
          pulsing ? 'animate-pulse shadow-[0_0_8px_currentColor]' : ''
        }`}
      />
      {t(`task_status_${status}`)}
    </span>
  )
}

function TaskCard({ task }: { task: Task }) {
  const { t } = useI18n()
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)

  // Fetch the full row (incl. log) only while expanded; keep it live for an
  // active task so the log/progress refresh in place.
  const detail = useQuery<Task>({
    queryKey: ['task', task.id],
    queryFn: () => api<Task>(`/api/tasks/${task.id}`),
    enabled: open,
    refetchInterval: open && ACTIVE.has(task.status) ? 1000 : false,
  })
  const full = detail.data ?? task

  const cancel = useMutation({
    mutationFn: () => api(`/api/tasks/${task.id}/cancel`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tasks'] })
      qc.invalidateQueries({ queryKey: ['task', task.id] })
    },
  })

  const typeLabel = t(`task_type_${task.type}`)
  const cancellable = ACTIVE.has(task.status)

  return (
    <div className="rounded-2xl border border-line bg-surface-2">
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-3 text-left"
        >
          <IconChevron
            className={`shrink-0 text-ink-3 transition-transform ${open ? 'rotate-0' : '-rotate-90'}`}
          />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-ink-1">
              {typeLabel === `task_type_${task.type}` ? task.type : typeLabel}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-ink-3">
              {t('task_started')}: {fmtTime(task.started_at ?? task.created_at)} · {t('task_duration')}:{' '}
              {fmtElapsed(task)}
            </div>
          </div>
        </button>

        <StatusPill status={task.status} />

        {cancellable && (
          <Button
            variant="subtle"
            size="sm"
            onClick={() => cancel.mutate()}
            disabled={cancel.isPending || cancel.isSuccess}
          >
            {cancel.isSuccess ? t('task_cancelling') : t('task_cancel')}
          </Button>
        )}
      </div>

      {task.status === 'running' && (
        <div className="px-4 pb-3">
          <div className="flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg/70">
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{ width: `${task.progress}%` }}
              />
            </div>
            <span className="text-[11px] font-semibold tabular-nums text-ink-2">
              {Math.round(task.progress)}%
            </span>
          </div>
        </div>
      )}

      {open && (
        <div className="space-y-3 border-t border-line px-4 py-3 text-xs">
          {full.params && Object.keys(full.params).length > 0 && (
            <Detail label={t('task_params')} value={full.params} />
          )}
          {full.result && Object.keys(full.result).length > 0 && (
            <Detail label={t('task_result')} value={full.result} />
          )}
          <div>
            <div className="mb-1 font-medium text-ink-2">{t('task_log')}</div>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-bg/60 p-3 font-mono text-[11px] leading-relaxed text-ink-2">
              {full.log?.trim() || t('task_no_log')}
            </pre>
          </div>
        </div>
      )}
    </div>
  )
}

function EnrichmentBlock() {
  const { t } = useI18n()
  const [errorsOpen, setErrorsOpen] = useState(false)

  // Continuous background worker (see backend/app/enrich/worker.py) — not part
  // of the task queue, so it gets its own data source and its own card.
  const { data } = useQuery<EnrichStatus>({
    queryKey: ['enrichment', 'status'],
    queryFn: () => api<EnrichStatus>('/api/enrichment/status'),
    refetchInterval: (query) => (query.state.data?.pending ? 2000 : 15000),
  })

  const errors = useQuery<ErrorFile[]>({
    queryKey: ['enrichment', 'errors'],
    queryFn: () => api<ErrorFile[]>('/api/enrichment/errors'),
    enabled: errorsOpen,
  })

  if (!data || data.total === 0) return null

  const label = data.paused
    ? t('enrich_paused')
    : data.pending
      ? `${t('enrichment')} · ${data.pending.toLocaleString()} ${t('enrich_remaining')}`
      : t('enrich_done')

  const barColor = data.paused ? 'bg-warn' : data.pending ? 'bg-accent' : 'bg-accent/60'

  return (
    <div className="rounded-2xl border border-line bg-surface-2">
      <div className="flex items-center gap-3 px-4 py-3">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${
            data.paused
              ? 'bg-warn'
              : data.active
                ? 'animate-pulse bg-accent shadow-glow'
                : 'bg-accent/50'
          }`}
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink-1">{label}</div>
          <div className="mt-1.5 flex items-center gap-2">
            <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg/70">
              <div
                className={`h-full rounded-full transition-all ${barColor}`}
                style={{ width: `${data.percent}%` }}
              />
            </div>
            <span className="text-[11px] font-semibold tabular-nums text-ink-2">
              {Math.round(data.percent)}%
            </span>
          </div>
          {data.active && !data.paused && data.frontier_stage !== null && (
            <div className="mt-1.5 text-[11px] text-ink-3">
              <div className="flex items-baseline justify-between gap-4">
                <span className="font-medium text-ink-2">
                  Phase {data.frontier_stage + 1}/3 ({t(`enrich_phase_${data.frontier_stage}`)}).{' '}
                  Progress: {(data.phase_done ?? 0).toLocaleString()} / {(data.phase_total ?? 0).toLocaleString()}
                </span>
                {data.eta_seconds !== null && (
                  <span className="shrink-0 font-medium text-ink-2">
                    {t('enrich_phase_eta')}: {formatDuration(data.eta_seconds)}
                  </span>
                )}
              </div>
              {data.current_file && (
                <div className="mt-0.5 truncate font-mono">{data.current_file}</div>
              )}
            </div>
          )}
        </div>
      </div>

      {data.error > 0 && (
        <button
          onClick={() => setErrorsOpen((v) => !v)}
          className="flex w-full items-center gap-2 border-t border-line px-4 py-2 text-left text-xs font-medium text-danger transition hover:bg-surface-3"
        >
          <IconChevron
            className={`shrink-0 transition-transform ${errorsOpen ? 'rotate-0' : '-rotate-90'}`}
          />
          {t('enrich_errors_label')}: {data.error}
        </button>
      )}

      {errorsOpen && data.error > 0 && (
        <div className="max-h-72 space-y-1.5 overflow-auto border-t border-line px-4 py-3">
          {errors.data?.map((f) => (
            <div key={f.id} className="rounded-lg border border-line bg-bg/60 px-3 py-2 text-xs">
              <div className="truncate font-mono text-ink-2">{f.path}</div>
              <div className="mt-0.5 text-danger">{f.error || t('enrich_error_unknown')}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Detail({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <div className="mb-1 font-medium text-ink-2">{label}</div>
      <pre className="overflow-auto rounded-lg border border-line bg-bg/60 p-3 font-mono text-[11px] text-ink-2">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  )
}

export default function Tasks() {
  const { t } = useI18n()
  const { data } = useQuery<Task[]>({
    queryKey: ['tasks'],
    queryFn: () => api<Task[]>('/api/tasks'),
    // Poll briskly while anything is active, then idle back to a slow refresh.
    refetchInterval: (query) =>
      query.state.data?.some((x) => ACTIVE.has(x.status)) ? 1500 : 8000,
  })

  const running = data?.filter((x) => x.status === 'running') ?? []
  const queued = (data?.filter((x) => x.status === 'queued') ?? []).sort(
    (a, b) => (a.created_at ?? 0) - (b.created_at ?? 0),
  )
  const queue = [...running, ...queued]
  // /api/tasks is already ordered newest-first, which is what history wants.
  const history = data?.filter((x) => !ACTIVE.has(x.status)) ?? []

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t('nav_tasks')} subtitle={t('tasks_subtitle')} />

      <div className="min-h-0 flex-1 space-y-5 overflow-auto pr-1">
        <EnrichmentBlock />

        <section className="space-y-2.5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-3">
            {t('tasks_section_queue')}
          </h2>
          {queue.length === 0 ? (
            <EmptyState text={t('tasks_queue_empty')} />
          ) : (
            <div className="space-y-2.5">
              {queue.map((task) => (
                <TaskCard key={task.id} task={task} />
              ))}
            </div>
          )}
        </section>

        <section className="space-y-2.5">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-ink-3">
            {t('tasks_section_history')}
          </h2>
          {history.length === 0 ? (
            <EmptyState text={t('tasks_none')} />
          ) : (
            <div className="space-y-2.5">
              {history.map((task) => (
                <TaskCard key={task.id} task={task} />
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
