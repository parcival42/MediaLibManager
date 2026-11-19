/** Shared UI primitives for the Studio Dark design system.
 *
 * Every page builds from these so sizes, radii, tones and focus behaviour stay
 * consistent. Tone maps use complete literal class strings on purpose:
 * Tailwind only generates classes it can find verbatim in the source. */
import { useEffect } from 'react'
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

type Variant = 'primary' | 'subtle' | 'ghost' | 'danger' | 'link'
type Size = 'sm' | 'md' | 'icon'

const VARIANTS: Record<Variant, string> = {
  // The gradient + glow is reserved for the one main action of a view.
  primary:
    'bg-gradient-to-br from-accent to-accent-2 text-bg font-semibold shadow-glow hover:brightness-110',
  subtle:
    'border border-line bg-surface-2 text-ink-2 hover:text-ink-1 hover:bg-surface-3 hover:border-surface-4',
  ghost: 'text-ink-2 hover:text-ink-1 hover:bg-white/5',
  danger:
    'bg-danger text-bg font-semibold shadow-[0_0_18px_-2px_rgba(251,113,133,0.55)] hover:brightness-110',
  link: 'text-accent hover:underline underline-offset-2',
}

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
  icon: 'h-8 w-8',
}

/** Class string of a button, for elements that must stay links (<a download>). */
export function buttonClass(variant: Variant = 'primary', size: Size = 'md', className = '') {
  const sizing = variant === 'link' ? 'gap-1 text-xs' : SIZES[size]
  const shape = variant === 'link' ? 'rounded' : 'rounded-xl'
  return `inline-flex shrink-0 items-center justify-center whitespace-nowrap font-medium transition disabled:opacity-50 disabled:pointer-events-none ${shape} ${VARIANTS[variant]} ${sizing} ${className}`
}

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  type = 'button',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button type={type} className={buttonClass(variant, size, className)} {...props}>
      {children}
    </button>
  )
}

type ToggleTone = 'accent' | 'warn' | 'danger'

const TOGGLE_ON: Record<ToggleTone, string> = {
  accent: 'border-accent/50 bg-accent/15 text-accent',
  warn: 'border-warn/50 bg-warn/15 text-warn',
  danger: 'border-danger/50 bg-danger/15 text-danger',
}

/** On/off filter chip. A filter is never a destructive action, so it never
 * borrows the danger button; `tone` only colours the pressed state. */
