import { useQuery } from '@tanstack/react-query'
import { Navigate, Route, Routes } from 'react-router-dom'
import { api } from './api/client'
import Layout from './components/Layout'
import Login from './pages/Login'
import Overview from './pages/Overview'
import Library from './pages/Library'
import Duplicates from './pages/Duplicates'
import Rename from './pages/Rename'
import Metadata from './pages/Metadata'
import Tasks from './pages/Tasks'
import Settings from './pages/Settings'

interface AuthState {
  authenticated: boolean
  username: string | null
  needs_setup: boolean
}

export default function App() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['auth'],
    queryFn: () => api<AuthState>('/api/auth/check'),
  })

  if (isLoading) {
    return <div className="grid h-full place-items-center text-ink-3">…</div>
  }

  if (!data?.authenticated) {
    return <Login needsSetup={data?.needs_setup ?? false} onSuccess={() => refetch()} />
  }

  return (
    <Layout username={data.username ?? ''} onLogout={() => refetch()}>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/library" element={<Library />} />
        <Route path="/duplicates" element={<Duplicates />} />
        <Route path="/rename" element={<Rename />} />
        <Route path="/metadata" element={<Metadata />} />
        <Route path="/tasks" element={<Tasks />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  )
}
