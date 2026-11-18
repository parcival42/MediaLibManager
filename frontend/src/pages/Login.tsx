import { useState } from 'react'
import { api } from '../api/client'
import { useI18n } from '../i18n'
import { Button, Checkbox, Field, Input, Notice } from '../components/ui'

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
  const [installRenameDefaults, setInstallRenameDefaults] = useState(true)
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
      const body = needsSetup
        ? { username, password, install_rename_defaults: installRenameDefaults }
        : { username, password }
      await api(endpoint, { method: 'POST', body: JSON.stringify(body) })
      onSuccess()
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : t('login_failed'))
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
          <div className="mb-6">
            <Notice tone="accent">
              <p className="mb-1 font-semibold text-accent">{t('setup_first_run')}</p>
              <p className="text-xs leading-relaxed">{t('setup_info')}</p>
            </Notice>
          </div>
        )}

        <div className="flex flex-col gap-4">
          <Field label={t('username')}>
            <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" />
          </Field>

          <Field label={t('password')}>
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete={needsSetup ? 'new-password' : 'current-password'}
            />
          </Field>

          {needsSetup && (
            <>
              <Field label={t('confirm_password')}>
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  autoComplete="new-password"
                />
              </Field>
              <Checkbox
                className="!text-xs"
                checked={installRenameDefaults}
                onChange={setInstallRenameDefaults}
                label={t('setup_install_rename_defaults')}
              />
            </>
          )}

          {error && <Notice>{error}</Notice>}

          <Button type="submit" disabled={busy} className="mt-2 w-full">
            {needsSetup ? t('setup_btn') : t('submit')}
          </Button>
        </div>

        <div className="mt-4 text-center">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setLang(lang === 'de' ? 'en' : 'de')}
            title={t('language_toggle')}
            aria-label={t('language_toggle')}
          >
            {lang.toUpperCase()}
          </Button>
        </div>
      </form>
    </div>
  )
}
