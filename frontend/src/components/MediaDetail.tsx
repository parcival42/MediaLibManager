import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { formatSize, formatDuration } from '../utils'
import { Button, buttonClass, Input, Modal, Notice } from './ui'
import { IconDownload, IconEdit, IconRefresh, IconX, TYPE_ICON_COMP } from './icons'

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
  error?: string
  last_seen?: number
}

// Container formats most browsers cannot play via the native <video> element.
const NON_NATIVE = /\.(mkv|avi|wmv|flv|m4v)$/i

export default function MediaDetail({ item, onClose }: { item: FileItem; onClose: () => void }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const src = `/api/media/${item.id}`
  const TypeIcon = TYPE_ICON_COMP[item.type] ?? TYPE_ICON_COMP.other

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

  const status = item.enrich_status

  return (
    <Modal onClose={onClose} label={filename} className="max-w-3xl">
      <div className="mb-4 flex items-start justify-between gap-4">
        {renaming ? (
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <TypeIcon className="shrink-0 text-ink-3" />
            <Input
              autoFocus
              inputSize="sm"
              value={renameInput}
              onChange={(e) => setRenameInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submitRename()
                // Escape cancels the inline rename; stopping propagation keeps
                // the dialog's own Escape handler from closing it as well.
                if (e.key === 'Escape') {
                  e.stopPropagation()
                  setRenaming(false)
                }
              }}
              aria-label={t('rename_placeholder')}
              className="min-w-0 flex-1"
            />
            <Button size="sm" onClick={submitRename} disabled={rename.isPending}>
              {t('rename_confirm')}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRenaming(false)}>
              {t('rename_cancel')}
            </Button>
          </div>
        ) : (
          <h2 className="flex min-w-0 items-start gap-2 break-all font-head text-base font-semibold">
            <TypeIcon className="mt-0.5 shrink-0 text-ink-3" />
            {filename}
          </h2>
        )}
        <Button size="sm" variant="ghost" onClick={onClose}>
          <IconX />
          {t('close')}
        </Button>
      </div>

      {rename.isError && (
        <div className="mb-3">
          <Notice>{(rename.error as Error)?.message || t('rename_conflict')}</Notice>
        </div>
      )}

      <div className="mb-4 grid place-items-center">{renderMedia()}</div>

      {item.error && (
        <div className="mb-4">
          <Notice>
            <div className="mb-1 text-xs font-semibold">{t('enrich_error')}</div>
            <p className="break-all font-mono text-xs text-ink-2">{item.error}</p>
          </Notice>
        </div>
      )}

      <dl className="grid grid-cols-[auto,1fr] gap-x-4 gap-y-1 text-sm">
        {status ? (
          <>
            <dt className="text-ink-3">{t('status')}</dt>
            <dd className="text-ink-2">{t(`enrich_status_${status}`)}</dd>
          </>
        ) : null}
        <dt className="text-ink-3">{t('size')}</dt>
        <dd className="tabular-nums text-ink-2">{formatSize(item.size)}</dd>
        {item.width ? (
          <>
            <dt className="text-ink-3">{t('detail_resolution')}</dt>
            <dd className="tabular-nums text-ink-2">
              {item.width}×{item.height}
            </dd>
          </>
        ) : null}
        {item.duration ? (
          <>
            <dt className="text-ink-3">{t('detail_duration')}</dt>
            <dd className="tabular-nums text-ink-2">{formatDuration(item.duration)}</dd>
          </>
        ) : null}
        <dt className="text-ink-3">{t('detail_path')}</dt>
        <dd className="break-all font-mono text-xs leading-5 text-ink-3">{path}</dd>
      </dl>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <a href={src} download={filename} className={buttonClass('subtle', 'sm')}>
          <IconDownload />
          {t('download')}
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
          <IconEdit />
          {t('rename_action')}
        </Button>
        <Button variant="subtle" size="sm" onClick={() => reenrich.mutate()} disabled={reenrich.isPending}>
          <IconRefresh />
          {t('reenrich')}
        </Button>
        {reenrich.isSuccess && <span className="text-xs text-accent">{t('reenrich_queued')}</span>}
      </div>
    </Modal>
  )
}
