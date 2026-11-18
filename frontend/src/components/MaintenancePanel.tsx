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
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { Button, Card, SectionTitle } from './ui'
import { useTaskPolling } from './TaskProgress'

function Stat({ value, label, warn = false }: { value: string; label: string; warn?: boolean }) {
  return (
    <div>
      <div className={`font-head text-2xl font-semibold tabular-nums ${warn ? 'text-warn' : 'text-ink-1'}`}>
        {value}
      </div>
      <div className="text-xs text-ink-3">{label}</div>
    </div>
  )
}

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
  const cleaning = cleanupMut.isPending || (cleanupTaskId !== null && !cleanupTask.isError)

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
  const backfilling = backfillMut.isPending || (backfillTaskId !== null && !backfillTask.isError)
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
      <SectionTitle title={t('settings_maintenance_title')} description={t('maint_subtitle')} className="!mb-5" />

      {stats.data && (
        <div className="mb-5 flex gap-8">
          <Stat value={stats.data.total.toLocaleString()} label={t('maint_total_files')} />
          <Stat value={stats.data.marked_missing.toLocaleString()} label={t('maint_marked_missing')} warn />
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
        <SectionTitle size="sm" title={t('maint_color_title')} description={t('maint_color_subtitle')} className="!mb-4" />

        <div className="flex items-center gap-4">
          <Button variant="subtle" onClick={() => backfillMut.mutate()} disabled={backfilling || pending === 0}>
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
        <SectionTitle size="sm" title={t('maint_ignores_title')} description={t('maint_ignores_subtitle')} className="!mb-4" />

        <div className="mb-5">
          <Stat value={ignoredGroups.toLocaleString()} label={t('maint_ignores_count')} />
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
