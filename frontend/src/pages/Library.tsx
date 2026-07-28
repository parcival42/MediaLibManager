import { useEffect, useMemo, useRef, useState } from 'react'
import type { SVGProps } from 'react'
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { formatSize } from '../utils'
import { Button, EmptyState, Input, PageHeader, Segmented, StatusDot } from '../components/ui'
import { IconAlert, IconScan, IconSearch, TYPE_ICON_COMP } from '../components/icons'
import MediaDetail, { type FileItem } from '../components/MediaDetail'

interface Page {
  total: number
  offset: number
  limit: number
  items: FileItem[]
}

interface Task {
  status: string
  progress: number
  result?: Record<string, number>
}

const PAGE = 100
const CARD_MIN = 200

// Fetches the thumbnail by URL (browser-cached, see /api/media/{id}/thumb)
// instead of inlining base64 into the library listing payload, and falls
// back to the type icon on 404 (no thumbnail yet / non-visual file).
function Thumb({ id, alt, icon: Icon }: { id: number; alt: string; icon: (p: SVGProps<SVGSVGElement>) => JSX.Element }) {
  const [failed, setFailed] = useState(false)
  if (failed) {
    return <Icon width={26} height={26} className="opacity-70 transition group-hover:text-accent group-hover:opacity-100" />
  }
  return (
    <img
      src={`/api/media/${id}/thumb`}
      alt={alt}
      loading="lazy"
      className="h-full w-full object-cover"
      onError={() => setFailed(true)}
    />
  )
}

export default function Library() {
  const { t } = useI18n()
  const [type, setType] = useState('')
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<FileItem | null>(null)
  const [missingOnly, setMissingOnly] = useState(false)

  useEffect(() => {
    const id = setTimeout(() => setSearch(q), 300)
    return () => clearTimeout(id)
  }, [q])

  const list = useInfiniteQuery({
    queryKey: ['library', type, search, missingOnly],
    initialPageParam: 0,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ offset: String(pageParam), limit: String(PAGE) })
      if (type) params.set('type', type)
      if (search) params.set('q', search)
      if (missingOnly) params.set('missing', 'true')
      return api<Page>(`/api/library?${params}`)
    },
    getNextPageParam: (last) => {
      const loaded = last.offset + last.items.length
      return loaded < last.total ? loaded : undefined
    },
  })

  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data])
  const total = list.data?.pages[0]?.total ?? 0

  // --- Scan trigger + progress polling ---
  const [scanTaskId, setScanTaskId] = useState<string | null>(null)
  const scanMut = useMutation({
    mutationFn: () => api<{ task_id: string }>('/api/scan', { method: 'POST', body: JSON.stringify({}) }),
    onSuccess: (data) => setScanTaskId(data.task_id),
  })
  const scanTask = useQuery<Task>({
    queryKey: ['task', scanTaskId],
    queryFn: () => api<Task>(`/api/tasks/${scanTaskId}`),
    enabled: !!scanTaskId,
    refetchInterval: (query) => {
      const s = query.state.data?.status
      return s === 'done' || s === 'error' ? false : 800
    },
  })
  const scanning = scanTask.data?.status === 'running' || scanMut.isPending
  useEffect(() => {
    if (scanTask.data?.status === 'done') list.refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scanTask.data?.status])

  // --- Virtualized grid (rows of `cols` cards) ---
  const parentRef = useRef<HTMLDivElement>(null)
  const [cols, setCols] = useState(4)
  useEffect(() => {
    const el = parentRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      // Ignore transient zero widths (e.g. while the panel is hidden) so the
      // column count never collapses to 1 and then stays there.
      const w = el.clientWidth
      if (w > 0) setCols(Math.max(1, Math.floor(w / CARD_MIN)))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const rowCount = Math.ceil(items.length / cols)
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 172,
    overscan: 6,
  })

  const virtualRows = rowVirtualizer.getVirtualItems()
  useEffect(() => {
    const last = virtualRows[virtualRows.length - 1]
    if (last && last.index >= rowCount - 3 && list.hasNextPage && !list.isFetchingNextPage) {
      list.fetchNextPage()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [virtualRows, rowCount, list.hasNextPage, list.isFetchingNextPage])

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('nav_library')}
        subtitle={`${total.toLocaleString()} ${missingOnly ? t('lib_missing_total') : t('files_total')}`}
        actions={
          <Button onClick={() => scanMut.mutate()} disabled={scanning}>
            <IconScan />
            {scanning ? `${t('scanning')} ${Math.round(scanTask.data?.progress ?? 0)}%` : t('scan')}
          </Button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Segmented
          value={type}
          onChange={setType}
          options={[
            { value: '', label: t('all_types') },
            { value: 'video', label: t('type_video') },
            { value: 'image', label: t('type_image') },
            { value: 'audio', label: t('type_audio') },
            { value: 'other', label: t('type_other') },
          ]}
        />
        <Button
          size="sm"
          variant={missingOnly ? 'danger' : 'subtle'}
          onClick={() => setMissingOnly((m) => !m)}
        >
          <IconAlert />
          {t('lib_missing_toggle')}
        </Button>
        <div className="relative ml-auto">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3">
            <IconSearch />
          </span>
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('search')}
            className="w-56 pl-9"
          />
        </div>
      </div>

      <div ref={parentRef} className="min-h-0 flex-1 overflow-auto">
        {items.length === 0 && !list.isLoading ? (
          <EmptyState text={missingOnly ? t('lib_missing_none') : t('no_files')} />
        ) : (
          <div style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualRows.map((vrow) => {
              const start = vrow.index * cols
              const rowItems = items.slice(start, start + cols)
              return (
                <div
                  key={vrow.key}
                  className="grid gap-3 pr-2"
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    height: vrow.size,
                    transform: `translateY(${vrow.start}px)`,
                    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
                  }}
                >
                  {rowItems.map((it) => {
                    const Icon = TYPE_ICON_COMP[it.type] ?? TYPE_ICON_COMP.other
                    return (
                      <button
                        key={it.id}
                        onClick={() => setSelected(it)}
                        className="group flex h-[160px] flex-col overflow-hidden rounded-2xl border border-line bg-surface-2 text-left transition hover:-translate-y-0.5 hover:border-surface-4 hover:shadow-card"
                      >
                        <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-gradient-to-br from-surface-3 to-surface-2 text-ink-3">
                          <Thumb id={it.id} alt={it.filename} icon={Icon} />
                          <span className="absolute left-2 top-2 rounded-md border border-line bg-bg/60 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-ink-2">
                            {it.type}
                          </span>
                          {missingOnly && (
                            <span className="absolute right-2 top-2 rounded-md bg-danger/80 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wide text-bg">
                              {t('lib_missing_badge')}
                            </span>
                          )}
                        </div>
                        <div className="px-3 py-2">
                          <div className="truncate text-xs font-medium text-ink-1">{it.filename}</div>
                          <div className="mt-1 flex items-center justify-between text-[11px] text-ink-3">
                            <span className="font-mono">{formatSize(it.size)}</span>
                            {missingOnly ? (
                              <span className="font-mono">
                                {it.last_seen ? new Date(it.last_seen * 1000).toLocaleDateString() : '?'}
                              </span>
                            ) : (
                              <StatusDot status={it.enrich_status ?? 'pending'} />
                            )}
                          </div>
                        </div>
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {selected && <MediaDetail item={selected} onClose={() => setSelected(null)} />}
    </div>
  )
}
