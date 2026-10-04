import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {loadTool,vue,window,waitFor} from './helpers/tool-dom.mjs'
globalThis.history=window.history
const require=createRequire(import.meta.url),{createRouter,createMemoryHistory}=require('vue-router')
const Login=(await import(await loadTool('src/views/Login.vue'))).default
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}})
async function mount(path,fetcher){
  const previous=globalThis.fetch;globalThis.fetch=fetcher
  const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:{template:'<p>广场</p>'}},{path:'/login',component:Login},{path:'/studio',component:{template:'<p>工作台</p>'}},{path:'/tools',component:{template:'<p>工具箱</p>'}}]})
  await router.push(path);await router.isReady()
  const host=document.createElement('div');document.body.append(host)
  const app=vue.createApp({render:()=>vue.h(require('vue-router').RouterView)});app.use(router);app.mount(host)
  return {host,router,close(){app.unmount();host.remove();globalThis.fetch=previous}}
}

test('account session failure keeps credentials hidden until retry resolves private trial requirements',async()=>{
  let reads=0
  const m=await mount('/login',async url=>{
    if(url==='/api/me')return response({user:null,identityEnabled:true})
    if(url==='/api/auth/session'){reads++;return reads===1?response({error:'账户服务暂不可用'},503):response({user:null,csrfToken:'c'.repeat(43),registrationOpen:true,privateTrial:true})}
    throw Error('unexpected request: '+url)
  })
  try{
    await waitFor(()=>m.host.textContent.includes('账户服务暂不可用'))
    assert.equal(m.host.querySelector('form'),null)
    assert.equal(m.host.querySelector('input[type=password]'),null)
    assert.equal(m.host.textContent.includes('登录暂未开放'),false)
    const retry=m.host.querySelector('[role=alert] button');assert.ok(retry);retry.click()
    await waitFor(()=>m.host.querySelector('input[type=checkbox]'))
    assert.match(m.host.textContent,/不要输入常用或正式密码/)
    assert.equal(m.host.querySelector('input[type=checkbox]').closest('label').className,'trial-check')
    assert.equal(m.host.querySelector('[role=alert]'),null)
  }finally{m.close()}
})

test('identity read failure is a retry state and never claims account service is closed',async()=>{
  const m=await mount('/login',async()=>{throw Error('fixture offline')})
  try{
    await waitFor(()=>m.host.querySelector('[role=alert] button'))
    assert.match(m.host.textContent,/暂时无法连接身份服务/)
    assert.equal(m.host.textContent.includes('登录暂未开放'),false)
    assert.equal(m.host.querySelector('form'),null)
  }finally{m.close()}
})

test('malformed verification fragment is removed while its error remains after session loading',async()=>{
  const calls=[]
  const m=await mount('/login?returnTo=%2Ftools#verify=broken',async url=>{calls.push(url);if(url==='/api/me')return response({user:null,identityEnabled:true});if(url==='/api/auth/session')return response({user:null,csrfToken:'c'.repeat(43),registrationOpen:true});throw Error('unexpected request')})
  try{
    await waitFor(()=>m.host.querySelector('form'))
    assert.equal(m.router.currentRoute.value.hash,'')
    assert.equal(m.router.currentRoute.value.query.returnTo,'/tools')
    assert.match(m.host.querySelector('[role=alert]').textContent,/验证链接格式无效/)
    assert.equal(m.host.querySelector('[role=alert] button'),null)
    assert.equal(calls.some(url=>url.includes('/verify')),false)
    assert.equal(m.host.querySelectorAll('input[type=password]').length,1)
  }finally{m.close()}
})

const flushAsync=async()=>{await new Promise(resolve=>setImmediate(resolve));await vue.nextTick()}

test('late authenticated session read cannot redirect after leaving the login page',async()=>{
  let finishRead,accountReads=0
  const m=await mount('/login',async url=>{
    if(url==='/api/me')return new Promise(resolve=>{finishRead=()=>resolve(response({user:'fixture-user',identityEnabled:true}))})
    if(url==='/api/auth/session'){accountReads++;return response({user:'fixture-user',csrfToken:'c'.repeat(43),registrationOpen:true})}
    throw Error('unexpected request: '+url)
  })
  try{
    await waitFor(()=>!!finishRead)
    await m.router.push('/tools');await vue.nextTick()
    finishRead();await flushAsync()
    assert.equal(m.router.currentRoute.value.path,'/tools')
    assert.equal(m.host.textContent,'工具箱')
    assert.equal(accountReads,0)
  }finally{m.close()}
})

test('late login POST success cannot replace a page opened while the request was pending',async()=>{
  let finishLogin,posts=0
  const m=await mount('/login',async url=>{
    if(url==='/api/me')return response({user:null,identityEnabled:true})
    if(url==='/api/auth/session')return response({user:null,csrfToken:'c'.repeat(43),registrationOpen:true})
    if(url==='/api/auth/login'){posts++;return new Promise(resolve=>{finishLogin=()=>resolve(response({user:'fixture-user',csrfToken:'d'.repeat(43)}))})}
    throw Error('unexpected request: '+url)
  })
  try{
    await waitFor(()=>m.host.querySelector('form'))
    for(const [selector,value] of [['input[type=email]','fixture@example.com'],['input[type=password]','isolated fixture long password']]){
      const input=m.host.querySelector(selector);input.value=value;input.dispatchEvent(new window.Event('input',{bubbles:true}))
    }
    m.host.querySelector('form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}))
    await waitFor(()=>!!finishLogin)
    await m.router.push('/tools');await vue.nextTick()
    finishLogin();await flushAsync()
    assert.equal(posts,1)
    assert.equal(m.router.currentRoute.value.path,'/tools')
    assert.equal(m.host.textContent,'工具箱')
  }finally{m.close()}
})
