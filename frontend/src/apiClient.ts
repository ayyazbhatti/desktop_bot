/**
 * Optional shared secret when `PANEL_API_KEY` is set on the API.
 * - Dev: prefer `PANEL_API_KEY` in `.env` so Vite proxy adds `X-Panel-Api-Key` (not bundled).
 * - Prod static hosting: set `VITE_PANEL_API_KEY` at build time (exposed in JS) or terminate TLS at a proxy that injects the header.
 */
const PANEL_KEY = import.meta.env.VITE_PANEL_API_KEY as string | undefined

export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  if (PANEL_KEY?.trim() && !headers.has('X-Panel-Api-Key')) {
    headers.set('X-Panel-Api-Key', PANEL_KEY.trim())
  }
  return fetch(input, { ...init, headers, credentials: 'include' })
}

/** WebSocket URLs cannot send custom headers in the browser; append `panel_key` when using `VITE_PANEL_API_KEY`. */
export function appendPanelKeyToWsUrl(url: string): string {
  const k = PANEL_KEY?.trim()
  if (!k) return url
  const sep = url.includes('?') ? '&' : '?'
  return `${url}${sep}panel_key=${encodeURIComponent(k)}`
}
