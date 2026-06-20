import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { Button, EmptyState, LoadingPane, PageHeader, Spinner } from '../components/ui'
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

interface Task {
  status: string
  progress: number
}

type FlatEntry = { kind: 'dir'; dir: string } | { kind: 'item'; item: RenameItem }

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

  const list = useQuery<PreviewResponse>({
    queryKey: ['rename-preview', scope],
    queryFn: () => api(`/api/rename/preview${scope ? `?directory=${encodeURIComponent(scope)}` : ''}`),
    refetchOnWindowFocus: false,
  })
  const renames = list.data?.renames ?? []
  const pending = list.data?.pending ?? []

  useEffect(() => {
    setSelected(new Set())
  }, [list.data])

  const grouped = useMemo(() => {
    const byDir = new Map<string, RenameItem[]>()
    for (const r of renames) {
      const arr = byDir.get(r.directory) ?? []
      arr.push(r)
      byDir.set(r.directory, arr)
    }
    return [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [renames])

  const flatList = useMemo<FlatEntry[]>(() => {
    const entries: FlatEntry[] = []
    for (const [dir, items] of grouped) {
      entries.push({ kind: 'dir', dir })
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
    setSelected(new Set(renames.map((r) => r.file_id)))
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
    list.refetch()
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
      list.refetch()
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
          <Button onClick={() => list.refetch()} disabled={list.isFetching}>
            {list.isFetching && <Spinner className="h-3.5 w-3.5" />}
            {list.isFetching ? t('ren_previewing') : t('ren_refresh')}
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
          {renames.length.toLocaleString()} {t('ren_proposed_count')}
        </span>
        {renames.some((r) => r.collision) && (
          <span className="text-warn">
            {renames.filter((r) => r.collision).length} {t('ren_collisions')}
          </span>
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

      {list.isLoading ? (
        <LoadingPane className="h-32" />
      ) : list.isError ? (
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
                      className={`truncate px-1 font-mono text-xs text-ink-3 ${vi.index === 0 ? 'pb-1' : 'pb-1 pt-4'}`}
                      title={entry.dir}
                    >
                      {entry.dir}
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
