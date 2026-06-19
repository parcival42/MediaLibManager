import { useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { Button, EmptyState, PageHeader } from '../components/ui'
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

  // Selection starts empty on every (re)load — applying a rename is an
  // explicit, deliberate action, never pre-selected.
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

  // Manual, rule-independent rename of a single row — mainly for resolving a
  // collision the rule itself can't avoid (e.g. two distinct files mapping to
  // the same target name) without waiting for the next rule run.
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

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('nav_rename')}
        subtitle={t('ren_subtitle')}
        actions={
          <Button onClick={() => list.refetch()} disabled={list.isFetching}>
            {t('ren_refresh')}
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
        <div className="grid h-32 place-items-center text-ink-3">…</div>
      ) : list.isError ? (
        <EmptyState text={t('ren_load_error')} />
      ) : renames.length === 0 ? (
        <EmptyState text={t('ren_none')} />
      ) : (
        <div className="min-h-0 flex-1 space-y-4 overflow-auto pr-1">
          {grouped.map(([dir, items]) => (
            <div key={dir} className="rounded-2xl border border-line bg-surface-2 p-4">
              <div className="mb-3 truncate font-mono text-xs text-ink-3" title={dir}>
                {dir}
              </div>
              <div className="space-y-1.5">
                {items.map((r) => (
                  <div key={r.file_id}>
                    <label
                      className={`flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-1.5 text-sm transition ${
                        r.collision ? 'bg-warn/[0.08]' : 'hover:bg-white/5'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(r.file_id)}
                        onChange={() => toggle(r.file_id)}
                        className="h-3.5 w-3.5 shrink-0"
                      />
                      <span className="min-w-0 flex-1 truncate text-ink-2" title={r.current_name}>
                        {r.current_name}
                      </span>
                      <span className="shrink-0 text-ink-3">→</span>
                      {editingId === r.file_id ? (
                        <input
                          autoFocus
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onClick={(e) => e.preventDefault()}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault()
                              submitEdit(r.file_id)
                            }
                            if (e.key === 'Escape') {
                              e.preventDefault()
                              setEditingId(null)
                            }
                          }}
                          className="min-w-0 flex-1 truncate rounded border border-line bg-surface-1 px-1.5 py-0.5 text-xs text-ink-1"
                        />
                      ) : (
                        <span className="min-w-0 flex-1 truncate font-medium text-ink-1" title={r.new_name}>
                          {r.new_name}
                        </span>
                      )}
                      <span className="flex w-24 shrink-0 justify-end">
                        {r.collision && (
                          <span className="rounded-full bg-warn/15 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-warn">
                            {t('ren_collision_badge')}
                          </span>
                        )}
                      </span>
                      {editingId === r.file_id ? (
                        <>
                          <button
                            onClick={(e) => {
                              e.preventDefault()
                              submitEdit(r.file_id)
                            }}
                            disabled={manualRenameMut.isPending}
                            className="shrink-0 text-xs text-accent hover:underline"
                          >
                            {t('rename_confirm')}
                          </button>
                          <button
                            onClick={(e) => {
                              e.preventDefault()
                              setEditingId(null)
                            }}
                            className="shrink-0 text-xs text-ink-3 hover:text-ink-1"
                          >
                            {t('rename_cancel')}
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={(e) => {
                            e.preventDefault()
                            startEdit(r)
                          }}
                          title={t('rename_action')}
                          className="shrink-0 text-ink-3 hover:text-ink-1"
                        >
                          ✎
                        </button>
                      )}
                    </label>
                    {editingId === r.file_id && manualRenameMut.isError && (
                      <p className="px-2.5 pb-1 text-xs text-danger">
                        {(manualRenameMut.error as Error)?.message}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
