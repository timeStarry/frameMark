export function safeReturnTo(value) {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || /[\\\r\n\u0000-\u001f]/.test(value)) return '/studio'
  const path = value.split(/[?#]/)[0]
  if (value.length > 2048 || !/^\/(?:studio|tools|frame-watermark|image-collage|(?:work|collection|profile)\/[A-Za-z0-9_-]+)?$/.test(path)) return '/studio'
  return value
}
export async function readSession(fetcher = fetch) {
  try {
    const response = await fetcher('/api/me', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000) })
    if (!response.ok) throw new Error('session unavailable')
    const session = await response.json()
    if (!session || !(session.user === null || typeof session.user === 'string')) throw new Error('invalid session')
    return session
  } catch { throw new Error('暂时无法连接身份服务，请稍后重试。') }
}
export async function requireStudioSession(to, fetcher = fetch) {
  if (to.path !== '/studio') return true
  try {
    const session = await readSession(fetcher)
    if (session.user) return true
  } catch { /* The login page reports connection failures; never admit anonymous studio access. */ }
  return { path: '/login', query: { returnTo: safeReturnTo(to.fullPath) } }
}

export function loginReturnTarget(session, returnTo) {
  return session?.user ? safeReturnTo(returnTo) : null
}
