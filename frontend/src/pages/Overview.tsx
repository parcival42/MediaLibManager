import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { IconDup, IconImage, IconMeta, IconRename } from '../components/icons'
import type { SVGProps } from 'react'

interface Page {
  total: number
}

const TILES: {
  to: string
  key: string
  descKey: string
  icon: (p: SVGProps<SVGSVGElement>) => JSX.Element
}[] = [
  { to: '/library', key: 'nav_library', descKey: 'ov_library_desc', icon: IconImage },
  { to: '/duplicates', key: 'nav_duplicates', descKey: 'ov_dup_desc', icon: IconDup },
  { to: '/rename', key: 'nav_rename', descKey: 'ov_rename_desc', icon: IconRename },
  { to: '/metadata', key: 'nav_metadata', descKey: 'ov_meta_desc', icon: IconMeta },
]

export default function Overview() {
  const { t } = useI18n()
  const { data } = useQuery({
    queryKey: ['library', 'count'],
    queryFn: () => api<Page>('/api/library?limit=1'),
  })

  return (
    <div>
      {/* Hero */}
      <div className="relative mb-8 overflow-hidden rounded-3xl border border-line bg-gradient-to-br from-surface-2 to-surface-3 px-10 py-12">
        <div className="pointer-events-none absolute -right-20 -top-20 h-80 w-80 rounded-full bg-accent/6 blur-3xl" />
        <p className="mb-4 text-[11px] font-semibold uppercase tracking-widest text-ink-3">
          {t('ov_subtitle')}
        </p>
        <div className="font-head text-[72px] font-bold leading-none tabular-nums text-ink-1 sm:text-[88px]">
          {data ? data.total.toLocaleString() : '—'}
        </div>
        <p className="mt-3 text-sm text-ink-3">{t('files_indexed')}</p>
      </div>

      {/* Nav tiles */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {TILES.map((tile) => {
          const Icon = tile.icon
          return (
            <Link
              key={tile.to}
              to={tile.to}
              className="group flex flex-col rounded-2xl border border-line bg-surface-2 p-5 transition hover:-translate-y-1 hover:border-surface-4 hover:shadow-card"
            >
              <span className="grid h-11 w-11 place-items-center rounded-xl border border-line bg-bg/50 text-accent transition group-hover:border-accent/40">
                <Icon width={20} height={20} />
              </span>
              <h3 className="mt-4 font-head text-base font-semibold">{t(tile.key)}</h3>
              <p className="mt-1.5 flex-1 text-[13px] leading-relaxed text-ink-3">{t(tile.descKey)}</p>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
