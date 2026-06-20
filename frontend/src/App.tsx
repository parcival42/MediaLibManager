import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Navigate, Route, Routes } from 'react-router-dom'
import { api } from './api/client'
import Layout from './components/Layout'
import { LoadingPane } from './components/ui'
import Login from './pages/Login'
import Overview from './pages/Overview'
import Library from './pages/Library'
import Duplicates from './pages/Duplicates'
import Rename from './pages/Rename'
import Metadata from './pages/Metadata'
import Tasks from './pages/Tasks'
import Statistics from './pages/Statistics'
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
    refetchOnWindowFocus: true,
  })

  // Any 401 from a protected call re-checks auth, so a session that became
  // invalid mid-use drops back to the login / setup screen.
  useEffect(() => {
    const onUnauthorized = () => refetch()
    window.addEventListener('auth:unauthorized', onUnauthorized)
    return () => window.removeEventListener('auth:unauthorized', onUnauthorized)
  }, [refetch])

  if (isLoading) {
    return <LoadingPane className="h-full" />
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
        <Route path="/statistics" element={<Statistics />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  )
}
