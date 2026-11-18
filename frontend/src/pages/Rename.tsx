import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import {
  Badge,
  Button,
  EmptyState,
  Input,
  LoadingPane,
  PageHeader,
  Segmented,
  SelectionBar,
  Spinner,
  Toggle,
} from '../components/ui'
import { IconEdit, IconRefresh } from '../components/icons'
import ScopePicker from '../components/ScopePicker'
import { TaskProgressPanel, useTaskPolling } from '../components/TaskProgress'
import { previewResultKey, usePreviewTask } from '../components/usePreviewTask'
import QuickRename from '../components/QuickRename'

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

interface ApplyResult {
  renamed: number
  skipped: number
  errors: number
  renamed_ids: number[]
}

type FlatEntry = { kind: 'dir'; dir: string; items: RenameItem[] } | { kind: 'item'; item: RenameItem }

type RenameTab = 'rules' | 'quick'

export default function Rename() {
  const { t } = useI18n()
  const [tab, setTab] = useState<RenameTab>('rules')
  const tabs = (
    <Segmented<RenameTab>
      value={tab}
      onChange={setTab}
      options={[
        { value: 'rules', label: t('ren_tab_rules') },
        { value: 'quick', label: t('ren_tab_quick') },
      ]}
    />
  )
  return tab === 'rules' ? <RuleRename tabs={tabs} /> : <QuickRename tabs={tabs} />
}

