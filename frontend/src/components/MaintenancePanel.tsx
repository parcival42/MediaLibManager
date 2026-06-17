/**
 * Database maintenance: re-verify every `files` row against disk and remove
 * rows whose file no longer exists. Embedded on the Settings page, mirroring
 * RenameRulesEditor's role as a self-contained settings-section component.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { Button, Card } from './ui'

interface Stats {
  total: number
  marked_missing: number
}

interface CleanupResult {
  checked: number
  removed: number
}

interface Task {
  status: string
  progress: number
  result?: CleanupResult
}

function useTaskPolling(taskId: string | null, onDone: (task: Task | undefined) => void) {
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

  const [taskId, setTaskId] = useState<string | null>(null)
  const [result, setResult] = useState<CleanupResult | null>(null)
  const cleanupMut = useMutation({
    mutationFn: () => api<{ task_id: string }>('/api/maintenance/cleanup', { method: 'POST' }),
    onSuccess: (d) => {
      setResult(null)
      setTaskId(d.task_id)
    },
  })
  const task = useTaskPolling(taskId, (finished) => {
    if (finished?.result) setResult(finished.result)
    stats.refetch()
    setTaskId(null)
  })
  const running = cleanupMut.isPending || task.data?.status === 'running'

  const onCleanup = () => {
    if (!window.confirm(t('maint_cleanup_confirm'))) return
    cleanupMut.mutate()
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

      <Button onClick={onCleanup} disabled={running} variant="danger">
        {running
          ? `${t('maint_cleaning')} ${Math.round(task.data?.progress ?? 0)}%`
          : t('maint_run_cleanup')}
      </Button>

      {result && (
        <p className="mt-4 text-sm text-ink-2">
          {t('maint_result_checked')} {result.checked.toLocaleString()} · {t('maint_result_removed')}{' '}
          {result.removed.toLocaleString()}
        </p>
      )}
    </Card>
  )
}