export function Toggle({
  pressed,
  onChange,
  tone = 'accent',
  className = '',
  children,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> & {
  pressed: boolean
  onChange: (next: boolean) => void
  tone?: ToggleTone
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={() => onChange(!pressed)}
      className={`inline-flex h-8 shrink-0 items-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition disabled:opacity-50 ${
        pressed ? TOGGLE_ON[tone] : 'border-line bg-surface-2 text-ink-2 hover:bg-surface-3 hover:text-ink-1'
      } ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: { value: T; label: ReactNode }[]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex flex-wrap gap-1 rounded-xl border border-line bg-bg/60 p-1">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={`rounded-lg px-3 py-1.5 text-[13px] font-medium transition ${
              active ? 'bg-surface-3 text-accent shadow-sm' : 'text-ink-2 hover:bg-white/5 hover:text-ink-1'
            }`}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return <div className={`rounded-2xl border border-line bg-surface-2 ${className}`}>{children}</div>
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="font-head text-3xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1.5 text-sm text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

/** Heading of a section inside a page or card. `sm` is for sub-sections
 * inside a form or card, `md` for top-level page sections. */
export function SectionTitle({
  title,
  description,
  actions,
  size = 'md',
  className = '',
}: {
  title: ReactNode
  description?: ReactNode
  actions?: ReactNode
  size?: 'sm' | 'md'
  className?: string
}) {
  return (
    <div className={`flex flex-wrap items-end justify-between gap-3 ${size === 'md' ? 'mb-3' : 'mb-2'} ${className}`}>
      <div className="min-w-0">
        <h2
          className={
            size === 'md'
              ? 'font-head text-base font-semibold text-ink-1'
              : 'text-sm font-semibold text-ink-1'
          }
        >
          {title}
        </h2>
        {description && <p className="mt-1 text-sm text-ink-3">{description}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

/** Toolbar above a selectable list: summary (counts, chips) on the left,
 * selection actions on the right. Keeps a fixed height so the list below
 * does not jump when actions become enabled. */
export function SelectionBar({ summary, actions }: { summary?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-4 flex min-h-8 flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex flex-wrap items-center gap-3 text-sm text-ink-3">{summary}</div>
      {actions && <div className="ml-auto flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Form controls
// ---------------------------------------------------------------------------

type ControlSize = 'sm' | 'md'

const CONTROL =
  'rounded-xl border border-line bg-surface-3 text-ink-1 placeholder:text-ink-3 outline-none transition focus:border-accent/70 focus:ring-2 focus:ring-accent/15 disabled:opacity-50'

const CONTROL_SIZE: Record<ControlSize, string> = {
  sm: 'h-8 px-2.5 text-xs',
  md: 'h-10 px-3.5 text-sm',
}

export function Input({
  className = '',
  inputSize = 'md',
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { inputSize?: ControlSize }) {
  return <input className={`${CONTROL} ${CONTROL_SIZE[inputSize]} ${className}`} {...props} />
}

export function Select({
  className = '',
  inputSize = 'md',
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { inputSize?: ControlSize }) {
  return (
    <select className={`${CONTROL} ${CONTROL_SIZE[inputSize]} ${className}`} {...props}>
      {children}
    </select>
  )
}

export function Textarea({ className = '', ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${CONTROL} w-full resize-y px-3 py-2 font-mono text-xs ${className}`} {...props} />
}

/** Label + control + optional hint. Use `as="div"` when the control is not a
 * single labelable element (e.g. a button-based picker). */
export function Field({
  label,
  hint,
  as = 'label',
  className = '',
  children,
}: {
  label: ReactNode
  hint?: ReactNode
  as?: 'label' | 'div'
  className?: string
  children: ReactNode
}) {
  const Tag = as
  return (
    <Tag className={`flex flex-col gap-1.5 ${className}`}>
      <span className="text-xs font-medium text-ink-2">{label}</span>
      {children}
      {hint && <span className="text-xs text-ink-3">{hint}</span>}
    </Tag>
  )
}

export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
  title,
  className = '',
}: {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: ReactNode
  disabled?: boolean
  title?: string
  className?: string
}) {
  return (
    <label
      title={title}
      className={`inline-flex w-fit cursor-pointer items-center gap-2 text-sm text-ink-2 ${
        disabled ? 'cursor-default opacity-50' : ''
      } ${className}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={label ? undefined : title}
        className="h-4 w-4 shrink-0"
      />
      {label}
    </label>
  )
}

// ---------------------------------------------------------------------------
// Status and feedback
// ---------------------------------------------------------------------------

export type Tone = 'neutral' | 'accent' | 'warn' | 'danger' | 'overlay' | 'danger-solid'

const BADGE_TONE: Record<Tone, string> = {
  neutral: 'bg-white/5 text-ink-2',
  accent: 'bg-accent/15 text-accent',
  warn: 'bg-warn/15 text-warn',
  danger: 'bg-danger/15 text-danger',
  overlay: 'bg-bg/75 text-ink-1 backdrop-blur-sm',
  'danger-solid': 'bg-danger/90 text-bg',
}

export function Badge({
  tone = 'neutral',
  dot = false,
  pulse = false,
  title,
  className = '',
  children,
}: {
  tone?: Tone
  dot?: boolean
  pulse?: boolean
  title?: string
  className?: string
  children: ReactNode
}) {
  return (
    <span
      title={title}
      className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${BADGE_TONE[tone]} ${className}`}
    >
      {dot && (
        <span
          className={`h-1.5 w-1.5 rounded-full bg-current ${pulse ? 'animate-pulse shadow-[0_0_8px_currentColor]' : ''}`}
        />
      )}
      {children}
    </span>
  )
}

