import { type MouseEvent, useEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { formatSize, formatDuration } from '../utils'
import { Button, EmptyState, PageHeader, Segmented } from '../components/ui'
import { IconFolder, IconScan, TYPE_ICON_COMP } from '../components/icons'
import MediaDetail, { type FileItem } from '../components/MediaDetail'
import DirectoryTree from '../components/DirectoryTree'

interface Member {
  id: number
  path: string
  filename: string
  type: string
  size: number
  width?: number
  height?: number
  duration?: number
  codec?: string
  thumbnail_b64?: string
  is_keep: boolean
  frames?: string[]
  phash_distance?: number
  frame_distances?: (number | null)[]
  frame_matches?: boolean[]
  match_count?: number
}

interface Group {
  id: number
  kind: string
  members: Member[]
  reclaimable: number
}

interface Task {
  status: string
  progress: number
}

const KIND_LABEL: Record<string, string> = {
  exact_image: 'dup_kind_exact_image',
  exact_video: 'dup_kind_exact_video',
  exact_other: 'dup_kind_exact_other',
  visual: 'dup_kind_visual',
  video: 'dup_kind_video',
  deep: 'dup_kind_deep',
}

const FRAME_POS = ['10%', '30%', '50%', '70%', '90%']

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

export default function Duplicates() {
  const { t } = useI18n()
  const [kind, setKind] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [preview, setPreview] = useState<Member | null>(null)
  const [frameSrc, setFrameSrc] = useState<string | null>(null)

  // Directory scope: null = entire library. `pendingScope` is the tree
  // selection (applies on the next rebuild); `appliedScope` is what the
  // currently-shown results were actually scanned with.
  const [pendingScope, setPendingScope] = useState<string | null>(null)
  const [appliedScope, setAppliedScope] = useState<string | null>(null)
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

  const list = useQuery<{ groups: Group[] }>({
    queryKey: ['duplicates', kind],
    queryFn: () => api(`/api/duplicates${kind ? `?kind=${kind}` : ''}`),
    refetchOnWindowFocus: false,
  })
  const groups = list.data?.groups ?? []

  // Selection starts empty on every (re)load — never pre-select files for
  // deletion. Deleting is an explicit, deliberate action (see dup_select_others).
  useEffect(() => {
    setSelected(new Set())
  }, [list.data])

  const totalReclaimable = useMemo(
    () => groups.reduce((sum, g) => sum + g.reclaimable, 0),
    [groups],
  )

  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const selectAllButKept = () => {
    const sel = new Set<number>()
    for (const g of groups) for (const m of g.members) if (!m.is_keep) sel.add(m.id)
    setSelected(sel)
  }

  // --- Rebuild (duplicate scan) ---
  const [rebuildId, setRebuildId] = useState<string | null>(null)
  const rebuildMut = useMutation({
    mutationFn: (directory: string | null) =>
      api<{ task_id: string }>('/api/duplicates/rebuild', {
        method: 'POST',
        body: JSON.stringify({ directory }),
      }),
    onSuccess: (d, directory) => {
      setRebuildId(d.task_id)
      setAppliedScope(directory)
    },
  })
  const rebuildTask = useTaskPolling(rebuildId, () => {
    list.refetch()
    setRebuildId(null)
  })
  const rebuilding = rebuildMut.isPending || rebuildTask.data?.status === 'running'

  // Deep-compare toggle. Persisted as a setting (it governs the all-pairs video
  // pass, which is expensive on large unique libraries); changing it takes
  // effect on the next rebuild, just like the scope selector.
  const settings = useQuery<Record<string, unknown>>({
    queryKey: ['settings'],
    queryFn: () => api('/api/settings'),
    refetchOnWindowFocus: false,
  })
  const deepEnabled = settings.data?.deep_enabled !== false
  const deepMut = useMutation({
    mutationFn: (enabled: boolean) =>
      api('/api/settings', { method: 'PUT', body: JSON.stringify({ deep_enabled: enabled }) }),
    onSuccess: () => settings.refetch(),
  })

  // --- Delete selected ---
  const [deleteId, setDeleteId] = useState<string | null>(null)
  const deleteMut = useMutation({
    mutationFn: (ids: number[]) =>
      api<{ task_id: string }>('/api/delete', {
        method: 'POST',
        body: JSON.stringify({ file_ids: ids }),
      }),
    onSuccess: (d) => setDeleteId(d.task_id),
  })
  useTaskPolling(deleteId, () => {
    list.refetch()
    setDeleteId(null)
  })
  const deleting = deleteMut.isPending || !!deleteId

  const onDelete = () => {
    if (!selected.size) return
    if (!window.confirm(t('dup_delete_confirm'))) return
    deleteMut.mutate([...selected])
  }

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title={t('nav_duplicates')}
        subtitle={t('dup_subtitle')}
        actions={
          <Button onClick={() => rebuildMut.mutate(pendingScope)} disabled={rebuilding}>
            <IconScan />
            {rebuilding
              ? `${t('dup_rebuilding')} ${Math.round(rebuildTask.data?.progress ?? 0)}%`
              : t('dup_rebuild')}
          </Button>
        }
      />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="relative" ref={treeRef}>
          <Button size="sm" variant="subtle" onClick={() => setTreeOpen((o) => !o)}>
            <IconFolder width={15} height={15} />
            {pendingScope ?? t('dup_scope_all')}
          </Button>
          {pendingScope && (
            <button
              onClick={() => setPendingScope(null)}
              title={t('dup_scope_clear')}
              className="ml-1.5 text-xs text-ink-3 hover:text-ink-1"
            >
              ✕
            </button>
          )}
          {treeOpen && (
            <div className="absolute left-0 top-full z-20 mt-2 max-h-80 w-80 overflow-auto rounded-xl border border-line bg-surface-2 p-2 shadow-card">
              <DirectoryTree
                value={pendingScope}
                onSelect={(p) => {
                  setPendingScope(p)
                  setTreeOpen(false)
                }}
              />
            </div>
          )}
        </div>
        {appliedScope && (
          <span className="rounded-md border border-line bg-bg/60 px-2 py-1 text-xs text-ink-3">
            {t('dup_scope_label')}: <span className="font-mono text-ink-2">{appliedScope}</span>
          </span>
        )}
        <label
          className="ml-auto flex items-center gap-2 text-sm text-ink-2"
          title={t('dup_deep_enabled_hint')}
        >
          <input
            type="checkbox"
            checked={deepEnabled}
            disabled={deepMut.isPending || rebuilding}
            onChange={(e) => deepMut.mutate(e.target.checked)}
          />
          {t('dup_deep_enabled')}
        </label>
      </div>

      <div className="mb-3">
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: '', label: t('all_types') },
            { value: 'exact_image', label: t('dup_kind_exact_image') },
            { value: 'exact_video', label: t('dup_kind_exact_video') },
            { value: 'exact_other', label: t('dup_kind_exact_other') },
            { value: 'visual', label: t('dup_kind_visual') },
            { value: 'video', label: t('dup_kind_video') },
            { value: 'deep', label: t('dup_kind_deep') },
          ]}
        />
      </div>

      {/* Fixed position right below the type filter — never shifts when the
          selection actions below it appear/disappear. */}
      <div className="mb-2 flex items-center gap-4 text-sm text-ink-3">
        <span>
          {groups.length.toLocaleString()} {t('dup_groups_count')}
        </span>
        {totalReclaimable > 0 && (
          <span className="font-mono text-ink-2">
            {formatSize(totalReclaimable)} {t('dup_reclaimable')}
          </span>
        )}
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        {groups.length > 0 && (
          <Button size="sm" variant="subtle" onClick={selectAllButKept}>
            {t('dup_select_others')}
          </Button>
        )}
        {selected.size > 0 && (
          <Button size="sm" variant="subtle" onClick={() => setSelected(new Set())}>
            {t('dup_deselect_all')}
          </Button>
        )}
        {selected.size > 0 && (
          <Button size="sm" variant="danger" onClick={onDelete} disabled={deleting}>
            {deleting ? t('dup_deleting') : `${t('dup_delete')} (${selected.size})`}
          </Button>
        )}
      </div>

      {groups.length === 0 && !list.isLoading ? (
        <EmptyState text={t('dup_none')} />
      ) : (
        <div className="min-h-0 flex-1 space-y-4 overflow-auto pr-1">
          {groups.map((g) => (
            <div key={g.id} className="rounded-2xl border border-line bg-surface-2 p-4">
              <div className="mb-3 flex items-center gap-3 text-xs">
                <span className="rounded-md border border-line bg-bg/60 px-2 py-0.5 font-medium uppercase tracking-wide text-ink-2">
                  {t(KIND_LABEL[g.kind] ?? g.kind)}
                </span>
                <span className="text-ink-3">
                  {g.members.length} · {formatSize(g.reclaimable)} {t('dup_reclaimable')}
                </span>
              </div>
              <div className="flex flex-wrap gap-3">
                {g.members.map((m) => (
                  <DuplicateCard
                    key={m.id}
                    m={m}
                    selected={selected.has(m.id)}
                    onToggle={() => toggle(m.id)}
                    onOpen={() => setPreview(m)}
                    onOpenFrame={(src) => setFrameSrc(src)}
                    t={t}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {preview && <MediaDetail item={preview as FileItem} onClose={() => setPreview(null)} />}

      {frameSrc && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/85 p-4"
          onClick={() => setFrameSrc(null)}
        >
          <img
            src={`data:image/jpeg;base64,${frameSrc}`}
            alt="Frame"
            className="max-h-[90vh] max-w-[95vw] rounded-lg object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  )
}

function DuplicateCard({
  m,
  selected,
  onToggle,
  onOpen,
  onOpenFrame,
  t,
}: {
  m: Member
  selected: boolean
  onToggle: () => void
  onOpen: () => void
  onOpenFrame: (src: string) => void
  t: (k: string) => string
}) {
  const Icon = TYPE_ICON_COMP[m.type] ?? TYPE_ICON_COMP.other
  const isVideo = m.type === 'video'
  const frames = (m.frames ?? []).filter(Boolean)
  const showStrip = isVideo && frames.length > 0

  // Directory portion of the path (filename shown separately above it).
  const dir = m.path.slice(0, m.path.length - m.filename.length).replace(/[\\/]+$/, '')

  // One technical meta line: "dur | res | codec | size".
  const res = m.width && m.height ? `${m.width}×${m.height}${isVideo ? '' : 'px'}` : '?'
  const metaParts = isVideo
    ? [m.duration ? formatDuration(m.duration) : '?', res, m.codec || '?', formatSize(m.size)]
    : [res, formatSize(m.size)]
  if (m.match_count != null) metaParts.push(`${m.match_count}/5 ${t('dup_frames_match')}`)
  if (m.phash_distance != null) metaParts.push(`${t('dup_phash_dist')} ${m.phash_distance}`)
  const meta = metaParts.join(' | ')

  const openPreview = (e: MouseEvent) => {
    e.stopPropagation()
    onOpen()
  }
  const stopToggle = (e: MouseEvent) => {
    e.stopPropagation()
    onToggle()
  }

  // Card states: kept copy = green, marked-for-deletion = red,
  // an unselected (spared) candidate is dimmed and neutral.
  const cardState = selected
    ? 'border-danger/30 bg-danger/[0.06]'
    : m.is_keep
      ? 'border-ok/30 bg-ok/[0.06]'
      : 'border-line bg-surface-2 opacity-60'

  // Click anywhere on the card toggles selection; thumbnail click opens media dialog;
  // individual frame clicks open a full-size frame lightbox.
  return (
    <div
      onClick={onToggle}
      className={`w-[265px] cursor-pointer break-all rounded-xl border p-[11px] transition ${cardState}`}
    >
      {/* Keep / delete role badge — reflects actual selection, never implies an
          action that hasn't been explicitly chosen. */}
      {m.is_keep ? (
        <span className="mb-[5px] inline-block rounded-full bg-ok/15 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ok">
          ✓ {t('dup_keep')}
        </span>
      ) : selected ? (
        <span className="mb-[5px] inline-block rounded-full bg-danger/15 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-danger">
          ✕ {t('dup_delete_label')}
        </span>
      ) : (
        <span className="mb-[5px] inline-block rounded-full bg-white/5 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-ink-3">
          {t('dup_duplicate_label')}
        </span>
      )}

      {/* Large preview — click to open the media dialog */}
      {m.thumbnail_b64 ? (
        <img
          src={`data:image/jpeg;base64,${m.thumbnail_b64}`}
          alt={m.filename}
          loading="lazy"
          onClick={openPreview}
          title={t('dup_open_preview')}
          className="mb-[7px] block max-h-40 w-full cursor-zoom-in rounded-md bg-bg object-contain"
        />
      ) : (
        <div
          onClick={openPreview}
          title={t('dup_open_preview')}
          className="mb-[7px] flex h-20 w-full cursor-zoom-in items-center justify-center gap-1.5 rounded-md bg-bg text-[12px] text-ink-3"
        >
          <Icon width={18} height={18} className="opacity-60" />
          {t('dup_no_preview')}
        </div>
      )}

      {/* Frame strip — each frame opens a full-size view of that specific frame */}
      {showStrip && (
        <div className="mb-[6px] flex gap-[3px]">
          {frames.map((f, i) => {
            const match = m.frame_matches?.[i]
            const dist = m.frame_distances?.[i]
            const border =
              match === undefined ? 'border-line' : match ? 'border-ok' : 'border-danger'
            return (
              <img
                key={i}
                src={`data:image/jpeg;base64,${f}`}
                alt={FRAME_POS[i]}
                loading="lazy"
                title={`${FRAME_POS[i]}${dist != null ? ` · Δ${dist}` : ''}`}
                onClick={(e) => { e.stopPropagation(); onOpenFrame(f) }}
                className={`h-[50px] min-w-0 flex-1 cursor-zoom-in rounded-md border-2 bg-bg object-contain ${border}`}
              />
            )
          })}
        </div>
      )}

      {/* Filename, directory, technical meta */}
      <div className="mb-px mt-[3px] text-[13px] font-semibold text-ink-1" title={m.filename}>
        {m.filename}
      </div>
      <div className="mb-[3px] whitespace-pre-wrap font-mono text-[11px] text-ink-3" title={m.path}>
        {dir}
      </div>
      <div className="mb-[5px] font-mono text-[12px] text-ink-2">{meta}</div>

      {/* Delete checkbox — toggles selection (kept copy starts unchecked) */}
      <label
        onClick={stopToggle}
        className="mt-[5px] flex cursor-pointer items-center gap-1.5 text-[12px]"
      >
        <span
          className={`flex h-3.5 w-3.5 items-center justify-center rounded-[3px] border text-[9px] font-bold ${
            selected ? 'border-danger bg-danger text-bg' : 'border-line text-transparent'
          }`}
        >
          ✓
        </span>
        <span className={selected ? 'text-danger' : 'text-ink-3'}>{t('dup_delete_label')}</span>
      </label>
    </div>
  )
}
