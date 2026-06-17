import { useState } from 'react'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { Button, Input } from '../components/ui'

export default function Login({
  needsSetup,
  onSuccess,
}: {
  needsSetup: boolean
  onSuccess: () => void
}) {
  const { t, lang, setLang } = useI18n()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (needsSetup && password !== confirmPassword) {
      setError(t('passwords_mismatch'))
      return
    }
    setBusy(true)
    setError('')
    try {
      const endpoint = needsSetup ? '/api/auth/initial-setup' : '/api/login'
      await api(endpoint, { method: 'POST', body: JSON.stringify({ username, password }) })
      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="grid h-full place-items-center p-4">
      <form
        onSubmit={submit}
        className="w-full max-w-sm rounded-2xl border border-line bg-surface-1/80 p-8 shadow-card backdrop-blur-xl"
      >
        <div className="mb-6 flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-to-br from-accent to-accent-2 font-head text-base font-bold tracking-tight text-bg shadow-glow">
            ML
          </span>
          <div>
            <h1 className="font-head text-lg font-semibold leading-tight">MediaLibManager</h1>
            <p className="text-xs text-ink-3">{needsSetup ? t('setup_title') : t('login_title')}</p>
          </div>
        </div>

        {needsSetup && (
          <div className="mb-6 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3">
            <p className="mb-1 text-sm font-semibold text-accent">{t('setup_first_run')}</p>
            <p className="text-xs leading-relaxed text-ink-2">{t('setup_info')}</p>
          </div>
        )}

        <label className="mb-1.5 block text-xs font-medium text-ink-2">{t('username')}</label>
        <Input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          className="mb-4 w-full"
        />

        <label className="mb-1.5 block text-xs font-medium text-ink-2">{t('password')}</label>
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete={needsSetup ? 'new-password' : 'current-password'}
          className="mb-4 w-full"
        />

        {needsSetup && (
          <>
            <label className="mb-1.5 block text-xs font-medium text-ink-2">{t('confirm_password')}</label>
            <Input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              autoComplete="new-password"
              className="mb-4 w-full"
            />
          </>
        )}

        {error && (
          <p className="mb-4 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
            {error}
          </p>
        )}

        <Button type="submit" disabled={busy} className="w-full">
          {needsSetup ? t('setup_btn') : t('submit')}
        </Button>

        <button
          type="button"
          onClick={() => setLang(lang === 'de' ? 'en' : 'de')}
          className="mt-4 block w-full text-center text-xs text-ink-3 transition hover:text-ink-1"
        >
          {lang.toUpperCase()}
        </button>
      </form>
    </div>
  )
}
