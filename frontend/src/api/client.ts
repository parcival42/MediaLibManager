/** Tiny JSON fetch helper. Throws on non-2xx with the backend's detail message. */
export async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  })
  if (!res.ok) {
    // A 401 on any call means the session is no longer valid (expired, or the
    // backing user was removed). Tell the app to re-check auth so it falls back
    // to the login / setup screen instead of leaving a stale shell clickable.
    if (res.status === 401) {
      window.dispatchEvent(new Event('auth:unauthorized'))
    }
    let detail = res.statusText
    try {
      detail = (await res.json()).detail || detail
    } catch {
      /* ignore non-JSON error bodies */
    }
    throw new Error(detail)
  }
  return res.json() as Promise<T>
}
