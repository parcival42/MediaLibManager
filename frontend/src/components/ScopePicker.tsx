/** Directory scope picker: a button that opens a DirectoryTree popover.
 * `null` means "entire library" (or "nothing chosen yet", see `emptyLabel`).
 * Closes on outside click, Escape and after a selection. */
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../i18n'
import { Button } from './ui'
import { IconFolder, IconX } from './icons'
import DirectoryTree from './DirectoryTree'

export default function ScopePicker({
  value,
  onChange,
  emptyLabel,
  clearable = true,
  disabled,
}: {
  value: string | null
  onChange: (path: string | null) => void
  emptyLabel?: string
  clearable?: boolean
  disabled?: boolean
}) {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="relative flex min-w-0 items-center gap-1" ref={ref}>
      <Button
        size="sm"
        variant="subtle"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        aria-expanded={open}
        title={value ?? undefined}
        className="max-w-[28rem]"
      >
        <IconFolder width={15} height={15} className="shrink-0" />
        <span className="truncate">{value ?? emptyLabel ?? t('dup_scope_all')}</span>
      </Button>
      {clearable && value && (
        <Button
          size="icon"
          variant="ghost"
          onClick={() => onChange(null)}
          title={t('dup_scope_clear')}
          aria-label={t('dup_scope_clear')}
          disabled={disabled}
        >
          <IconX />
        </Button>
      )}
      {open && (
        <div className="absolute left-0 top-full z-30 mt-2 max-h-80 w-80 overflow-auto rounded-xl border border-line bg-surface-2 p-2 shadow-card">
          <DirectoryTree
            value={value}
            onSelect={(p) => {
              onChange(p)
              setOpen(false)
            }}
          />
        </div>
      )}
    </div>
  )
}
