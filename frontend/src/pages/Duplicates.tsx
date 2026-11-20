import { type MouseEvent, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { formatSize, formatDuration } from '../utils'
import {
  Badge,
  Button,
  buttonClass,
  Card,
  Checkbox,
  EmptyState,
  LoadingPane,
  Modal,
  Segmented,
} from '../components/ui'
import {
  IconArrowLeft,
  IconArrowRight,
  IconCheck,
  IconExternal,
  IconScan,
  IconX,
  TYPE_ICON_COMP,
} from '../components/icons'
import MediaDetail, { type FileItem } from '../components/MediaDetail'
import ScopePicker from '../components/ScopePicker'
import { useTaskPolling } from '../components/TaskProgress'

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
  has_thumb?: boolean
  mean_saturation?: number | null
  is_keep: boolean
  frame_count?: number
  phash_distance?: number
  frame_distances?: (number | null)[]
  frame_matches?: boolean[]
  match_count?: number
}

interface Group {
  id: number
  kind: string
  ignored: boolean
  members: Member[]
  reclaimable: number
}

// Strongest-evidence-first, same as backend api/dedup.py KIND_ORDER.
const KIND_ORDER = ['exact_image', 'exact_video', 'exact_other', 'visual', 'video', 'deep']
const kindRank = (k: string) => {
  const i = KIND_ORDER.indexOf(k)
  return i === -1 ? KIND_ORDER.length : i
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

type SortKey = 'kind' | 'path' | 'size'

export default function Duplicates() {
  const { t } = useI18n()
  const [kind, setKind] = useState('')
  const [sort, setSort] = useState<SortKey>('kind')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [preview, setPreview] = useState<Member | null>(null)
  const [frameSrc, setFrameSrc] = useState<string | null>(null)
  // Group-scoped image lightbox: the group's image members plus the one to show
  // first, so ←/→ flips between visually-identical copies for direct comparison.
  const [lightbox, setLightbox] = useState<{ members: Member[]; start: number } | null>(null)

  // Directory scope: null = entire library. `pendingScope` is the tree
  // selection (applies on the next rebuild); `appliedScope` is what the
  // currently-shown results were actually scanned with.
  const [pendingScope, setPendingScope] = useState<string | null>(null)
  const [appliedScope, setAppliedScope] = useState<string | null>(null)

  const list = useQuery<{ groups: Group[] }>({
    queryKey: ['duplicates', kind],
    queryFn: () => api(`/api/duplicates${kind ? `?kind=${kind}` : ''}`),
    refetchOnWindowFocus: false,
  })
  const groups = list.data?.groups ?? []

  const sortedGroups = useMemo(() => {
    const keepDir = (g: Group) => g.members[0]?.path.replace(/[\\/][^\\/]*$/, '') ?? ''
    if (sort === 'size') {
      const maxSize = (g: Group) => Math.max(...g.members.map((m) => m.size))
      return [...groups].sort((a, b) => maxSize(b) - maxSize(a))
    }
    if (sort === 'path') {
      return [...groups].sort((a, b) => keepDir(a).localeCompare(keepDir(b)))
    }
    // 'kind': strongest evidence first; within the same kind by keep-member directory.
    // (A comparator returning 0 across kinds isn't transitive and scrambles the order.)
    return [...groups].sort(
      (a, b) => kindRank(a.kind) - kindRank(b.kind) || keepDir(a).localeCompare(keepDir(b)),
    )
  }, [groups, sort])

  // 'kind' sort is meaningless when a single type is already filtered — fall back to 'path'.
  useEffect(() => {
    if (kind && sort === 'kind') setSort('path')
  }, [kind])

  // Selection starts empty on every (re)load — never pre-select files for
  // deletion. Deleting is an explicit, deliberate action (see dup_select_others).
  useEffect(() => {
    setSelected(new Set())
  }, [list.data])

  // Ignored groups were marked "not duplicates" by the user: never count them
  // as reclaimable and never bulk-select them for deletion.
  const totalReclaimable = useMemo(
    () => groups.reduce((sum, g) => sum + (g.ignored ? 0 : g.reclaimable), 0),
    [groups],
  )

  const groupOfMember = useMemo(() => {
    const map = new Map<number, Group>()
    for (const g of groups) for (const m of g.members) map.set(m.id, g)
    return map
  }, [groups])

  const toggle = (id: number) => {
    // Never let a selection cover every copy of a group -- at least one must
    // survive (the backend enforces the same).
    if (!selected.has(id)) {
      const g = groupOfMember.get(id)
      if (g && g.members.every((m) => m.id === id || selected.has(m.id))) {
        window.alert(t('dup_last_copy'))
        return
      }
    }
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectAllButKept = () => {
    const sel = new Set<number>()
    for (const g of groups) {
      if (g.ignored) continue
      for (const m of g.members) if (!m.is_keep) sel.add(m.id)
    }
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
  // rebuildId stays set until a terminal status is seen (covers 'queued');
  // a poll that gave up (isError) must not keep the button disabled.
  const rebuilding = rebuildMut.isPending || (rebuildId !== null && !rebuildTask.isError)

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
  const deleteTask = useTaskPolling(deleteId, () => {
    list.refetch()
    setDeleteId(null)
  })
  const deleting = deleteMut.isPending || (!!deleteId && !deleteTask.isError)

  const onDelete = () => {
    if (!selected.size) return
    if (!window.confirm(t('dup_delete_confirm'))) return
    deleteMut.mutate([...selected])
  }

  // Group-level multi-select for the bulk "ignore selected" action (separate
  // from the per-file `selected` set used for deletion).
  const [selectedGroups, setSelectedGroups] = useState<Set<number>>(new Set())
  useEffect(() => {
    setSelectedGroups(new Set())
  }, [list.data])

  const ignoreMut = useMutation({
    mutationFn: ({ fileIds }: { fileIds: number[]; groupId: number }) =>
      api('/api/duplicates/ignore', {
        method: 'POST',
        body: JSON.stringify({ file_ids: fileIds }),
      }),
    onSuccess: () => { list.refetch() },
  })

  const unignoreMut = useMutation({
    mutationFn: ({ fileIds }: { fileIds: number[]; groupId: number }) =>
      api('/api/duplicates/unignore', {
        method: 'POST',
        body: JSON.stringify({ file_ids: fileIds }),
      }),
    onSuccess: () => { list.refetch() },
  })

  const onToggleIgnore = (g: Group) => {
    const fileIds = g.members.map((m) => m.id)
    if (g.ignored) unignoreMut.mutate({ fileIds, groupId: g.id })
    else ignoreMut.mutate({ fileIds, groupId: g.id })
  }

  const toggleGroupSelected = (id: number) =>
    setSelectedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const onIgnoreSelectedGroups = () => {
    for (const g of groups) {
      if (selectedGroups.has(g.id) && !g.ignored) {
        ignoreMut.mutate({ fileIds: g.members.map((m) => m.id), groupId: g.id })
      }
    }
    setSelectedGroups(new Set())
  }

  return (
    <div className="flex h-full flex-col">
      {/* Row 1: title + scan setup (what the next rebuild covers). Replaces
          the full PageHeader to leave the height to the groups. */}
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h1 className="font-head text-xl font-semibold tracking-tight">{t('nav_duplicates')}</h1>
        <span className="h-5 w-px bg-line" />
        <ScopePicker value={pendingScope} onChange={setPendingScope} />
        {appliedScope && (
          <Badge tone="neutral" title={appliedScope} className="max-w-[24rem]">
            {t('dup_scope_label')}: <span className="min-w-0 truncate font-mono font-normal">{appliedScope}</span>
          </Badge>
        )}
        <div className="ml-auto flex items-center gap-4">
          <Checkbox
            checked={deepEnabled}
            disabled={deepMut.isPending || rebuilding}
            onChange={(v) => deepMut.mutate(v)}
            title={t('dup_deep_enabled_hint')}
            label={t('dup_deep_enabled')}
          />
          <Button size="sm" onClick={() => rebuildMut.mutate(pendingScope)} disabled={rebuilding}>
            <IconScan />
            {rebuilding
              ? `${t('dup_rebuilding')} ${Math.round(rebuildTask.data?.progress ?? 0)}%`
              : t('dup_rebuild')}
          </Button>
        </div>
      </div>

      {/* Row 2: result filter + sort + counts + selection actions. Stays in
          view because only the group list below scrolls. The file-level
          actions are always rendered (disabled when idle) so it never shifts. */}
      <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line pb-3">
        <Segmented
          size="sm"
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
        <Segmented
          size="sm"
          value={sort}
          onChange={setSort}
          options={[
            ...(!kind ? [{ value: 'kind' as SortKey, label: t('dup_sort_kind') }] : []),
            { value: 'path', label: t('dup_sort_path') },
            { value: 'size', label: t('dup_sort_size') },
          ]}
        />
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-3">
            {groups.length.toLocaleString()} {t('dup_groups_count')}
          </span>
          {totalReclaimable > 0 && (
            <span className="text-xs tabular-nums text-ink-2">
              {formatSize(totalReclaimable)} {t('dup_reclaimable')}
            </span>
          )}
          <span className="mx-1 h-5 w-px bg-line" />
          {selectedGroups.size > 0 && (
            <>
              <Button size="sm" variant="ghost" onClick={() => setSelectedGroups(new Set())}>
                {t('dup_deselect_all')}
              </Button>
              <Button size="sm" variant="subtle" onClick={onIgnoreSelectedGroups} disabled={ignoreMut.isPending}>
                {`${t('dup_ignore_selected')} (${selectedGroups.size})`}
              </Button>
              <span className="mx-1 h-5 w-px bg-line" />
            </>
          )}
          <Button
            size="sm"
            variant="subtle"
            onClick={selectAllButKept}
            disabled={groups.length === 0}
            title={t('dup_select_others_hint')}
          >
            {t('dup_select_others')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())} disabled={selected.size === 0}>
            {t('dup_deselect_all')}
          </Button>
          <Button size="sm" variant="danger" onClick={onDelete} disabled={deleting || selected.size === 0}>
            {deleting ? t('dup_deleting') : `${t('dup_delete')} (${selected.size})`}
          </Button>
        </div>
      </div>

      {list.isLoading ? (
        <LoadingPane />
      ) : groups.length === 0 ? (
        <EmptyState text={t('dup_none')} />
      ) : (
        <div className="min-h-0 flex-1 space-y-3 overflow-auto pr-1">
          {sortedGroups.map((g) => {
            const isIgnored = g.ignored
            const groupMarked = g.members.some((m) => selected.has(m.id))
            return (
            <Card key={g.id} className={`px-3 pb-3 pt-2 transition ${isIgnored ? 'opacity-40' : ''}`}>
              <div className="mb-2 flex items-center gap-3 text-xs">
                <Badge tone="neutral">{t(KIND_LABEL[g.kind] ?? g.kind)}</Badge>
                <span className="tabular-nums text-ink-3">
                  {g.members.length} · {formatSize(g.reclaimable)} {t('dup_reclaimable')}
                </span>
                <div className="ml-auto flex items-center gap-3">
                  <Button
                    size="sm"
                    variant={isIgnored ? 'link' : 'ghost'}
                    onClick={() => onToggleIgnore(g)}
                    disabled={ignoreMut.isPending || unignoreMut.isPending}
                    title={t('dup_ignore_group_hint')}
                  >
                    {isIgnored ? t('dup_ignore_group_undo') : t('dup_ignore_group')}
                  </Button>
                  <Checkbox
                    checked={selectedGroups.has(g.id)}
                    onChange={() => toggleGroupSelected(g.id)}
                    title={t('dup_select_group')}
                  />
                </div>
              </div>
              <div className="flex flex-wrap gap-2.5">
                {g.members.map((m) => {
                  const imageMembers = g.members.filter((x) => x.type === 'image')
                  return (
                    <DuplicateCard
                      key={m.id}
                      m={m}
                      groupMarked={groupMarked}
                      selected={selected.has(m.id)}
                      onToggle={() => toggle(m.id)}
                      onOpen={() =>
                        m.type === 'image'
                          ? setLightbox({
                              members: imageMembers,
                              start: Math.max(0, imageMembers.findIndex((x) => x.id === m.id)),
                            })
                          : setPreview(m)
                      }
                      onOpenFrame={(src) => setFrameSrc(src)}
                      t={t}
                    />
                  )
                })}
              </div>
            </Card>
            )
          })}
        </div>
      )}

      {lightbox && (
        <DuplicateLightbox
          members={lightbox.members}
          start={lightbox.start}
          onClose={() => setLightbox(null)}
          t={t}
        />
      )}

      {preview && <MediaDetail item={preview as FileItem} onClose={() => setPreview(null)} />}

      {frameSrc && (
        <Modal variant="fullscreen" label={t('dup_frame_alt')} onClose={() => setFrameSrc(null)}>
          <div className="grid flex-1 place-items-center p-4">
            <img
              src={frameSrc}
              alt={t('dup_frame_alt')}
              className="max-h-[90vh] max-w-[95vw] rounded-lg object-contain"
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        </Modal>
      )}
    </div>
  )
}

function DuplicateCard({
  m,
  selected,
  groupMarked,
  onToggle,
  onOpen,
  onOpenFrame,
  t,
}: {
  m: Member
  selected: boolean
  /** Whether any member of this card's group is marked for deletion. */
  groupMarked: boolean
  onToggle: () => void
  onOpen: () => void
  onOpenFrame: (src: string) => void
  t: (k: string) => string
}) {
  const Icon = TYPE_ICON_COMP[m.type] ?? TYPE_ICON_COMP.other
  const isVideo = m.type === 'video'
  // Frames are served by URL (like thumbnails) instead of inline base64, so
  // the group list payload stays small.
  const frames = Array.from({ length: m.frame_count ?? 0 }, (_, i) => `/api/media/${m.id}/frame/${i}`)
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
  if (!isVideo && m.mean_saturation != null)
    metaParts.push(`${t('dup_saturation')} ${m.mean_saturation.toFixed(2)}`)
  const meta = metaParts.join(' · ')

  const openPreview = (e: MouseEvent) => {
    e.stopPropagation()
    onOpen()
  }
  const stopToggle = (e: MouseEvent) => {
    e.stopPropagation()
    onToggle()
  }

  // Card states show the outcome of the current selection, not the
  // suggestion: once anything in the group is marked, marked = red (deleted)
  // and every other copy = green (stays). Before that, the suggested keep
  // (what "Select all suggestions" would spare) only gets a subtle green
  // border. Any member can be marked as long as one copy survives.
  const cardState = selected
    ? 'border-danger/40 bg-danger/[0.07]'
    : groupMarked
      ? 'border-ok/40 bg-ok/[0.07]'
      : m.is_keep
        ? 'border-ok/40 bg-surface-2'
        : 'border-line bg-surface-2'

  // Click anywhere on the card toggles selection; thumbnail click opens media dialog;
  // individual frame clicks open a full-size frame lightbox.
  return (
    <div
      onClick={onToggle}
      className={`w-[265px] cursor-pointer rounded-xl border p-2.5 transition ${cardState}`}
    >
      {/* Preview with the delete checkbox laid over it (top right). */}
      <div className="relative mb-2">
        {m.has_thumb ? (
          <img
            src={`/api/media/${m.id}/thumb`}
            alt={m.filename}
            loading="lazy"
            onClick={openPreview}
            onAuxClick={(e) => {
              // Middle-click opens the original in a new browser tab for a
              // side-by-side comparison outside the app.
              if (e.button === 1) {
                e.preventDefault()
                e.stopPropagation()
                window.open(`/api/media/${m.id}`, '_blank', 'noopener')
              }
            }}
            title={t('dup_open_preview')}
            className="block h-40 w-full cursor-zoom-in rounded-md bg-bg object-contain"
          />
        ) : (
          <div
            onClick={openPreview}
            title={t('dup_open_preview')}
            className="flex h-20 w-full cursor-zoom-in items-center justify-center gap-1.5 rounded-md bg-bg text-xs text-ink-3"
          >
            <Icon width={18} height={18} className="opacity-60" />
            {t('dup_no_preview')}
          </div>
        )}
        {/* A real button so it is reachable by keyboard; stops propagation so
            the card's own click handler doesn't toggle a second time. */}
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={t('dup_delete_label')}
          title={t('dup_delete_label')}
          onClick={stopToggle}
          className={`absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-md border backdrop-blur ${
            selected ? 'border-danger bg-danger text-bg' : 'border-white/40 bg-bg/70 text-transparent hover:border-white/70'
          }`}
        >
          <IconCheck width={12} height={12} strokeWidth={3} />
        </button>
      </div>

      {/* Frame strip — each frame opens a full-size view of that specific frame */}
      {showStrip && (
        <div className="mb-2 flex gap-1">
          {frames.map((f, i) => {
            const match = m.frame_matches?.[i]
            const dist = m.frame_distances?.[i]
            const border =
              match === undefined ? 'border-line' : match ? 'border-ok' : 'border-danger'
            return (
              <img
                key={i}
                src={f}
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

      {/* Filename and full directory, wrapped and never truncated: they are
          what the copies get compared by. */}
      <div className="break-all text-[13px] font-semibold text-ink-1">{m.filename}</div>
      <div className="mt-0.5 whitespace-pre-wrap break-all font-mono text-[11px] text-ink-3">{dir}</div>
      <div className="mt-0.5 truncate text-[11.5px] tabular-nums text-ink-2">{meta}</div>
    </div>
  )
}

/**
 * Full-screen comparison lightbox over the image members of one duplicate group.
 * The image is anchored centre-stage, so flipping with ←/→ (or clicking it)
 * swaps near-identical copies in place — the fastest way to spot the actual
 * difference. Reads the originals from `/api/media/{id}` and preloads the
 * neighbours so the flip is instant.
 */
function DuplicateLightbox({
  members,
  start,
  onClose,
  t,
}: {
  members: Member[]
  start: number
  onClose: () => void
  t: (k: string) => string
}) {
  const [i, setI] = useState(start)
  const count = members.length
  const go = (delta: number) => setI((x) => (x + delta + count) % count)

  // Escape is handled by Modal; only the arrow keys live here.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') setI((x) => (x - 1 + count) % count)
      else if (e.key === 'ArrowRight') setI((x) => (x + 1) % count)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [count])

  // Preload the neighbours so ←/→ flips without a load flash.
  useEffect(() => {
    for (const j of [(i + 1) % count, (i - 1 + count) % count]) {
      const img = new Image()
      img.src = `/api/media/${members[j].id}`
    }
  }, [i, count, members])

  const m = members[i]
  const src = `/api/media/${m.id}`
  const metaParts: string[] = []
  if (m.width && m.height) metaParts.push(`${m.width}×${m.height}px`)
  metaParts.push(formatSize(m.size))
  if (m.mean_saturation != null) metaParts.push(`${t('dup_saturation')} ${m.mean_saturation.toFixed(2)}`)
  if (m.phash_distance != null) metaParts.push(`${t('dup_phash_dist')} ${m.phash_distance}`)

  const navBtn =
    'absolute top-1/2 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white transition hover:bg-white/20'

  return (
    <Modal variant="fullscreen" label={m.filename} onClose={onClose}>
      <div
        className="flex items-center gap-3 px-5 py-3 text-sm text-ink-2"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="shrink-0 tabular-nums text-ink-3">
          {i + 1} / {count}
        </span>
        {m.is_keep && (
          <Badge tone="accent">
            <IconCheck width={12} height={12} />
            {t('dup_keep')}
          </Badge>
        )}
        <span className="min-w-0 flex-1 truncate" title={m.filename}>
          {m.filename}
        </span>
        <a href={src} target="_blank" rel="noopener noreferrer" className={buttonClass('ghost', 'sm')}>
          <IconExternal />
          {t('dup_lb_new_tab')}
        </a>
        <Button size="sm" variant="ghost" onClick={onClose}>
          <IconX />
          {t('close')}
        </Button>
      </div>

      <div className="relative flex min-h-0 flex-1 items-center justify-center px-16">
        {count > 1 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              go(-1)
            }}
            aria-label={t('previous')}
            className={`${navBtn} left-3`}
          >
            <IconArrowLeft />
          </button>
        )}
        <img
          src={src}
          alt={m.filename}
          onClick={(e) => {
            e.stopPropagation()
            if (count > 1) go(1)
          }}
          className="max-h-full max-w-full cursor-pointer rounded-lg object-contain"
        />
        {count > 1 && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              go(1)
            }}
            aria-label={t('next')}
            className={`${navBtn} right-3`}
          >
            <IconArrowRight />
          </button>
        )}
      </div>

      <div
        className="px-5 py-3 text-center text-xs tabular-nums text-ink-2"
        onClick={(e) => e.stopPropagation()}
      >
        {metaParts.join(' · ')}
        {count > 1 && <span className="ml-3 text-ink-3">{t('dup_lb_hint')}</span>}
      </div>
    </Modal>
  )
}
