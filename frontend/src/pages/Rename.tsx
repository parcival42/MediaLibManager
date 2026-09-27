import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { Button, EmptyState, PageHeader, Spinner } from '../components/ui'
import { IconFolder } from '../components/icons'
import DirectoryTree from '../components/DirectoryTree'

interface RenameItem {
  file_id: number
  path: string
  directory: string
  current_name: string
  new_name: string
  rule_id: number
  rule_name: string
  collision: boolean
}

interface PendingItem {
  file_id: number
  path: string
  current_name: string
  rule_name: string
}

interface PreviewResponse {
  renames: RenameItem[]
  pending: PendingItem[]
}

interface Task<R = unknown> {
  status: string
  progress: number
  result?: R
  log?: string
}

type FlatEntry = { kind: 'dir'; dir: string; items: RenameItem[] } | { kind: 'item'; item: RenameItem }

/** Poll a task until it reaches a terminal state, then fire `onDone` once. */
function useTaskPolling<R = unknown>(taskId: string | null, onDone: () => void) {
  const task = useQuery<Task<R>>({
    queryKey: ['task', taskId],
    queryFn: () => api<Task<R>>(`/api/tasks/${taskId}`),
    enabled: !!taskId,
    refetchInterval: (query) => {
      if (query.state.error) return false
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

/** Centered progress bar with the task's latest log line as the "what is it doing" caption. */
function TaskProgressPanel({ percent, activity }: { percent: number; activity: string }) {
  return (
    <div className="w-full max-w-sm text-center">
      <Spinner className="mx-auto mb-4" />
      <div className="mb-2 min-h-[1.25rem] text-sm text-ink-2">{activity}</div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg/70">
        <div
          className="h-full rounded-full bg-accent transition-all"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="mt-1.5 text-xs font-semibold tabular-nums text-ink-3">{Math.round(percent)}%</div>
    </div>
  )
}

export default function Rename() {
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

  const [onlyCollisions, setOnlyCollisions] = useState(false)

  // Preview runs through the task queue (same as apply) so a large library
  // reports live progress instead of leaving a single long request with no
  // feedback beyond a spinner on the button. Only the counts go into the
  // task's own result (see backend/app/rename/engine.py) — the full list is
  // fetched separately once the task is done, so a few thousand renames
  // don't end up sitting in the Tasks history's result column.
  const [previewTaskId, setPreviewTaskId] = useState<string | null>(null)
  const previewTaskIdRef = useRef<string | null>(null)
  const startPreviewMut = useMutation({
    mutationFn: ({ dir, force }: { dir: string | null; force: boolean }) => {
      const params = new URLSearchParams()
      if (dir) params.set('directory', dir)
      if (force) params.set('force', 'true')
      const qs = params.toString()
      return api<{ task_id: string }>(`/api/rename/preview${qs ? `?${qs}` : ''}`, { method: 'POST' })
    },
  })
  const previewTask = useTaskPolling(previewTaskId, () => {
    setSelected(new Set())
    setOnlyCollisions(false)
  })
  const previewStatus = previewTask.data?.status
  const previewResultQuery = useQuery<PreviewResponse>({
    queryKey: ['rename-preview-result', previewTaskId],
    queryFn: () => api<PreviewResponse>(`/api/rename/preview/${previewTaskId}`),
    enabled: !!previewTaskId && previewStatus === 'done',
  })

  const cancelPreviewTask = (taskId: string) => {
    api(`/api/tasks/${taskId}/cancel`, { method: 'POST' }).catch(() => {})
  }
  // Page open / scope switch (force=false) may reuse a recent-enough cached
  // preview server-side instead of recomputing (see backend's
  // engine.find_recent_preview) — opening the Rename page repeatedly on an
  // unchanged library shouldn't re-scan every file every time. The Refresh
  // button and the apply/manual-rename success paths pass force=true since a
  // stale answer there would be actively wrong, not just unnecessary work.
  // Either way, an old in-flight preview that's being replaced gets
  // cancelled — left running it would keep enrichment paused and block real
  // tasks behind it for no reason.
  const startPreview = (force: boolean) => {
    const previous = previewTaskIdRef.current
    startPreviewMut.mutate(
      { dir: scope, force },
      {
        onSuccess: (d) => {
          previewTaskIdRef.current = d.task_id
          setPreviewTaskId(d.task_id)
        },
      },
    )
    if (previous) cancelPreviewTask(previous)
  }
  const refreshPreview = () => startPreview(true)
  useEffect(() => {
    startPreview(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])
  useEffect(() => {
    return () => {
      if (previewTaskIdRef.current) cancelPreviewTask(previewTaskIdRef.current)
    }
  }, [])

  const previewStarting =
    startPreviewMut.isPending || (!!previewTaskId && previewStatus === undefined && !previewTask.isError)
  const previewBusy =
    previewStarting ||
    previewStatus === 'queued' ||
    previewStatus === 'running' ||
    (previewStatus === 'done' && previewResultQuery.isLoading)
  const previewFailed =
    startPreviewMut.isError ||
    previewTask.isError ||
    previewStatus === 'error' ||
    previewStatus === 'cancelled' ||
    previewStatus === 'interrupted' ||
    previewResultQuery.isError
  const previewActivity =
    previewStatus === 'queued'
      ? t('ren_preview_queued')
      : previewTask.data?.log?.trim().split('\n').pop() || t('ren_previewing')

  const previewData = previewResultQuery.data
  const renames = previewData?.renames ?? []
  const pending = previewData?.pending ?? []
  const collisionCount = useMemo(() => renames.filter((r) => r.collision).length, [renames])

  useEffect(() => {
    if (onlyCollisions && collisionCount === 0) setOnlyCollisions(false)
  }, [onlyCollisions, collisionCount])

  const visibleRenames = useMemo(
    () => (onlyCollisions ? renames.filter((r) => r.collision) : renames),
    [renames, onlyCollisions],
  )

  const grouped = useMemo(() => {
    const byDir = new Map<string, RenameItem[]>()
    for (const r of visibleRenames) {
      const arr = byDir.get(r.directory) ?? []
      arr.push(r)
      byDir.set(r.directory, arr)
    }
    return [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [visibleRenames])

  const flatList = useMemo<FlatEntry[]>(() => {
    const entries: FlatEntry[] = []
    for (const [dir, items] of grouped) {
      entries.push({ kind: 'dir', dir, items })
      for (const item of items) entries.push({ kind: 'item', item })
    }
    return entries
  }, [grouped])

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const selectAll = () => {
    setSelected(new Set(visibleRenames.map((r) => r.file_id)))
  }

  const toggleGroup = (items: RenameItem[]) => {
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
    mutationFn: (ids: number[]) =>
      api<{ task_id: string }>('/api/rename/apply', {
        method: 'POST',
        body: JSON.stringify({ file_ids: ids }),
      }),
    onSuccess: (d) => setApplyId(d.task_id),
  })
  const applyTask = useTaskPolling(applyId, () => {
    refreshPreview()
    setApplyId(null)
  })
  const applying = applyMut.isPending || applyTask.data?.status === 'running'

  const onApply = () => {
    if (!selected.size) return
    if (!window.confirm(t('ren_apply_confirm'))) return
    applyMut.mutate([...selected])
  }

  const [editingId, setEditingId] = useState<number | null>(null)
  const [editValue, setEditValue] = useState('')
  const manualRenameMut = useMutation({
    mutationFn: ({ id, new_name }: { id: number; new_name: string }) =>
      api(`/api/library/${id}/rename`, { method: 'POST', body: JSON.stringify({ new_name }) }),
    onSuccess: () => {
      setEditingId(null)
      refreshPreview()
    },
  })
  const startEdit = (r: RenameItem) => {
    setEditingId(r.file_id)
    setEditValue(r.new_name)
  }
  const submitEdit = (id: number) => {
    const name = editValue.trim()
    if (!name) return
    manualRenameMut.mutate({ id, new_name: name })
  }

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: flatList.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (flatList[i].kind === 'dir' ? 36 : 68),
    overscan: 8,
  })

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('nav_rename')}
        subtitle={t('ren_subtitle')}
        actions={
          <Button onClick={refreshPreview} disabled={previewBusy}>
            {previewBusy && <Spinner className="h-3.5 w-3.5" />}
            {previewBusy ? t('ren_previewing') : t('ren_refresh')}
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

      {previewData && (
        <>
          <div className="mb-2 flex items-center gap-4 text-sm text-ink-3">
            <span>
              {renames.length.toLocaleString()} {t('ren_proposed_count')}
            </span>
            {collisionCount > 0 && (
              <button
                onClick={() => setOnlyCollisions((v) => !v)}
                className={`rounded-full px-2 py-0.5 text-xs font-medium transition ${
                  onlyCollisions ? 'bg-warn text-bg' : 'bg-warn/15 text-warn hover:bg-warn/25'
                }`}
              >
                {collisionCount} {t('ren_collisions')}
              </button>
            )}
            {pending.length > 0 && (
              <span>
                {pending.length} {t('ren_pending_count')}
              </span>
            )}
          </div>

          <div className="mb-4 flex flex-wrap items-center gap-3">
            {renames.length > 0 && (
              <Button size="sm" variant="subtle" onClick={selectAll}>
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
      ) : renames.length === 0 ? (
        <EmptyState text={t('ren_none')} />
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
                  {entry.kind === 'dir' && (
                    <div
                      className={`flex items-center gap-2 px-1 text-xs text-ink-3 ${vi.index === 0 ? 'pb-1' : 'pb-1 pt-4'}`}
                    >
                      <span className="min-w-0 flex-1 truncate font-mono" title={entry.dir}>
                        {entry.dir}
                      </span>
                      <button
                        onClick={() => toggleGroup(entry.items)}
                        className="shrink-0 text-accent hover:underline"
                      >
                        {entry.items.every((i) => selected.has(i.file_id))
                          ? t('ren_deselect_group')
                          : t('ren_select_group')}
                      </button>
                    </div>
                  )}
                  {entry.kind === 'item' && (
                    <div>
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
                          <div className="break-all text-ink-2">
                            {entry.item.current_name}
                          </div>
                          {editingId === entry.item.file_id ? (
                            <input
                              autoFocus
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                              onClick={(e) => e.preventDefault()}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault()
                                  submitEdit(entry.item.file_id)
                                }
                                if (e.key === 'Escape') {
                                  e.preventDefault()
                                  setEditingId(null)
                                }
                              }}
                              className="w-full rounded border border-line bg-surface-1 px-1.5 py-0.5 text-xs text-ink-1"
                            />
                          ) : (
                            <div className="break-all text-ink-1">
                              {entry.item.new_name}
                            </div>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-2 pt-0.5">
                          {entry.item.collision && (
                            <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-warn">
                              {t('ren_collision_badge')}
                            </span>
                          )}
                          {editingId === entry.item.file_id ? (
                            <>
                              <button
                                onClick={(e) => {
                                  e.preventDefault()
                                  submitEdit(entry.item.file_id)
                                }}
                                disabled={manualRenameMut.isPending}
                                className="text-xs text-accent hover:underline"
                              >
                                {t('rename_confirm')}
                              </button>
                              <button
                                onClick={(e) => {
                                  e.preventDefault()
                                  setEditingId(null)
                                }}
                                className="text-xs text-ink-3 hover:text-ink-1"
                              >
                                {t('rename_cancel')}
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={(e) => {
                                e.preventDefault()
                                startEdit(entry.item)
                              }}
                              title={t('rename_action')}
                              className="text-ink-3 hover:text-ink-1"
                            >
                              ✎
                            </button>
                          )}
                        </div>
                      </label>
                      {editingId === entry.item.file_id && manualRenameMut.isError && (
                        <p className="px-2.5 pb-1 text-xs text-danger">
                          {(manualRenameMut.error as Error)?.message}
                        </p>
                      )}
                    </div>
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
