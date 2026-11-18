import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Segmented,
  SelectionBar,
  Spinner,
  Textarea,
} from './ui'
import ScopePicker from './ScopePicker'
import { TaskProgressPanel, useTaskPolling } from './TaskProgress'
import { usePreviewTask } from './usePreviewTask'

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

export default function QuickRename({ tabs }: { tabs: ReactNode }) {
  const { t } = useI18n()

  const [scope, setScope] = useState<string | null>(null)

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
  const [selected, setSelected] = useState<Set<number>>(new Set())

  // Selection belongs to one specific preview list; reset on every new task.
  const preview = usePreviewTask<{ renames: QuickItem[] }>({ onNewTask: () => setSelected(new Set()) })
  const resultQuery = preview.result
  const previewBusy = preview.busy
  // A rejected start (e.g. 400 "no terms given") is shown next to the form.
  const previewFailed = preview.failed && !preview.startError

  const runPreview = (params: QuickParams) => {
    // The snapshot is what apply sends; it's only taken once this task is
    // the one being shown, so it always describes the list on screen.
    preview.start(
      () =>
        api<{ task_id: string }>('/api/rename/quick/preview', {
          method: 'POST',
          body: JSON.stringify(params),
        }),
      () => setPreviewParams(params),
    )
  }

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
  // applyId stays set until the poll sees a terminal status (covers 'queued'
  // and the window before the first poll returns); a poll that gave up
  // (isError) never reaches that, so it must not keep the button stuck.
  const applying = applyMut.isPending || (applyId !== null && !applyTask.isError)

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

      <div className="mb-6 grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Field label={t('ren_quick_terms')} hint={t('ren_quick_terms_hint')}>
          <Textarea
            value={termsText}
            onChange={(e) => setTermsText(e.target.value)}
            rows={5}
            placeholder={t('ren_quick_terms_placeholder')}
          />
        </Field>

        <div className="flex flex-col gap-4">
          <Field as="div" label={t('ren_quick_directory')}>
            <ScopePicker value={scope} onChange={setScope} />
          </Field>

          <Checkbox checked={recursive} onChange={setRecursive} label={t('ren_quick_recursive')} />

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
                aria-label={t('ren_quick_replacement')}
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
          {preview.startError && (
            <p className="text-xs text-danger">{preview.startError.message}</p>
          )}
        </div>
      </div>

      {resultQuery.data && !previewBusy && (
        <SelectionBar
          summary={
            <>
              <span>
                {renames.length.toLocaleString()} {t('ren_quick_affected')}
              </span>
              {collisionCount > 0 && (
                <Badge tone="warn">
                  {collisionCount} {t('ren_collisions')}
                </Badge>
              )}
              {formChanged && <span className="text-xs text-warn">{t('ren_quick_stale')}</span>}
            </>
          }
          actions={
            <>
              <Button
                size="sm"
                variant="subtle"
                onClick={() => setSelected(new Set(renames.map((r) => r.file_id)))}
                disabled={renames.length === 0}
              >
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

      {previewBusy ? (
        <div className="flex flex-1 items-center justify-center">
          <TaskProgressPanel percent={preview.percent} activity={preview.activity} />
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
                      <Button variant="link" onClick={() => toggleGroup(entry.items)}>
                        {entry.items.every((i) => selected.has(i.file_id))
                          ? t('ren_deselect_group')
                          : t('ren_select_group')}
                      </Button>
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
                        className="mt-0.5 h-4 w-4 shrink-0"
                      />
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="break-all text-ink-3">{entry.item.current_name}</div>
                        <div className="break-all text-ink-1">{entry.item.new_name}</div>
                      </div>
                      {entry.item.collision && <Badge tone="warn">{t('ren_collision_badge')}</Badge>}
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
