import test from 'node:test'
import assert from 'node:assert/strict'
import { requireStudioSession, safeReturnTo, loginReturnTarget, readSession } from '../src/auth/session.mjs'
const sessionFetch=user=>async()=>({ok:true,json:async()=>({user})})
test('anonymous studio goes to independent login with original internal destination; signed-in access proceeds',async()=>{
 const to={path:'/studio',fullPath:'/studio?draft=sample#editor'}
 assert.deepEqual(await requireStudioSession(to,sessionFetch(null)),{path:'/login',query:{returnTo:to.fullPath}})
 assert.equal(await requireStudioSession(to,sessionFetch('qa-session')),true)
 let called=false
 assert.equal(await requireStudioSession({path:'/tools',fullPath:'/tools'},async()=>{called=true;throw Error('offline')}),true)
 assert.equal(called,false)
})
test('unavailable or malformed identity service fails closed and gives a retryable login state',async()=>{
 const to={path:'/studio',fullPath:'/studio'}
 assert.deepEqual(await requireStudioSession(to,async()=>{throw Error('network')}),{path:'/login',query:{returnTo:'/studio'}})
 await assert.rejects(()=>readSession(async()=>({ok:false})),/暂时无法连接身份服务/)
 await assert.rejects(()=>readSession(async()=>({ok:true,json:async()=>({user:{spoofed:true}})})),/暂时无法连接身份服务/)
})
test('returnTo accepts known internal pages and rejects external, encoded, malformed and login-loop destinations',()=>{
 for(const bad of ['https://example.com','//example.com','/\\example.com','/%2f%2fexample.com','/login?returnTo=/studio','/unknown','/studio\n','/../studio',null,['/tools']])assert.equal(safeReturnTo(bad),'/studio')
 for(const good of ['/','/studio?draft=sample','/tools','/frame-watermark','/image-collage','/work/sample-1','/profile/author_1'])assert.equal(safeReturnTo(good),good)
})
test('authenticated return uses stored internal target; anonymous state never fabricates login success',()=>{
 assert.equal(loginReturnTarget({user:null},'/studio'),null)
 assert.equal(loginReturnTarget({user:'qa-session'},'/studio?draft=sample'),'/studio?draft=sample')
 assert.equal(loginReturnTarget({user:'qa-session'},'https://example.com'),'/studio')
})
