import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { buttonClass, Card, PageHeader } from '../components/ui'
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
      <PageHeader title={t('nav_overview')} subtitle={t('ov_subtitle')} />

      <Card className="mb-6 flex flex-wrap items-end justify-between gap-4 px-6 py-6 sm:px-8">
        <div>
          <div className="font-head text-6xl font-bold leading-none tabular-nums text-ink-1">
            {data ? data.total.toLocaleString() : '—'}
          </div>
          <p className="mt-2 text-sm text-ink-3">{t('files_indexed')}</p>
        </div>
        <Link to="/statistics" className={buttonClass('subtle', 'sm')}>
          {t('ov_files_link')}
        </Link>
      </Card>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {TILES.map((tile) => {
          const Icon = tile.icon
          return (
            <Link
              key={tile.to}
              to={tile.to}
              className="group flex flex-col rounded-2xl border border-line bg-surface-2 p-5 transition hover:border-surface-4 hover:bg-surface-3"
            >
              <span className="grid h-10 w-10 place-items-center rounded-xl border border-line bg-bg/50 text-accent transition group-hover:border-accent/40">
                <Icon width={20} height={20} />
              </span>
              <h2 className="mt-4 font-head text-base font-semibold">{t(tile.key)}</h2>
              <p className="mt-1.5 flex-1 text-[13px] leading-relaxed text-ink-3">{t(tile.descKey)}</p>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
