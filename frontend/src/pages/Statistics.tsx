import type { ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { LoadingPane } from '../components/ui'
import { formatSize, TYPE_ICON } from '../utils'

interface TypeBucket {
  count: number
  bytes: number
}

interface Stats {
  library: {
    total: number
    total_bytes: number
    by_type: Record<string, TypeBucket>
  }
  dedup: {
    deleted_files: number
    freed_bytes: number
  }
  metadata: {
    stripped: number
    failed: number
    errors: number
  }
}

// Fixed display order, matching the backend's bucket ordering.
const TYPE_ORDER = ['image', 'video', 'audio', 'other'] as const
const TYPE_KEY: Record<string, string> = {
  image: 'type_image',
  video: 'type_video',
  audio: 'type_audio',
  other: 'type_other',
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface-2 p-6">
      <h2 className="mb-5 font-head text-sm font-semibold uppercase tracking-widest text-ink-3">
        {title}
      </h2>
      {children}
    </section>
  )
}

function BigNumber({ value, label }: { value: string; label: string }) {
  return (
    <div>
      <div className="font-head text-[44px] font-bold leading-none tabular-nums text-ink-1">
        {value}
      </div>
      <p className="mt-2 text-sm text-ink-3">{label}</p>
    </div>
  )
}

export default function Statistics() {
  const { t } = useI18n()
  const { data, isLoading } = useQuery({
    queryKey: ['stats'],
    queryFn: () => api<Stats>('/api/stats'),
  })

  if (isLoading || !data) {
    return <LoadingPane className="h-full" />
  }

  const { library, dedup, metadata } = data

  return (
    <div>
      <p className="mb-6 text-[11px] font-semibold uppercase tracking-widest text-ink-3">
        {t('stats_subtitle')}
      </p>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Library */}
        <Card title={t('stats_library_title')}>
          <div className="flex items-end justify-between gap-4">
            <BigNumber value={library.total.toLocaleString()} label={t('stats_files_total')} />
            <div className="text-right">
              <div className="font-head text-xl font-semibold tabular-nums text-ink-1">
                {formatSize(library.total_bytes)}
              </div>
              <p className="mt-1 text-xs text-ink-3">{t('stats_total_size')}</p>
            </div>
          </div>

          <ul className="mt-6 space-y-2.5 border-t border-line pt-5">
            {TYPE_ORDER.map((type) => {
              const b = library.by_type[type] ?? { count: 0, bytes: 0 }
              return (
                <li key={type} className="flex items-center gap-3 text-sm">
                  <span className="text-base">{TYPE_ICON[type]}</span>
                  <span className="text-ink-2">{t(TYPE_KEY[type])}</span>
                  <span className="ml-auto font-mono tabular-nums text-ink-1">
                    {b.count.toLocaleString()}
                  </span>
                  <span className="w-20 text-right font-mono text-xs tabular-nums text-ink-3">
                    {formatSize(b.bytes)}
                  </span>
                </li>
              )
            })}
          </ul>
        </Card>

        {/* Deduplication */}
        <Card title={t('stats_dedup_title')}>
          {dedup.deleted_files > 0 ? (
            <div className="flex items-end justify-between gap-4">
              <BigNumber
                value={dedup.deleted_files.toLocaleString()}
                label={t('stats_dedup_removed')}
              />
              <div className="text-right">
                <div className="font-head text-xl font-semibold tabular-nums text-accent">
                  {formatSize(dedup.freed_bytes)}
                </div>
                <p className="mt-1 text-xs text-ink-3">{t('stats_dedup_freed')}</p>
              </div>
            </div>
          ) : (
            <p className="text-sm text-ink-3">{t('stats_dedup_empty')}</p>
          )}
        </Card>

        {/* Metadata */}
        <Card title={t('stats_metadata_title')}>
          {metadata.stripped + metadata.failed + metadata.errors > 0 ? (
            <div className="flex items-end justify-between gap-4">
              <BigNumber
                value={metadata.stripped.toLocaleString()}
                label={t('stats_metadata_stripped')}
              />
              {(metadata.failed > 0 || metadata.errors > 0) && (
                <div className="space-y-1 text-right text-xs text-ink-3">
                  {metadata.failed > 0 && (
                    <div>
                      <span className="font-mono tabular-nums text-ink-2">{metadata.failed}</span>{' '}
                      {t('stats_metadata_failed')}
                    </div>
                  )}
                  {metadata.errors > 0 && (
                    <div>
                      <span className="font-mono tabular-nums text-ink-2">{metadata.errors}</span>{' '}
                      {t('stats_metadata_errors')}
                    </div>
                  )}
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-ink-3">{t('stats_metadata_empty')}</p>
          )}
        </Card>
      </div>
    </div>
  )
}
