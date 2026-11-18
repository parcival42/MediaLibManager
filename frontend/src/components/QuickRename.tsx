import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { Button, EmptyState, Input, PageHeader, Segmented, Spinner } from './ui'
import { IconFolder } from './icons'
import DirectoryTree from './DirectoryTree'
import { TaskProgressPanel, useTaskPolling } from './TaskProgress'

type QuickMode = 'remove' | 'replace'

/** Parameters a preview was computed with. Apply always sends this snapshot
 * (not the live form), so what gets renamed matches the list on screen even
 * if the form was edited afterwards. */
interface QuickParams {
  directory: string | null
  recursive: boolean
  terms: string[]
  mode: QuickMode
  replacement: string
}

interface QuickItem {
  file_id: number
  path: string
  directory: string
  current_name: string
  new_name: string
  collision: boolean
}

interface ApplyResult {
  renamed: number
  skipped: number
  errors: number
  renamed_ids: number[]
}

type FlatEntry = { kind: 'dir'; dir: string; items: QuickItem[] } | { kind: 'item'; item: QuickItem }

const cancelTask = (taskId: string) => {
  api(`/api/tasks/${taskId}/cancel`, { method: 'POST' }).catch(() => {})
}

export default function QuickRename({ tabs }: { tabs: ReactNode }) {
  const { t } = useI18n()

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

  const [termsText, setTermsText] = useState('')
  const [mode, setMode] = useState<QuickMode>('remove')
  const [replacement, setReplacement] = useState('')
  const [recursive, setRecursive] = useState(false)

  const formParams: QuickParams = {
    directory: scope,
    recursive,
    // Same normalization as the backend: a whitespace-only line is a literal
    // space term, anything else is trimmed.
    terms: termsText
      .split('\n')
      .map((s) => s.replace(/\r$/, ''))
      .map((s) => s.trim() || s)
      .filter((s) => s.length > 0),
    mode,
    replacement: mode === 'replace' ? replacement : '',
  }

  const [previewParams, setPreviewParams] = useState<QuickParams | null>(null)
  const [previewTaskId, setPreviewTaskId] = useState<string | null>(null)
  const previewTaskIdRef = useRef<string | null>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())

  const startPreviewMut = useMutation({
    mutationFn: (params: QuickParams) =>
      api<{ task_id: string }>('/api/rename/quick/preview', {
        method: 'POST',
        body: JSON.stringify(params),
      }),
  })
  const runPreview = (params: QuickParams) => {
    const previous = previewTaskIdRef.current
    startPreviewMut.mutate(params, {
      onSuccess: (d) => {
        previewTaskIdRef.current = d.task_id
        setPreviewTaskId(d.task_id)
        setPreviewParams(params)
      },
    })
    if (previous) cancelTask(previous)
  }
  useEffect(() => {
    return () => {
      if (previewTaskIdRef.current) cancelTask(previewTaskIdRef.current)
    }
  }, [])

  const previewTask = useTaskPolling(previewTaskId, () => setSelected(new Set()))
  const previewStatus = previewTask.data?.status
  const resultQuery = useQuery<{ renames: QuickItem[] }>({
    queryKey: ['rename-quick-result', previewTaskId],
    queryFn: () => api<{ renames: QuickItem[] }>(`/api/rename/preview/${previewTaskId}`),
    enabled: !!previewTaskId && previewStatus === 'done',
    staleTime: Infinity,
  })

  const previewBusy =
    startPreviewMut.isPending ||
    (!!previewTaskId && previewStatus === undefined && !previewTask.isError) ||
    previewStatus === 'queued' ||
    previewStatus === 'running' ||
    (previewStatus === 'done' && resultQuery.isLoading)
  const previewFailed =
    previewTask.isError ||
    previewStatus === 'error' ||
    previewStatus === 'cancelled' ||
    previewStatus === 'interrupted' ||
    resultQuery.isError
  const previewActivity =
    previewStatus === 'queued'
      ? t('ren_preview_queued')
      : previewTask.data?.log?.trim().split('\n').pop() || t('ren_previewing')

  const renames = resultQuery.data?.renames ?? []
  const collisionCount = useMemo(() => renames.filter((r) => r.collision).length, [renames])
  const formChanged = !!previewParams && JSON.stringify(formParams) !== JSON.stringify(previewParams)

  const flatList = useMemo<FlatEntry[]>(() => {
    const byDir = new Map<string, QuickItem[]>()
    for (const r of renames) {
      const arr = byDir.get(r.directory) ?? []
      arr.push(r)
      byDir.set(r.directory, arr)
    }
    const entries: FlatEntry[] = []
    for (const [dir, items] of [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      entries.push({ kind: 'dir', dir, items })
      for (const item of items) entries.push({ kind: 'item', item })
    }
    return entries
  }, [renames])

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const toggleGroup = (items: QuickItem[]) => {
    const ids = items.map((i) => i.file_id)
    setSelected((prev) => {
      const next = new Set(prev)
      const allSelected = ids.every((id) => next.has(id))
      for (const id of ids) {
        if (allSelected) next.delete(id)
        else next.add(id)
      }
      return next
    })
  }

  const [applyId, setApplyId] = useState<string | null>(null)
  const applyMut = useMutation({
    mutationFn: ({ params, ids }: { params: QuickParams; ids: number[] }) =>
      api<{ task_id: string }>('/api/rename/quick/apply', {
        method: 'POST',
        body: JSON.stringify({ ...params, file_ids: ids }),
      }),
    onSuccess: (d) => setApplyId(d.task_id),
  })
  const applyTask = useTaskPolling<ApplyResult>(applyId, () => {
    // Recompute with the same parameters: renamed files drop out, skipped or
    // failed ones stay listed so they can be retried.
    setApplyId(null)
    if (previewParams) runPreview(previewParams)
  })
  const applying = applyMut.isPending || applyTask.data?.status === 'running' || applyTask.data?.status === 'queued'

  const onApply = () => {
    if (!selected.size || !previewParams) return
    if (!window.confirm(t('ren_apply_confirm'))) return
    applyMut.mutate({ params: previewParams, ids: [...selected] })
  }

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: flatList.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (flatList[i].kind === 'dir' ? 36 : 60),
    overscan: 8,
  })

  const canPreview = formParams.terms.length > 0 && !previewBusy && !applying

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={t('nav_rename')} subtitle={t('ren_quick_subtitle')} actions={tabs} />

      <div className="mb-4 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-ink-2">{t('ren_quick_terms')}</span>
          <textarea
            value={termsText}
            onChange={(e) => setTermsText(e.target.value)}
            rows={5}
            placeholder={t('ren_quick_terms_placeholder')}
            className="w-full resize-y rounded-xl border border-line bg-surface-3 px-3 py-2 font-mono text-xs text-ink-1 outline-none placeholder:text-ink-3"
          />
          <span className="text-xs text-ink-3">{t('ren_quick_terms_hint')}</span>
        </label>

        <div className="flex flex-col gap-3">
          <div className="relative" ref={treeRef}>
            <span className="mb-1 block text-xs font-medium text-ink-2">{t('ren_quick_directory')}</span>
            <Button size="sm" variant="subtle" onClick={() => setTreeOpen((o) => !o)}>
              <IconFolder width={15} height={15} />
              {scope ?? t('dup_scope_all')}
            </Button>
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

          <label className="flex items-center gap-2 text-sm text-ink-2">
            <input
              type="checkbox"
              checked={recursive}
              onChange={(e) => setRecursive(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            {t('ren_quick_recursive')}
          </label>

          <div className="flex flex-wrap items-center gap-3">
            <Segmented<QuickMode>
              value={mode}
              onChange={setMode}
              options={[
                { value: 'remove', label: t('ren_quick_mode_remove') },
                { value: 'replace', label: t('ren_quick_mode_replace') },
              ]}
            />
            {mode === 'replace' && (
              <Input
                value={replacement}
                onChange={(e) => setReplacement(e.target.value)}
                placeholder={t('ren_quick_replacement')}
                className="w-48"
              />
            )}
          </div>

          <div>
            <Button onClick={() => runPreview(formParams)} disabled={!canPreview}>
              {previewBusy && <Spinner className="h-3.5 w-3.5" />}
              {previewBusy ? t('ren_previewing') : t('ren_quick_preview')}
            </Button>
          </div>
          {startPreviewMut.isError && (
            <p className="text-xs text-danger">{(startPreviewMut.error as Error)?.message}</p>
          )}
        </div>
      </div>

      {resultQuery.data && !previewBusy && (
        <>
          <div className="mb-2 flex flex-wrap items-center gap-4 text-sm text-ink-3">
            <span>
              {renames.length.toLocaleString()} {t('ren_quick_affected')}
            </span>
            {collisionCount > 0 && (
              <span className="rounded-full bg-warn/15 px-2 py-0.5 text-xs font-medium text-warn">
                {collisionCount} {t('ren_collisions')}
              </span>
            )}
            {formChanged && <span className="text-xs text-warn">{t('ren_quick_stale')}</span>}
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-3">
            {renames.length > 0 && (
              <Button
                size="sm"
                variant="subtle"
                onClick={() => setSelected(new Set(renames.map((r) => r.file_id)))}
              >
                {t('ren_select_all')}
              </Button>
            )}
            {selected.size > 0 && (
              <Button size="sm" variant="subtle" onClick={() => setSelected(new Set())}>
                {t('dup_deselect_all')}
              </Button>
            )}
            {selected.size > 0 && (
              <Button size="sm" onClick={onApply} disabled={applying}>
                {applying
                  ? `${t('ren_applying')} ${Math.round(applyTask.data?.progress ?? 0)}%`
                  : `${t('ren_apply')} (${selected.size})`}
              </Button>
            )}
          </div>
        </>
      )}

      {previewBusy ? (
        <div className="flex flex-1 items-center justify-center">
          <TaskProgressPanel percent={previewTask.data?.progress ?? 0} activity={previewActivity} />
        </div>
      ) : previewFailed ? (
        <EmptyState text={t('ren_load_error')} />
      ) : !resultQuery.data ? null : renames.length === 0 ? (
        <EmptyState text={t('ren_quick_none')} />
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto pr-1">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const entry = flatList[vi.index]
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)` }}
                >
                  {entry.kind === 'dir' ? (
                    <div
                      className={`flex items-center gap-2 px-1 text-xs text-ink-3 ${vi.index === 0 ? 'pb-1' : 'pb-1 pt-4'}`}
                    >
                      <span className="min-w-0 flex-1 truncate font-mono" title={entry.dir}>
                        {entry.dir}
                      </span>
                      <button onClick={() => toggleGroup(entry.items)} className="shrink-0 text-accent hover:underline">
                        {entry.items.every((i) => selected.has(i.file_id))
                          ? t('ren_deselect_group')
                          : t('ren_select_group')}
                      </button>
                    </div>
                  ) : (
                    <label
                      className={`flex cursor-pointer items-start gap-3 rounded-lg px-2.5 py-2 text-sm transition ${
                        entry.item.collision ? 'bg-warn/[0.08]' : 'hover:bg-white/5'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(entry.item.file_id)}
                        onChange={() => toggle(entry.item.file_id)}
                        className="mt-1 h-3.5 w-3.5 shrink-0"
                      />
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="break-all text-ink-2">{entry.item.current_name}</div>
                        <div className="break-all text-ink-1">{entry.item.new_name}</div>
                      </div>
                      {entry.item.collision && (
                        <span className="shrink-0 rounded-full bg-warn/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-warn">
                          {t('ren_collision_badge')}
                        </span>
                      )}
                    </label>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