function RuleRename({ tabs }: { tabs: ReactNode }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [selected, setSelected] = useState<Set<number>>(new Set())

  const [scope, setScope] = useState<string | null>(null)

  const [onlyCollisions, setOnlyCollisions] = useState(false)

  // Preview runs through the task queue (same as apply) so a large library
  // reports live progress instead of leaving a single long request with no
  // feedback beyond a spinner on the button. Only the counts go into the
  // task's own result (see backend/app/rename/engine.py) — the full list is
  // fetched separately once the task is done, so a few thousand renames
  // don't end up sitting in the Tasks history's result column.
  // Selection and filter belong to the list of one specific task; reset them
  // whenever the shown task changes -- including when the server hands back
  // an already finished cached preview for a scope, where no status
  // transition would otherwise signal the switch.
  const preview = usePreviewTask<PreviewResponse>({
    onNewTask: () => {
      setSelected(new Set())
      setOnlyCollisions(false)
    },
  })
  const previewTaskId = preview.taskId
  const previewBusy = preview.busy
  const previewFailed = preview.failed

  // A preview is only ever computed on explicit request (the create/refresh
  // button, or after an apply / manual rename). Page open and scope switch
  // merely look up a still-valid cached preview for the scope (see backend's
  // engine.find_recent_preview) and show it; without one the page waits for
  // the button instead of occupying the task queue unasked.
  const lookupSeq = useRef(0)
  const [lookingUp, setLookingUp] = useState(true)

  const refreshPreview = () => {
    lookupSeq.current++ // a cache lookup still in flight must not replace this run
    setLookingUp(false)
    const params = new URLSearchParams({ force: 'true' })
    if (scope) params.set('directory', scope)
    preview.start(() => api<{ task_id: string }>(`/api/rename/preview?${params}`, { method: 'POST' }))
  }

  useEffect(() => {
    const my = ++lookupSeq.current
    setLookingUp(true)
    const qs = scope ? `?directory=${encodeURIComponent(scope)}` : ''
    api<{ task_id: string | null }>(`/api/rename/preview/recent${qs}`)
      .then((d) => {
        if (my === lookupSeq.current) preview.show(d.task_id)
      })
      .catch(() => {
        if (my === lookupSeq.current) preview.show(null)
      })
      .finally(() => {
        if (my === lookupSeq.current) setLookingUp(false)
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope])

  const previewData = preview.result.data
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
  const applyTask = useTaskPolling<ApplyResult>(applyId, (data) => {
    // A cancelled or errored run never gets a `result` (only 'done' tasks do)
    // — some files may still have been renamed before that happened, so fall
    // back to a real recompute rather than leaving them listed as pending.
    if (data?.status !== 'done' || !data.result) {
      refreshPreview()
      setApplyId(null)
      return
    }
    // Otherwise, patch the already-shown list locally instead of re-running
    // the whole scope's preview: apply already recomputes each target fresh
    // from the DB, so the remaining candidates' data didn't change — only
    // these ids did. `renamed_ids` (not just the original selection) since a
    // file can be skipped or error out and must stay listed. The one thing
    // this doesn't catch: a remaining candidate whose collision suffix was
    // only needed because one of *these* files held its plain target name —
    // that stays stale until the next real recompute (Refresh, a scan, or
    // 60 min).
    const renamedIds = data.result.renamed_ids
    if (renamedIds?.length) {
      const idSet = new Set(renamedIds)
      if (previewTaskId) {
        queryClient.setQueryData<PreviewResponse>(previewResultKey(previewTaskId), (old) =>
          old ? { ...old, renames: old.renames.filter((r) => !idSet.has(r.file_id)) } : old,
        )
      }
      // No new preview task runs now, so nothing else clears these out of the
      // selection — a skipped/errored id (still listed) stays selected on
      // purpose, so the user can see and retry it.
      setSelected((prev) => {
        const next = new Set(prev)
        idSet.forEach((id) => next.delete(id))
        return next
      })
    }
    setApplyId(null)
  })
  // applyId stays set from task creation until the poll sees a terminal
  // status, so this covers 'queued' (e.g. behind a running scan) and the
  // window before the first poll returns -- no second apply in between.
  // A poll that gave up (isError) never reaches onDone; don't stay stuck.
  const applying = applyMut.isPending || (applyId !== null && !applyTask.isError)

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
          <>
            {tabs}
            <Button onClick={refreshPreview} disabled={previewBusy || applying}>
              {previewBusy ? <Spinner className="h-3.5 w-3.5" /> : <IconRefresh />}
              {previewBusy ? t('ren_previewing') : previewData ? t('ren_refresh') : t('ren_preview_create')}
            </Button>
          </>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <ScopePicker value={scope} onChange={setScope} />
      </div>

      {previewData && (
        <SelectionBar
          summary={
            <>
              <span>
                {renames.length.toLocaleString()} {t('ren_proposed_count')}
              </span>
              {collisionCount > 0 && (
                <Toggle pressed={onlyCollisions} onChange={setOnlyCollisions} tone="warn">
                  {collisionCount} {t('ren_collisions')}
                </Toggle>
              )}
              {pending.length > 0 && (
                <span>
                  {pending.length} {t('ren_pending_count')}
                </span>
              )}
            </>
          }
          actions={
            <>
              <Button size="sm" variant="subtle" onClick={selectAll} disabled={renames.length === 0}>
                {t('ren_select_all')}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
                {t('dup_deselect_all')}
              </Button>
              <Button size="sm" onClick={onApply} disabled={applying || selected.size === 0}>
                {applying
                  ? `${t('ren_applying')} ${Math.round(applyTask.data?.progress ?? 0)}%`
                  : `${t('ren_apply')} (${selected.size})`}
              </Button>
            </>
          }
        />
      )}

      {lookingUp ? (
        <LoadingPane />
      ) : previewBusy ? (
        <div className="flex flex-1 items-center justify-center">
          <TaskProgressPanel percent={preview.percent} activity={preview.activity} />
        </div>
      ) : previewFailed ? (
        <EmptyState text={t('ren_load_error')} />
      ) : !previewData ? (
        <EmptyState text={t('ren_no_preview')} />
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
                      <Button variant="link" onClick={() => toggleGroup(entry.items)}>
                        {entry.items.every((i) => selected.has(i.file_id))
                          ? t('ren_deselect_group')
                          : t('ren_select_group')}
                      </Button>
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
                          className="mt-0.5 h-4 w-4 shrink-0"
                        />
                        <div className="min-w-0 flex-1 space-y-0.5">
                          <div className="break-all text-ink-3">
                            {entry.item.current_name}
                          </div>
                          {editingId === entry.item.file_id ? (
                            <Input
                              autoFocus
                              inputSize="sm"
                              aria-label={t('rename_placeholder')}
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
                              className="w-full"
                            />
                          ) : (
                            <div className="break-all text-ink-1">
                              {entry.item.new_name}
                            </div>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {entry.item.collision && <Badge tone="warn">{t('ren_collision_badge')}</Badge>}
                          {editingId === entry.item.file_id ? (
                            <>
                              <Button
                                size="sm"
                                onClick={(e) => {
                                  e.preventDefault()
                                  submitEdit(entry.item.file_id)
                                }}
                                disabled={manualRenameMut.isPending}
                              >
                                {t('rename_confirm')}
                              </Button>
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={(e) => {
                                  e.preventDefault()
                                  setEditingId(null)
                                }}
                              >
                                {t('rename_cancel')}
                              </Button>
                            </>
                          ) : (
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={(e) => {
                                e.preventDefault()
                                startEdit(entry.item)
                              }}
                              title={t('rename_action')}
                              aria-label={t('rename_action')}
                              className="-my-1"
                            >
                              <IconEdit />
                            </Button>
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
