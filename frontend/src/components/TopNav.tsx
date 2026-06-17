/**
 * Top navigation bar — the app's primary chrome.
 *
 * Left: brand (links to the Overview). Center: the four main functions.
 * Right: running Tasks, system Settings, theme/language toggles and the user
 * menu. Replaces the former left Sidebar + StatusBar.
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { NavLink, useNavigate } from 'react-router-dom'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { IconChevron, IconGear, IconLogout } from './icons'

const ACTIVE_TASK = new Set(['queued', 'running'])

const MAIN = [
  { to: '/library', key: 'nav_library' },
  { to: '/duplicates', key: 'nav_duplicates' },
  { to: '/rename', key: 'nav_rename' },
  { to: '/metadata', key: 'nav_metadata' },
]

export default function TopNav({
  username,
  onLogout,
}: {
  username: string
  onLogout: () => void
}) {
  const { t, lang, setLang } = useI18n()
  const navigate = useNavigate()
  const [menuOpen, setMenuOpen] = useState(false)

  // Surface whether a task is queued/running in the Tasks chip. Shares the
  // ['tasks'] cache with the Tasks page; polls slowly when nothing is active.
  const { data: tasks } = useQuery<{ status: string }[]>({
    queryKey: ['tasks'],
    queryFn: () => api<{ status: string }[]>('/api/tasks'),
    refetchInterval: (query) =>
      query.state.data?.some((x) => ACTIVE_TASK.has(x.status)) ? 2000 : 8000,
  })
  const taskActive = tasks?.some((x) => ACTIVE_TASK.has(x.status)) ?? false

  const { data: enrichStatus } = useQuery<{ active: boolean; paused: boolean }>({
    queryKey: ['enrichment', 'status'],
    queryFn: () => api<{ active: boolean; paused: boolean }>('/api/enrichment/status'),
    refetchInterval: (query) => (query.state.data?.active ? 5000 : 15000),
  })
  const enrichActive = (enrichStatus?.active && !enrichStatus?.paused) ?? false

  const logout = async () => {
    await api('/api/logout', { method: 'POST' })
    onLogout()
  }

  return (
    <header className="z-20 mx-3 mt-3 flex h-[58px] shrink-0 items-center gap-3 rounded-2xl border border-line bg-surface-1/85 px-3 shadow-card backdrop-blur-xl">
      {/* Brand → Overview */}
      <button
        onClick={() => navigate('/')}
        className="flex items-center gap-2.5 rounded-xl px-1.5 py-1 transition hover:bg-white/5"
      >
        <span className="grid h-8 w-8 place-items-center rounded-[10px] bg-gradient-to-br from-accent to-accent-2 font-head text-xs font-bold tracking-tight text-bg shadow-glow">
          ML
        </span>
        <span className="hidden font-head text-[15px] font-semibold tracking-tight sm:block">
          MediaLibManager
        </span>
      </button>

      {/* Main functions */}
      <nav className="ml-1 flex gap-0.5 rounded-xl border border-line bg-bg/50 p-1">
        {MAIN.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              [
                'rounded-lg px-3.5 py-2 text-[13.5px] font-medium transition',
                isActive
                  ? 'bg-gradient-to-br from-accent to-accent-2 text-bg shadow-glow'
                  : 'text-ink-2 hover:bg-white/5 hover:text-ink-1',
              ].join(' ')
            }
          >
            {t(item.key)}
          </NavLink>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-2">
        {/* Running tasks */}
        <NavLink
          to="/tasks"
          className={({ isActive }) =>
            [
              'flex h-9 items-center gap-2 rounded-xl border px-3 text-[13px] font-medium transition',
              isActive
                ? 'border-accent/50 bg-surface-3 text-ink-1'
                : 'border-line bg-surface-2 text-ink-2 hover:bg-surface-3 hover:text-ink-1',
            ].join(' ')
          }
        >
          <span
            className={`h-2 w-2 rounded-full ${
              taskActive
                ? 'animate-pulse bg-accent shadow-glow'
                : enrichActive
                  ? 'animate-pulse bg-warn'
                  : 'bg-ink-3/40'
            }`}
          />
          {t('nav_tasks')}
        </NavLink>

        {/* System settings */}
        <NavLink
          to="/settings"
          aria-label={t('nav_settings')}
          title={t('nav_settings')}
          className={({ isActive }) =>
            [
              'grid h-9 w-9 place-items-center rounded-xl border transition',
              isActive
                ? 'border-accent/50 bg-surface-3 text-ink-1'
                : 'border-line bg-surface-2 text-ink-2 hover:bg-surface-3 hover:text-ink-1',
            ].join(' ')
          }
        >
          <IconGear />
        </NavLink>

        <span className="mx-0.5 h-6 w-px bg-line" />

        {/* Language */}
        <button
          onClick={() => setLang(lang === 'de' ? 'en' : 'de')}
          className="h-9 rounded-xl border border-line bg-surface-2 px-3 text-xs font-semibold text-ink-2 transition hover:bg-surface-3 hover:text-ink-1"
        >
          {lang.toUpperCase()}
        </button>

        {/* User menu */}
        <div className="relative">
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="flex h-9 items-center gap-2 rounded-xl pl-1 pr-2 text-[13px] text-ink-2 transition hover:text-ink-1"
          >
            <span className="grid h-7 w-7 place-items-center rounded-[9px] bg-gradient-to-br from-surface-4 to-surface-3 font-head text-[13px] font-semibold text-accent">
              {username.slice(0, 1).toUpperCase() || 'U'}
            </span>
            <span className="hidden md:block">{username}</span>
            <IconChevron />
          </button>

          {menuOpen && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setMenuOpen(false)} />
              <div className="absolute right-0 z-40 mt-2 w-44 overflow-hidden rounded-xl border border-line bg-surface-2 p-1 shadow-card">
                <div className="px-3 py-2 text-[11px] uppercase tracking-wide text-ink-3">
                  {username}
                </div>
                <button
                  onClick={logout}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-ink-2 transition hover:bg-surface-3 hover:text-danger"
                >
                  <IconLogout />
                  {t('logout')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  )
}