const STATUS_TONE: Record<string, string> = {
  done: 'text-accent',
  error: 'text-danger',
  pending: 'text-warn',
}

/** Compact inline status (dot + label) for dense rows and cards. */
export function StatusDot({ status, label }: { status: string; label: ReactNode }) {
  const color = STATUS_TONE[status] ?? 'text-ink-3'
  return (
    <span className={`inline-flex items-center gap-1.5 ${color}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label}
    </span>
  )
}

type BarTone = 'accent' | 'muted' | 'warn'

const BAR_TONE: Record<BarTone, string> = {
  accent: 'bg-accent',
  muted: 'bg-accent/60',
  warn: 'bg-warn',
}

export function ProgressBar({
  percent,
  tone = 'accent',
  showLabel = true,
  className = '',
}: {
  percent: number
  tone?: BarTone
  showLabel?: boolean
  className?: string
}) {
  const p = Math.max(0, Math.min(100, percent))
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div
        role="progressbar"
        aria-valuenow={Math.round(p)}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 flex-1 overflow-hidden rounded-full bg-bg/70"
      >
        <div className={`h-full rounded-full transition-all ${BAR_TONE[tone]}`} style={{ width: `${p}%` }} />
      </div>
      {showLabel && (
        <span className="w-9 text-right text-[11px] font-semibold tabular-nums text-ink-2">{Math.round(p)}%</span>
      )}
    </div>
  )
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <div
      role="status"
      className={`h-5 w-5 animate-spin rounded-full border-2 border-line border-t-accent ${className}`}
    />
  )
}

export function LoadingPane({ className = '' }: { className?: string }) {
  return (
    <div className={`grid place-items-center py-16 ${className}`}>
      <Spinner />
    </div>
  )
}

export function EmptyState({ text }: { text: string }) {
  return (
    <div className="flex items-center justify-center py-16">
      <p className="max-w-md text-center text-sm text-ink-3">{text}</p>
    </div>
  )
}

/** Inline error/info notice inside a form or panel. */
export function Notice({ tone = 'danger', children }: { tone?: 'danger' | 'accent'; children: ReactNode }) {
  const style =
    tone === 'danger' ? 'border-danger/30 bg-danger/10 text-danger' : 'border-accent/40 bg-accent/10 text-ink-2'
  return <div className={`rounded-xl border px-3.5 py-2.5 text-sm ${style}`}>{children}</div>
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

/** Overlay dialog. Closes on Escape and on a click on the backdrop.
 * `panel` centres a card; `fullscreen` hands the whole viewport to the
 * children (lightboxes). */
export function Modal({
  onClose,
  label,
  variant = 'panel',
  className = '',
  children,
}: {
  onClose: () => void
  label: string
  variant?: 'panel' | 'fullscreen'
  className?: string
  children: ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (variant === 'fullscreen') {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`fixed inset-0 z-50 flex flex-col bg-black/90 ${className}`}
        onClick={onClose}
      >
        {children}
      </div>
    )
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4 sm:p-6"
      onClick={onClose}
    >
      <div
        className={`max-h-[90vh] w-full overflow-auto rounded-2xl border border-line bg-surface-2 p-5 shadow-card ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

/** Hover/focus tooltip below its trigger, replacing the native `title`
 * attribute (slow, unstyled). Pure CSS: shown on hover or keyboard focus of
 * the wrapped element. `align` picks the edge the bubble lines up with. */
export function Tooltip({
  content,
  align = 'center',
  children,
}: {
  content: ReactNode
  align?: 'center' | 'right'
  children: ReactNode
}) {
  const position = align === 'right' ? 'right-0' : 'left-1/2 -translate-x-1/2'
  return (
    <span className="group/tooltip relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute top-full z-40 mt-2 w-max max-w-xs ${position} rounded-xl border border-line bg-surface-2 px-3 py-2 text-xs leading-relaxed text-ink-2 opacity-0 shadow-card transition-opacity duration-150 group-hover/tooltip:opacity-100 group-hover/tooltip:delay-150 group-focus-within/tooltip:opacity-100`}
      >
        {content}
      </span>
    </span>
  )
}
