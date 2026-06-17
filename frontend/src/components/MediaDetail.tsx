import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { formatSize, formatDuration, TYPE_ICON } from '../utils'
import { Button } from './ui'

export interface FileItem {
  id: number
  path: string
  filename: string
  type: string
  size: number
  enrich_status?: string
  width?: number
  height?: number
  duration?: number
  thumbnail_b64?: string
  error?: string
  last_seen?: number
}

// Container formats most browsers cannot play via the native <video> element.
const NON_NATIVE = /\.(mkv|avi|wmv|flv|m4v)$/i

export default function MediaDetail({ item, onClose }: { item: FileItem; onClose: () => void }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const src = `/api/media/${item.id}`

  const [filename, setFilename] = useState(item.filename)
  const [path, setPath] = useState(item.path)
  const [renaming, setRenaming] = useState(false)
  const [renameInput, setRenameInput] = useState(item.filename)

  const reenrich = useMutation({
    mutationFn: () => api(`/api/library/${item.id}/reenrich`, { method: 'POST' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['library'] })
      queryClient.invalidateQueries({ queryKey: ['enrichment'] })
    },
  })

  const rename = useMutation({
    mutationFn: (new_name: string) =>
      api<{ path: string; filename: string }>(`/api/library/${item.id}/rename`, {
        method: 'POST',
        body: JSON.stringify({ new_name }),
      }),
    onSuccess: (d) => {
      setFilename(d.filename)
      setPath(d.path)
      setRenaming(false)
      queryClient.invalidateQueries({ queryKey: ['library'] })
      queryClient.invalidateQueries({ queryKey: ['duplicates'] })
      queryClient.invalidateQueries({ queryKey: ['rename-preview'] })
    },
  })

  const submitRename = () => {
    const name = renameInput.trim()
    if (!name || name === filename) {
      setRenaming(false)
      return
    }
    rename.mutate(name)
  }

  const renderMedia = () => {
    if (item.type === 'image') {
      return <img src={src} alt={filename} className="max-h-[60vh] w-auto rounded-lg" />
    }
    if (item.type === 'video') {
      const videoSrc = NON_NATIVE.test(filename) ? `/api/media/${item.id}/transcode` : src
      return (
        <div className="w-full">
          <video src={videoSrc} controls className="max-h-[60vh] w-full rounded-lg bg-black" />
        </div>
      )
    }
    if (item.type === 'audio') {
      return <audio src={src} controls className="w-full" />
    }
    return <p className="text-sm text-ink-3">{t('no_preview')}</p>
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-6"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-3xl overflow-auto rounded-2xl border border-line bg-surface-2 p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          {renaming ? (
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span className="shrink-0">{TYPE_ICON[item.type] ?? TYPE_ICON.other}</span>
              <input
                autoFocus
                value={renameInput}
                onChange={(e) => setRenameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitRename()
                  if (e.key === 'Escape') setRenaming(false)
                }}
                className="min-w-0 flex-1 rounded-lg border border-line bg-surface-1 px-2 py-1 text-sm"
              />
              <Button size="sm" onClick={submitRename} disabled={rename.isPending}>
                {t('rename_confirm')}
              </Button>
              <Button size="sm" variant="subtle" onClick={() => setRenaming(false)}>
                {t('rename_cancel')}
              </Button>
            </div>
          ) : (
            <h2 className="break-all text-base font-medium">
              <span className="mr-2">{TYPE_ICON[item.type] ?? TYPE_ICON.other}</span>
              {filename}
            </h2>
          )}
          <button onClick={onClose} className="shrink-0 text-ink-2 hover:text-ink-1">
            ✕ {t('close')}
          </button>
        </div>

        {rename.isError && (
          <p className="mb-3 text-xs text-danger">
            {(rename.error as Error)?.message || t('rename_conflict')}
          </p>
        )}

        <div className="mb-4 grid place-items-center">{renderMedia()}</div>

        {item.error && (
          <div className="mb-4 rounded-lg border border-danger/40 bg-danger/10 p-3">
            <div className="mb-1 text-xs font-medium text-danger">{t('enrich_error')}</div>
            <p className="break-all font-mono text-xs text-ink-2">{item.error}</p>
          </div>
        )}

        <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
          {item.enrich_status ? (
            <>
              <dt className="text-ink-3">{t('status')}</dt>
              <dd className="font-mono text-ink-2">{item.enrich_status}</dd>
            </>
          ) : null}
          <dt className="text-ink-3">{t('size')}</dt>
          <dd className="font-mono text-ink-2">{formatSize(item.size)}</dd>
          {item.width ? (
            <>
              <dt className="text-ink-3">{t('detail_resolution')}</dt>
              <dd className="font-mono text-ink-2">
                {item.width}×{item.height}
              </dd>
            </>
          ) : null}
          {item.duration ? (
            <>
              <dt className="text-ink-3">{t('detail_duration')}</dt>
              <dd className="font-mono text-ink-2">{formatDuration(item.duration)}</dd>
            </>
          ) : null}
          <dt className="text-ink-3">{t('detail_path')}</dt>
          <dd className="break-all font-mono text-ink-3">{path}</dd>
        </dl>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          <a
            href={src}
            download={filename}
            className="inline-block rounded-lg border border-line px-3 py-1.5 text-sm text-ink-2 hover:text-ink-1"
          >
            ↓ {t('download')}
          </a>
          <Button
            variant="subtle"
            size="sm"
            onClick={() => {
              setRenameInput(filename)
              setRenaming(true)
            }}
            disabled={renaming}
          >
            ✎ {t('rename_action')}
          </Button>
          <Button
            variant="subtle"
            size="sm"
            onClick={() => reenrich.mutate()}
            disabled={reenrich.isPending}
          >
            ↻ {t('reenrich')}
          </Button>
          {reenrich.isSuccess && (
            <span className="text-xs text-accent">{t('reenrich_queued')}</span>
          )}
        </div>
      </div>
    </div>
  )
}
