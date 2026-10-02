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

export async function accountSession(fetcher = fetch) {
  const response=await fetcher('/api/auth/session',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(8000)});
  const data=await response.json();
  if(!response.ok)throw Error(data.error||'无法连接账户服务。');
  return data;
}
export async function accountRequest(path,options={},fetcher=fetch) {
  const method=options.method||'GET',headers=new Headers(options.headers);
  if(!['GET','HEAD'].includes(method.toUpperCase())) {
    const session=await accountSession(fetcher);
    headers.set('X-CSRF-Token',session.csrfToken);
  }
  const response=await fetcher('/api/'+path,{...options,headers,credentials:'same-origin',cache:'no-store'});
  const data=await response.json();
  if(!response.ok)throw Object.assign(Error(data.error||'请求失败，请重试。'),{status:response.status});
  return data;
}
