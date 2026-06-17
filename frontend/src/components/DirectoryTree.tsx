import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { IconChevron, IconFolder } from './icons'

interface DirEntry {
  name: string
  path: string
}

interface BrowseResponse {
  path: string
  directories: DirEntry[]
}

/** Lazily-expandable directory tree, rooted at the configured media root.
 * `value` is the selected absolute path (or null for "entire library" / root). */
export default function DirectoryTree({
  value,
  onSelect,
}: {
  value: string | null
  onSelect: (path: string | null) => void
}) {
  const { t } = useI18n()
  const root = useQuery<BrowseResponse>({
    queryKey: ['browse', null],
    queryFn: () => api<BrowseResponse>('/api/browse'),
  })

  return (
    <div className="text-sm">
      <button
        onClick={() => onSelect(null)}
        className={`flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-left transition ${
          value === null ? 'bg-surface-3 text-accent' : 'text-ink-2 hover:bg-white/5 hover:text-ink-1'
        }`}
      >
        <IconFolder width={15} height={15} />
        {t('dup_scope_all')}
      </button>
      {root.isError && <p className="px-2 py-1 text-xs text-danger">{t('dup_tree_error')}</p>}
      <div>
        {(root.data?.directories ?? []).map((d) => (
          <TreeNode key={d.path} entry={d} depth={0} value={value} onSelect={onSelect} />
        ))}
      </div>
    </div>
  )
}

function TreeNode({
  entry,
  depth,
  value,
  onSelect,
}: {
  entry: DirEntry
  depth: number
  value: string | null
  onSelect: (path: string) => void
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const children = useQuery<BrowseResponse>({
    queryKey: ['browse', entry.path],
    queryFn: () => api<BrowseResponse>(`/api/browse?path=${encodeURIComponent(entry.path)}`),
    enabled: open,
  })
  const active = value === entry.path

  return (
    <div>
      <div
        className={`group flex items-center gap-1 rounded-lg py-1.5 pr-2 text-left transition ${
          active ? 'bg-surface-3 text-accent' : 'text-ink-2 hover:bg-white/5 hover:text-ink-1'
        }`}
        style={{ paddingLeft: depth * 16 + 8 }}
      >
        <button
          onClick={(e) => {
            e.stopPropagation()
            setOpen((o) => !o)
          }}
          className="flex h-4 w-4 shrink-0 items-center justify-center text-ink-3"
        >
          <IconChevron
            className={`transition-transform ${open ? 'rotate-0' : '-rotate-90'}`}
          />
        </button>
        <button onClick={() => onSelect(entry.path)} className="flex flex-1 items-center gap-1.5 truncate">
          <IconFolder width={15} height={15} className="shrink-0" />
          <span className="truncate" title={entry.path}>
            {entry.name}
          </span>
        </button>
      </div>
      {open && (
        <div>
          {children.isError && (
            <p className="px-2 py-1 text-xs text-danger" style={{ paddingLeft: (depth + 1) * 16 + 8 }}>
              {t('dup_tree_error')}
            </p>
          )}
          {(children.data?.directories ?? []).map((d) => (
            <TreeNode key={d.path} entry={d} depth={depth + 1} value={value} onSelect={onSelect} />
          ))}
        </div>
      )}
    </div>
  )
}
