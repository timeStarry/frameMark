// write.ts — the only path for non-GET requests (spec §3). Every write carries
// the session's CSRF token; a CSRF 403 refreshes the session and retries once.
import { refresh, session } from './session'

/**
 * status 0: network error or unreadable success body.
 * status -1: the request was aborted; callers ignore it.
 * `message` is the server's own Chinese text, shown as is.
 */
export type WriteResult<T> = { ok: true; status: number; data: T } | { ok: false; status: number; message: string }

export const NETWORK_MESSAGE = '网络连接出了问题'
const CSRF_MESSAGE = '会话校验失败，请刷新页面后重试。'
const ABORTED = -1

function isAbort(err: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (err instanceof DOMException && err.name === 'AbortError')
}

async function once<T>(
  method: string,
  url: string,
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<WriteResult<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (session.csrfToken) headers['X-CSRF-Token'] = session.csrfToken
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  const fail = (err: unknown): WriteResult<T> =>
    isAbort(err, signal)
      ? { ok: false, status: ABORTED, message: '' }
      : { ok: false, status: 0, message: NETWORK_MESSAGE }

  let res: Response
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    })
  } catch (err) {
    return fail(err)
  }
  if (!res.ok) {
    let message = ''
    try {
      const b = (await res.json()) as { error?: unknown }
      if (typeof b?.error === 'string') message = b.error
    } catch (err) {
      if (isAbort(err, signal)) return fail(err)
    }
    return { ok: false, status: res.status, message: message || `请求失败（${res.status}）` }
  }
  // 204 (e.g. DELETE /api/photos/{id}) and any empty 2xx body are success
  // with no data; a non-empty body that is not JSON is still a failure.
  if (res.status === 204 || res.headers.get('Content-Length') === '0') {
    return { ok: true, status: res.status, data: undefined as T }
  }
  let text: string
  try {
    text = await res.text()
  } catch (err) {
    return fail(err)
  }
  if (text === '') return { ok: true, status: res.status, data: undefined as T }
  try {
    return { ok: true, status: res.status, data: JSON.parse(text) as T }
  } catch {
    return { ok: false, status: 0, message: NETWORK_MESSAGE }
  }
}

export async function send<T>(
  method: 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<WriteResult<T>> {
  const r = await once<T>(method, url, body, signal)
  if (r.ok || r.status !== 403 || r.message !== CSRF_MESSAGE) return r
  await refresh()
  if (signal?.aborted) return { ok: false, status: ABORTED, message: '' }
  return once<T>(method, url, body, signal)
}
