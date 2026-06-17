import type { ReactNode } from 'react'
import TopNav from './TopNav'

export default function Layout({
  children,
  username,
  onLogout,
}: {
  children: ReactNode
  username: string
  onLogout: () => void
}) {
  return (
    <div className="flex h-full flex-col">
      <TopNav username={username} onLogout={onLogout} />
      <main className="min-w-0 flex-1 overflow-auto px-5 pb-10 pt-6 md:px-8">
        <div className="mx-auto w-full max-w-[1360px] h-full">{children}</div>
      </main>
    </div>
  )
}
