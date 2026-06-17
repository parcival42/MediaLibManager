/** Shared UI primitives for the Studio Dark design system. */
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react'

type Variant = 'primary' | 'subtle' | 'ghost' | 'danger'
type Size = 'sm' | 'md'

const VARIANTS: Record<Variant, string> = {
  primary:
    'bg-gradient-to-br from-accent to-accent-2 text-bg font-semibold shadow-glow hover:brightness-110',
  subtle:
    'border border-line bg-surface-2 text-ink-2 hover:text-ink-1 hover:bg-surface-3 hover:border-surface-4',
  ghost: 'text-ink-2 hover:text-ink-1 hover:bg-white/5',
  danger:
    'bg-danger text-bg font-semibold shadow-[0_0_18px_-2px_rgba(251,113,133,0.55)] hover:brightness-110',
}

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
}

export function Button({
  variant = 'primary',
  size = 'md',
  className = '',
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: Size }) {
  return (
    <button
      className={`inline-flex items-center justify-center rounded-xl font-medium transition disabled:opacity-50 disabled:pointer-events-none ${VARIANTS[variant]} ${SIZES[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  )
}

export function Card({ className = '', children }: { className?: string; children: ReactNode }) {
  return (
    <div className={`rounded-2xl border border-line bg-surface-2 ${className}`}>{children}</div>
  )
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
      <div>
        <h1 className="font-head text-3xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-1.5 text-sm text-ink-3">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  )
}

export function Input({ className = '', ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`h-10 rounded-xl border border-line bg-surface-3 px-3.5 text-sm text-ink-1 placeholder:text-ink-3 outline-none transition focus:border-accent/70 focus:ring-2 focus:ring-accent/15 ${className}`}
      {...props}
    />
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
    <div className="flex gap-1 rounded-xl border border-line bg-bg/60 p-1">
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={`rounded-lg px-3.5 py-1.5 text-[13px] font-medium transition ${
              active
                ? 'bg-surface-3 text-accent shadow-sm'
                : 'text-ink-2 hover:text-ink-1 hover:bg-white/5'
            }`}
          >
            {o.label}
          </button>
        )
      })}
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

const STATUS_STYLE: Record<string, string> = {
  done: 'text-accent',
  error: 'text-danger',
  pending: 'text-warn',
}

export function StatusDot({ status }: { status: string }) {
  const color = STATUS_STYLE[status] ?? 'text-ink-3'
  return (
    <span className={`inline-flex items-center gap-1.5 ${color}`}>
      <span className="h-1.5 w-1.5 rounded-full bg-current shadow-[0_0_8px_currentColor]" />
      {status}
    </span>
  )
}
