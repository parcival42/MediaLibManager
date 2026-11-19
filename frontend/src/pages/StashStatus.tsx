/**
 * Stash status page — the buffered Stash scan request (see backend/app/stash.py).
 * Shows which directories are waiting, when the request goes out, and the
 * outcome of the last request. The buffer is persisted by the backend, so it
 * survives restarts, and a failed request is retried.
 */
import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { Badge, Button, Card, EmptyState, LoadingPane, PageHeader, SectionTitle } from '../components/ui'
import { formatDuration } from '../utils'

export interface StashStatusData {
  enabled: boolean
  pending: boolean
  pending_count: number
  directories: string[]
  queued_at: number | null
  due_at: number | null
  last: {
    at: number
    directories: number
    ok: boolean
    job_id: string | null
    error: string | null
    options?: Record<string, boolean> | null
    retry_at?: number | null
  } | null
}

/** Readable label for a Stash scan flag (e.g. scanGenerateCovers); unknown
 * flags of newer Stash versions fall back to their raw name. */
export function stashFlagLabel(t: (key: string) => string, flag: string): string {
  const key = `stash_flag_${flag}`
  const label = t(key)
  return label === key ? flag : label
}

function fmtTime(ts?: number | null): string {
  return ts ? new Date(ts * 1000).toLocaleString() : '—'
}

export default function StashStatus() {
  const { t } = useI18n()
  const qc = useQueryClient()

  const { data, isLoading } = useQuery<StashStatusData>({
    queryKey: ['stash', 'status'],
    queryFn: () => api<StashStatusData>('/api/stash/status'),
    refetchInterval: (query) => (query.state.data?.pending ? 5000 : 15000),
  })

  const flush = useMutation({
    mutationFn: () => api<StashStatusData>('/api/stash/flush', { method: 'POST' }),
    onSuccess: (d) => qc.setQueryData(['stash', 'status'], d),
  })

  // Tick once a second for the countdown while a request is pending.
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    if (!data?.pending) return
    const id = window.setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => window.clearInterval(id)
  }, [data?.pending])

  if (isLoading || !data) return <LoadingPane className="h-full" />

  const remaining = data.due_at ? Math.max(0, data.due_at - now) : 0
  const last = data.last

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('stash_page_title')}
        subtitle={t('stash_page_subtitle')}
        actions={
          <Button
            size="sm"
            onClick={() => flush.mutate()}
            disabled={!data.pending || flush.isPending}
          >
            {t('stash_send_now')}
          </Button>
        }
      />

      <div className="min-h-0 flex-1 space-y-5 overflow-auto pr-1">
        {!data.enabled && (
          <Card className="px-4 py-3 text-sm text-ink-3">{t('stash_disabled')}</Card>
        )}

        <Card className="px-4 py-3">
          <div className="flex items-center gap-2 text-sm font-medium text-ink-1">
            {t('stash_buffer_title')}
            {data.pending ? (
              <Badge tone="warn" dot pulse>{t('stash_pending')}</Badge>
            ) : (
              <Badge>{t('stash_nothing_pending')}</Badge>
            )}
          </div>
          {data.pending && (
            <div className="mt-1.5 space-y-0.5 text-[11px] text-ink-3">
              <div>{t('stash_queued_at')}: {fmtTime(data.queued_at)}</div>
              <div>
                {t('stash_due_at')}: {fmtTime(data.due_at)}
                {remaining > 0 && ` (${t('stash_in')} ${formatDuration(remaining)})`}
              </div>
              <div>{t('stash_directories_count')}: {data.pending_count}</div>
            </div>
          )}
        </Card>

        {data.pending && (
          <section>
            <SectionTitle
              title={t('stash_directories_title')}
              description={
                data.directories.length < data.pending_count
                  ? `${data.directories.length} / ${data.pending_count}`
                  : undefined
              }
            />
            <Card className="max-h-96 overflow-auto px-4 py-3">
              <ul className="space-y-0.5 font-mono text-[11px] text-ink-2">
                {data.directories.map((d) => (
                  <li key={d} className="break-all">{d}</li>
                ))}
              </ul>
            </Card>
          </section>
        )}

        <section>
          <SectionTitle title={t('stash_last_title')} />
          {last ? (
            <Card className="px-4 py-3">
              <div className="flex items-center gap-2 text-sm font-medium text-ink-1">
                {fmtTime(last.at)}
                <Badge tone={last.ok ? 'accent' : 'danger'}>
                  {last.ok ? t('stash_last_ok') : t('stash_last_failed')}
                </Badge>
              </div>
              <div className="mt-1.5 space-y-0.5 text-[11px] text-ink-3">
                <div>{t('stash_directories_count')}: {last.directories}</div>
                {last.job_id && <div>{t('stash_job_id')}: {last.job_id}</div>}
                {last.error && <div className="text-danger">{last.error}</div>}
                {!last.ok && last.retry_at && <div>{t('stash_retry_at')}: {fmtTime(last.retry_at)}</div>}
                {last.options && (
                  <div>
                    {t('stash_options_sent')}:{' '}
                    {Object.entries(last.options)
                      .filter(([, on]) => on)
                      .map(([flag]) => stashFlagLabel(t, flag))
                      .join(', ') || t('stash_options_none')}
                  </div>
                )}
              </div>
            </Card>
          ) : (
            <EmptyState text={t('stash_last_none')} />
          )}
        </section>
      </div>
    </div>
  )
}
