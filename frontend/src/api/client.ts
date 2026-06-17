/** Tiny JSON fetch helper. Throws on non-2xx with the backend's detail message. */
export async function api<T>(path: string, opts: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
    ...opts,
  })
  if (!res.ok) {
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
