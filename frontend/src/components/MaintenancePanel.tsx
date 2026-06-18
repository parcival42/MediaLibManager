/**
 * Database maintenance. Two self-contained actions, each a serial task:
 *  - Cleanup: re-verify every `files` row against disk and remove rows whose
 *    file no longer exists.
 *  - Colour backfill: recompute the per-image `mean_saturation` from the stored
 *    thumbnail for images enriched before that column existed (so colour vs.
 *    black-and-white duplicates can be told apart). DB-only, no file access.
 * Embedded on the Settings page, mirroring RenameRulesEditor's role as a
 * self-contained settings-section component.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { Button, Card } from './ui'

interface Stats {
  total: number
  marked_missing: number
  color_backfill_pending: number
}

interface CleanupResult {
  checked: number
  removed: number
}

interface BackfillResult {
  filled: number
  failed: number
}

interface IgnoreStats {
  pairs: number
  groups: number
}

interface Task<R> {
  status: string
  progress: number
  result?: R
}

function useTaskPolling<R>(taskId: string | null, onDone: (task: Task<R> | undefined) => void) {
  const task = useQuery<Task<R>>({
    queryKey: ['task', taskId],
    queryFn: () => api<Task<R>>(`/api/tasks/${taskId}`),
    enabled: !!taskId,
    refetchInterval: (query) => {
      const s = query.state.data?.status
      return s && s !== 'running' && s !== 'queued' ? false : 800
    },
  })
  useEffect(() => {
    const s = task.data?.status
    if (s && s !== 'running' && s !== 'queued') onDone(task.data)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.data?.status])
  return task
}

export default function MaintenancePanel() {
  const { t } = useI18n()
  const stats = useQuery<Stats>({
    queryKey: ['maintenance-stats'],
    queryFn: () => api('/api/maintenance/stats'),
  })

  // Cleanup task.
  const [cleanupTaskId, setCleanupTaskId] = useState<string | null>(null)
  const [cleanupResult, setCleanupResult] = useState<CleanupResult | null>(null)
  const cleanupMut = useMutation({
    mutationFn: () => api<{ task_id: string }>('/api/maintenance/cleanup', { method: 'POST' }),
    onSuccess: (d) => {
      setCleanupResult(null)
      setCleanupTaskId(d.task_id)
    },
  })
  const cleanupTask = useTaskPolling<CleanupResult>(cleanupTaskId, (finished) => {
    if (finished?.result) setCleanupResult(finished.result)
    stats.refetch()
    setCleanupTaskId(null)
  })
  const cleaning = cleanupMut.isPending || cleanupTask.data?.status === 'running'

  const onCleanup = () => {
    if (!window.confirm(t('maint_cleanup_confirm'))) return
    cleanupMut.mutate()
  }

  // Colour backfill task.
  const [backfillTaskId, setBackfillTaskId] = useState<string | null>(null)
  const [backfillResult, setBackfillResult] = useState<BackfillResult | null>(null)
  const backfillMut = useMutation({
    mutationFn: () => api<{ task_id: string }>('/api/maintenance/color-backfill', { method: 'POST' }),
    onSuccess: (d) => {
      setBackfillResult(null)
      setBackfillTaskId(d.task_id)
    },
  })
  const backfillTask = useTaskPolling<BackfillResult>(backfillTaskId, (finished) => {
    if (finished?.result) setBackfillResult(finished.result)
    stats.refetch()
    setBackfillTaskId(null)
  })
  const backfilling = backfillMut.isPending || backfillTask.data?.status === 'running'
  const pending = stats.data?.color_backfill_pending ?? 0

  // Ignored duplicate groups ("Ignore group" action in the duplicates view).
  const ignores = useQuery<IgnoreStats>({
    queryKey: ['dedup-ignores'],
    queryFn: () => api('/api/duplicates/ignores'),
  })
  const resetIgnoresMut = useMutation({
    mutationFn: () => api('/api/duplicates/ignores/reset', { method: 'POST' }),
    onSuccess: () => ignores.refetch(),
  })
  const ignoredGroups = ignores.data?.groups ?? 0
  const onResetIgnores = () => {
    if (!window.confirm(t('maint_ignores_confirm'))) return
    resetIgnoresMut.mutate()
  }

  return (
    <Card className="max-w-2xl p-6">
      <p className="mb-4 text-sm text-ink-3">{t('maint_subtitle')}</p>

      {stats.data && (
        <div className="mb-5 flex gap-6">
          <div>
            <div className="text-2xl font-semibold text-ink-1">{stats.data.total.toLocaleString()}</div>
            <div className="text-xs text-ink-3">{t('maint_total_files')}</div>
          </div>
          <div>
            <div className="text-2xl font-semibold text-warn">{stats.data.marked_missing.toLocaleString()}</div>
            <div className="text-xs text-ink-3">{t('maint_marked_missing')}</div>
          </div>
        </div>
      )}

      <Button onClick={onCleanup} disabled={cleaning} variant="danger">
        {cleaning
          ? `${t('maint_cleaning')} ${Math.round(cleanupTask.data?.progress ?? 0)}%`
          : t('maint_run_cleanup')}
      </Button>

      {cleanupResult && (
        <p className="mt-4 text-sm text-ink-2">
          {t('maint_result_checked')} {cleanupResult.checked.toLocaleString()} · {t('maint_result_removed')}{' '}
          {cleanupResult.removed.toLocaleString()}
        </p>
      )}

      <div className="mt-8 border-t border-line pt-6">
        <p className="mb-1 text-sm font-medium text-ink-1">{t('maint_color_title')}</p>
        <p className="mb-4 text-sm text-ink-3">{t('maint_color_subtitle')}</p>

        <div className="flex items-center gap-4">
          <Button onClick={() => backfillMut.mutate()} disabled={backfilling || pending === 0}>
            {backfilling
              ? `${t('maint_color_running')} ${Math.round(backfillTask.data?.progress ?? 0)}%`
              : t('maint_color_run')}
          </Button>
          {!backfilling && (
            <span className="text-sm text-ink-3">
              {pending > 0
                ? `${pending.toLocaleString()} ${t('maint_color_pending')}`
                : t('maint_color_none')}
            </span>
          )}
        </div>

        {backfillResult && (
          <p className="mt-4 text-sm text-ink-2">
            {t('maint_color_filled')} {backfillResult.filled.toLocaleString()}
            {backfillResult.failed > 0 ? ` · ${t('maint_color_failed')} ${backfillResult.failed.toLocaleString()}` : ''}
          </p>
        )}
      </div>

      <div className="mt-8 border-t border-line pt-6">
        <p className="mb-1 text-sm font-medium text-ink-1">{t('maint_ignores_title')}</p>
        <p className="mb-4 text-sm text-ink-3">{t('maint_ignores_subtitle')}</p>

        <div className="mb-5 flex gap-6">
          <div>
            <div className="text-2xl font-semibold text-ink-1">{ignoredGroups.toLocaleString()}</div>
            <div className="text-xs text-ink-3">{t('maint_ignores_count')}</div>
          </div>
        </div>

        <Button
          onClick={onResetIgnores}
          disabled={resetIgnoresMut.isPending || ignoredGroups === 0}
          variant="danger"
        >
          {t('maint_ignores_reset')}
        </Button>
      </div>
    </Card>
  )
}
