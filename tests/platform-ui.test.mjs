import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {loadTool,vue,window,waitFor} from './helpers/tool-dom.mjs';

globalThis.history=window.history;
const require=createRequire(import.meta.url);
const {createRouter,createMemoryHistory,RouterView}=require('vue-router');
const Platform=(await import(await loadTool('src/views/Platform.vue'))).default;
const PhotoMedia=(await import(await loadTool('src/components/photography/PhotoMedia.vue'))).default;
const {useReveal}=await import(await loadTool('src/composables/useReveal.js'));
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve}};
const work=(id,overrides={})=>({id,kind:'work',title:`作品 ${id}`,text:'照片说明',photographer:'owner-private-identifier',photographerName:'林间',assets:[`${id}-photo`],media:[{id:`${id}-photo`,width:1200,height:800}],status:'published',visibility:'public',allowOriginal:false,...overrides});
const square=(works=[],nextCursor=null)=>({works,banner:[],nextCursor});
const button=(host,label)=>[...host.querySelectorAll('button')].find(item=>{
 if(item.getAttribute('aria-label')===label)return true;
 const content=item.cloneNode(true);for(const hidden of content.querySelectorAll('[aria-hidden=true]'))hidden.remove();
 return content.textContent.trim()===label;
});
let mountSequence=0;

async function mountPage(path,fetcher){
 const previous=globalThis.fetch,previousHistory=window.history.state,calls=[],historyPosition=++mountSequence*100;
 window.history.replaceState({position:historyPosition},'');
 globalThis.fetch=async(url,options={})=>{calls.push({url,options});return fetcher(url,options)};
 const router=createRouter({history:createMemoryHistory(),routes:[
  {path:'/',component:Platform},{path:'/work/:id',component:Platform},
  {path:'/collection/:id',component:Platform},{path:'/profile/:owner',component:Platform},
  {path:'/tools',component:{template:'<h1>工具箱</h1>'}},{path:'/studio',component:{template:'<h1>工作台</h1>'}}
 ]});
 await router.push(path);await router.isReady();
 const host=document.createElement('div');document.body.append(host);
 const app=vue.createApp({render:()=>vue.h(RouterView)});app.use(router);app.mount(host);
 return {host,router,calls,historyPosition,close(){app.unmount();host.remove();globalThis.fetch=previous;window.history.replaceState(previousHistory,'')}};
}

test('public square distinguishes delayed loading from a successful empty result without an identity prerequisite',async()=>{
 const pending=deferred();
 const m=await mountPage('/',url=>{assert.equal(url,'/api/square?limit=12');return pending.promise});
 try{
  await waitFor(()=>m.calls.length===1);
  assert.ok(m.host.querySelector('[role=status]'));
  assert.doesNotMatch(m.host.textContent,/还没有作品|暂无公开|没有公开作品/);
  assert.equal(m.host.querySelector('a[href^="/work/"]'),null);
  pending.resolve(response(square()));
  await waitFor(()=>/还没有|暂无|尚无|没有公开/.test(m.host.textContent));
  assert.equal(m.host.querySelector('[role=alert]'),null);
  assert.equal(m.calls.length,1);
 }finally{pending.resolve(response(square()));m.close()}
});

test('square failure stays distinct from empty and retry replaces it with fetched work',async()=>{
 let attempts=0;
 const m=await mountPage('/',async()=>++attempts===1?response({error:'广场暂不可用。'},503):response(square([work('recovered')])));
 try{
  await waitFor(()=>m.host.querySelector('[role=alert]'));
  assert.match(m.host.textContent,/广场暂不可用/);
  assert.doesNotMatch(m.host.textContent,/还没有作品|暂无公开|没有公开作品/);
  const retry=button(m.host,'重试');assert.ok(retry);retry.click();
  await waitFor(()=>m.host.querySelector('a[href="/work/recovered"]'));
  assert.equal(attempts,2);assert.equal(m.host.querySelector('[role=alert]'),null);
 }finally{m.close()}
});

test('rapid work navigation aborts the previous request and ignores its late completion',async()=>{
 const oldRequest=deferred();let oldSignal;
 const m=await mountPage('/work/old',(url,options)=>{
  if(url==='/api/work/old'){oldSignal=options.signal;return oldRequest.promise}
  if(url==='/api/work/current')return response(work('current',{title:'当前作品'}));
  throw Error(`Unexpected request: ${url}`);
 });
 try{
  await waitFor(()=>oldSignal);
  await m.router.push('/work/current');
  await waitFor(()=>m.host.textContent.includes('当前作品'));
  assert.equal(oldSignal.aborted,true);
  oldRequest.resolve(response(work('old',{title:'过时作品'})));
  await oldRequest.promise;await new Promise(setImmediate);await vue.nextTick();
  assert.match(m.host.textContent,/当前作品/);assert.doesNotMatch(m.host.textContent,/过时作品/);
  assert.ok(m.host.querySelector('img[src*="current-photo"]'));
 }finally{oldRequest.resolve(response(work('old')));m.close()}
});

test('viewer arrows navigate a group repeatedly while editable targets keep their native keys',async()=>{
 const record=work('group',{assets:['first','second'],media:[{id:'first',width:1200,height:800},{id:'second',width:800,height:1200}]});
 const m=await mountPage('/work/group',async()=>response(record));
 try{
  await waitFor(()=>button(m.host,'下一张照片'));
  const next=button(m.host,'下一张照片');
  next.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));
  await vue.nextTick();assert.ok(m.host.querySelector('img[src*="/second/"]'));
  assert.match(m.host.querySelector('[aria-live]')?.textContent||'',/2\s*\/\s*2/);
  next.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true}));
  await vue.nextTick();assert.ok(m.host.querySelector('img[src*="/first/"]'));
  for(const tag of ['input','textarea','select','div']){
   const editable=document.createElement(tag);let target=editable;
   if(tag==='div'){editable.setAttribute('contenteditable','true');target=document.createElement('span');editable.append(target)}
   next.parentElement.append(editable);
   const event=new window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,cancelable:true});target.dispatchEvent(event);
   await vue.nextTick();assert.equal(event.defaultPrevented,false);assert.ok(m.host.querySelector('img[src*="/first/"]'));
   editable.remove();
  }
  const modified=new window.KeyboardEvent('keydown',{key:'ArrowRight',ctrlKey:true,bubbles:true,cancelable:true});next.dispatchEvent(modified);
  await vue.nextTick();assert.equal(modified.defaultPrevented,false);assert.ok(m.host.querySelector('img[src*="/first/"]'));
  button(m.host,'上一张照片').click();await vue.nextTick();assert.ok(m.host.querySelector('img[src*="/second/"]'));
 }finally{m.close()}
});

test('failed additional page retains existing photos and retry appends without refetching the first page',async()=>{
 let pages=0;const pending=deferred();
 const m=await mountPage('/',url=>{
  if(url==='/api/square?limit=12')return response(square([work('first-page')],'first-page'));
  assert.equal(url,'/api/square?limit=12&cursor=first-page');pages++;
  return pages===1?pending.promise:response(square([work('second-page')]));
 });
 try{
  await waitFor(()=>button(m.host,'继续浏览'));
  const first=m.host.querySelector('a[href="/work/first-page"]');assert.ok(first);
  const more=button(m.host,'继续浏览');more.click();more.click();
  await waitFor(()=>pages===1);assert.equal(m.host.querySelector('a[href="/work/first-page"]'),first);
  pending.resolve(response({error:'下一页载入失败。'},503));
  await waitFor(()=>m.host.querySelector('[role=alert]'));
  assert.equal(m.host.querySelector('a[href="/work/first-page"]'),first);
  button(m.host,'重试').focus();button(m.host,'重试').click();
  await waitFor(()=>m.host.querySelector('a[href="/work/second-page"]'));
  await waitFor(()=>document.activeElement?.id==='photo-work-second-page');
  assert.equal(pages,2);assert.equal(m.host.querySelector('a[href="/work/first-page"]'),first);
  assert.equal(m.calls.filter(call=>call.url==='/api/square?limit=12').length,1);
  assert.equal(button(m.host,'继续浏览'),undefined);assert.equal(m.host.querySelector('[role=alert]'),null);
 }finally{pending.resolve(response(square()));m.close()}
});

test('public attribution uses an actual public name or neutral fallback, never the owner identifier',async()=>{
 const m=await mountPage('/',async()=>response(square([work('named'),work('unnamed',{photographerName:null})])));
 try{
  await waitFor(()=>m.host.querySelector('a[href="/work/unnamed"]'));
  assert.match(m.host.textContent,/林间/);assert.match(m.host.textContent,/摄影师/);
  assert.doesNotMatch(m.host.textContent,/owner-private-identifier/);
  assert.ok(m.host.querySelector('a[href="/profile/owner-private-identifier"]'));
 }finally{m.close()}
});

test('actual photo link navigation returns through a fresh read and restores the originating link focus',async()=>{
 let reads=0;
 const m=await mountPage('/',async url=>{
  if(url==='/api/square?limit=12')return response(square([work('origin',{title:++reads===1?'进入前标题':'重新校验后的标题'})]));
  if(url==='/api/work/origin')return response(work('origin'));
  throw Error(`Unexpected request: ${url}`);
 });
 const removeHistorySync=m.router.afterEach(to=>window.history.replaceState(to.path==='/'?{position:m.historyPosition}:{position:m.historyPosition+1,back:'/'},''));
 try{
  await waitFor(()=>m.host.querySelector('#photo-work-origin'));
  const origin=m.host.querySelector('#photo-work-origin');origin.focus();origin.click();
  await waitFor(()=>m.router.currentRoute.value.path==='/work/origin'&&button(m.host,'返回'));
  button(m.host,'返回').click();
  await waitFor(()=>m.router.currentRoute.value.path==='/'&&m.host.textContent.includes('重新校验后的标题'));
  await waitFor(()=>document.activeElement?.id==='photo-work-origin');
  assert.equal(reads,2);assert.equal(document.activeElement,m.host.querySelector('#photo-work-origin'));
 }finally{removeHistorySync();m.close()}
});

test('direct work entry has a working return to square without native history',async()=>{
 const m=await mountPage('/work/direct',async url=>url==='/api/work/direct'?response(work('direct')):response(square()));
 try{
  await waitFor(()=>button(m.host,'返回'));button(m.host,'返回').click();
  await waitFor(()=>m.router.currentRoute.value.path==='/'&&m.calls.some(call=>call.url==='/api/square?limit=12'));
  assert.equal(m.router.currentRoute.value.path,'/');
 }finally{m.close()}
});

test('return revalidates previously appended pages and falls back to the page heading when the origin is revoked',async()=>{
 let initialReads=0,additionalReads=0;
 const m=await mountPage('/',async url=>{
  if(url==='/api/square?limit=12'){initialReads++;return response(square([work('first')],'first'))}
  if(url==='/api/square?limit=12&cursor=first')return response(square(++additionalReads===1?[work('revoked')]:[]));
  if(url==='/api/work/revoked')return response(work('revoked'));
  throw Error(`Unexpected request: ${url}`);
 });
 const removeHistorySync=m.router.afterEach(to=>window.history.replaceState(to.path==='/'?{position:m.historyPosition}:{position:m.historyPosition+1,back:'/'},''));
 try{
  await waitFor(()=>button(m.host,'继续浏览'));button(m.host,'继续浏览').click();
  await waitFor(()=>m.host.querySelector('#photo-work-revoked'));
  m.host.querySelector('#photo-work-revoked').click();
  await waitFor(()=>m.router.currentRoute.value.path==='/work/revoked'&&button(m.host,'返回'));button(m.host,'返回').click();
  await waitFor(()=>m.router.currentRoute.value.path==='/'&&additionalReads===2&&m.host.querySelector('#photo-work-first'));
  await waitFor(()=>document.activeElement?.id==='public-page-title');
  assert.equal(initialReads,2);assert.equal(m.host.querySelector('#photo-work-revoked'),null);
  assert.equal(button(m.host,'继续浏览'),undefined);assert.equal(m.host.querySelector('[role=alert]'),null);
 }finally{removeHistorySync();m.close()}
});

test('failed page replay on return preserves freshly revalidated work and retries only the missing page',async()=>{
 let firstReads=0,additionalReads=0;
 const m=await mountPage('/',async url=>{
  if(url==='/api/square?limit=12'){firstReads++;return response(square([work('kept')],'kept'))}
  if(url==='/api/square?limit=12&cursor=kept')return ++additionalReads===2?response({error:'返回时第二页载入失败。'},503):response(square([work('later')]));
  if(url==='/api/work/later')return response(work('later'));
  throw Error(`Unexpected request: ${url}`);
 });
 const removeHistorySync=m.router.afterEach(to=>window.history.replaceState(to.path==='/'?{position:m.historyPosition}:{position:m.historyPosition+1,back:'/'},''));
 try{
  await waitFor(()=>button(m.host,'继续浏览'));button(m.host,'继续浏览').click();
  await waitFor(()=>m.host.querySelector('#photo-work-later'));m.host.querySelector('#photo-work-later').click();
  await waitFor(()=>m.router.currentRoute.value.path==='/work/later'&&button(m.host,'返回'));button(m.host,'返回').click();
  await waitFor(()=>m.router.currentRoute.value.path==='/'&&m.host.querySelector('[role=alert]'));
  assert.ok(m.host.querySelector('#photo-work-kept'));assert.equal(m.host.querySelector('#photo-work-later'),null);
  assert.match(m.host.textContent,/返回时第二页载入失败/);
  button(m.host,'重试').click();await waitFor(()=>m.host.querySelector('#photo-work-later'));
  assert.equal(firstReads,2);assert.equal(additionalReads,3);assert.equal(m.host.querySelector('[role=alert]'),null);
 }finally{removeHistorySync();m.close()}
});

test('a delayed public response does not steal focus after the user moved to another control',async()=>{
 const pending=deferred(),m=await mountPage('/',()=>pending.promise);
 const navigation=document.createElement('button');navigation.textContent='导航目标';document.body.append(navigation);
 try{
  await waitFor(()=>m.host.querySelector('[role=status]'));navigation.focus();
  pending.resolve(response(square([work('arrived')])));await waitFor(()=>m.host.querySelector('#photo-work-arrived'));
  await vue.nextTick();assert.equal(document.activeElement,navigation);
 }finally{pending.resolve(response(square()));navigation.remove();m.close()}
});

test('featured work has separate work and photographer links and is not repeated in the photo grid',async()=>{
 const featured=work('featured',{title:'精选作品',text:'一句简介。\n第二段。'});
 const m=await mountPage('/',async()=>response({...square([featured,work('ordinary')]),banner:[featured]}));
 try{
  await waitFor(()=>m.host.querySelector('.featured-photo'));
  const hero=m.host.querySelector('.featured-photo');
  assert.ok(hero.querySelector('a[href="/work/featured"]'));assert.ok(hero.querySelector('a[href="/profile/owner-private-identifier"]'));
  assert.equal(hero.querySelector('a a'),null);assert.match(hero.textContent,/一句简介/);assert.doesNotMatch(hero.textContent,/第二段/);
  assert.equal(m.host.querySelector('.photo-grid a[href="/work/featured"]'),null);
  assert.ok(m.host.querySelector('.photo-grid a[href="/work/ordinary"]'));
 }finally{m.close()}
});

test('a profile without cover keeps module order and an empty collection reports a successful empty state',async()=>{
 const profile={id:'profile-record',kind:'profile',name:'摄影师主页',bio:'介绍',cover:null,coverMedia:null,modules:['collections','works'],layout:'column',collections:[],works:[work('visible')]};
 const m=await mountPage('/profile/owner',async url=>response(url.startsWith('/api/profile/')?profile:{id:'empty-collection',kind:'collection',title:'空作品集',text:'说明',items:[]}));
 try{
  await waitFor(()=>m.host.querySelector('.profile-header'));
  assert.equal(m.host.querySelector('.profile-header img'),null);
  assert.deepEqual([...m.host.querySelectorAll('.profile-section h2')].map(item=>item.textContent),['作品集','作品']);
  assert.ok(m.host.querySelector('a[href="/work/visible"]'));
  await m.router.push('/collection/empty');await waitFor(()=>m.host.textContent.includes('此作品集暂时没有可查看的作品'));
  assert.equal(m.host.querySelector('[role=alert]'),null);assert.equal(m.host.querySelector('img'),null);
 }finally{m.close()}
});

test('photo failure exposes retry and a later media source starts a fresh accessible image state',async()=>{
 const props=vue.reactive({media:{id:'broken',width:1200,height:800},alt:'林间的照片'});
 const host=document.createElement('div');document.body.append(host);
 const app=vue.createApp({render:()=>vue.h(PhotoMedia,props)});app.mount(host);
 try{
  const initial=host.querySelector('img');assert.equal(initial.alt,'林间的照片');
  initial.dispatchEvent(new window.Event('error'));await vue.nextTick();
  assert.match(host.querySelector('[role=status]')?.textContent||'',/无法载入/);
  const retry=button(host,'重新载入');assert.ok(retry);retry.click();await vue.nextTick();
  assert.doesNotMatch(host.textContent,/无法载入/);
  const retried=host.querySelector('img');assert.notEqual(retried,initial);assert.ok(retried.src.includes('?retry=1'));
  retried.dispatchEvent(new window.Event('error'));await vue.nextTick();assert.match(host.textContent,/无法载入/);
  props.media={id:'replacement',width:800,height:1200};await vue.nextTick();
  const replacement=host.querySelector('img');assert.ok(replacement.src.includes('/replacement/'));
  assert.doesNotMatch(host.textContent,/无法载入/);assert.equal(host.querySelector('.photo-media').getAttribute('aria-busy'),'true');
  replacement.decode=async()=>{};
  replacement.dispatchEvent(new window.Event('load'));
  await waitFor(()=>host.querySelector('.photo-media').getAttribute('aria-busy')==='false');
  assert.doesNotMatch(host.textContent,/无法载入/);assert.equal(replacement.alt,'林间的照片');
 }finally{app.unmount();host.remove()}
});

test('text-only and single-photo works expose usable content without invented group navigation or original access',async()=>{
 const m=await mountPage('/work/text',async url=>response(url.endsWith('/text')?work('text',{title:'文字作品',assets:[],media:[],text:'只有文字也能观看。'}):work('single')));
 try{
  await waitFor(()=>m.host.textContent.includes('只有文字也能观看。'));
  assert.equal(m.host.querySelector('img'),null);assert.equal(button(m.host,'下一张照片'),undefined);
  await m.router.push('/work/single');await waitFor(()=>m.host.querySelector('img'));
  assert.equal(button(m.host,'上一张照片').disabled,true);assert.equal(button(m.host,'下一张照片').disabled,true);
  assert.equal(m.host.querySelector('a[href$="/original"]'),null);
 }finally{m.close()}
});

test('original download follows the active image only when allowed and disappears when another work is unavailable',async()=>{
 const group=work('download',{allowOriginal:true,assets:['original-a','original-b'],media:[{id:'original-a',width:1200,height:800},{id:'original-b',width:800,height:1200}]});
 const m=await mountPage('/work/download',async url=>url.endsWith('/download')?response(group):response({error:'内容不存在'},404));
 try{
  await waitFor(()=>m.host.querySelector('a[href="/api/media/original-a/original"]'));
  button(m.host,'下一张照片').click();await vue.nextTick();assert.ok(m.host.querySelector('a[href="/api/media/original-b/original"]'));
  await m.router.push('/work/unavailable');await waitFor(()=>m.host.querySelector('[role=alert]'));
  assert.equal(m.host.querySelector('img'),null);assert.equal(m.host.querySelector('a[href$="/original"]'),null);
  assert.doesNotMatch(m.host.textContent,/作品 download/);
 }finally{m.close()}
});

test('reveal is optional when IntersectionObserver is unavailable or reduced motion is requested',async()=>{
 const previousObserver=globalThis.IntersectionObserver,previousMedia=window.matchMedia;
 try{
  for(const reduce of [false,true]){
   let observed=0,animated=0;
   window.matchMedia=query=>({matches:reduce,media:query,addEventListener(){},removeEventListener(){}});
   if(reduce)globalThis.IntersectionObserver=class{constructor(){observed++}observe(){}unobserve(){}disconnect(){}};
   else delete globalThis.IntersectionObserver;
   const host=document.createElement('div');document.body.append(host);
   const app=vue.createApp({setup(){const root=vue.ref();vue.onMounted(()=>{root.value.animate=()=>{animated++;return {finished:Promise.resolve(),cancel(){}}}});useReveal(root,{key:`fallback-${reduce}`});return ()=>vue.h('button',{ref:root},'始终可见的作品')}});app.mount(host);
   try{
    await vue.nextTick();const control=host.querySelector('button');
    assert.equal(control.textContent,'始终可见的作品');assert.equal(control.hidden,false);assert.notEqual(control.style.opacity,'0');
    assert.equal(control.getAttribute('aria-hidden'),null);assert.equal(observed,0);assert.equal(animated,0);
    control.focus();assert.equal(document.activeElement,control);
   }finally{app.unmount();host.remove()}
  }
 }finally{window.matchMedia=previousMedia;if(previousObserver===undefined)delete globalThis.IntersectionObserver;else globalThis.IntersectionObserver=previousObserver}
});

test('old image decode and failure cannot change the loading state of a newer source',async()=>{
 const props=vue.reactive({media:{id:'old-photo',width:1200,height:800},alt:'当前照片'}),oldDecode=deferred();
 const host=document.createElement('div');document.body.append(host);
 const app=vue.createApp({render:()=>vue.h(PhotoMedia,props)});app.mount(host);
 try{
  const old=host.querySelector('img');old.decode=()=>oldDecode.promise;
  old.dispatchEvent(new window.Event('load'));
  props.media={id:'new-photo',width:800,height:1200};await vue.nextTick();
  const current=host.querySelector('img');assert.notEqual(current,old);
  oldDecode.resolve();old.dispatchEvent(new window.Event('error'));await vue.nextTick();await vue.nextTick();
  assert.equal(host.querySelector('.photo-media').getAttribute('aria-busy'),'true');
  assert.doesNotMatch(host.textContent,/无法载入/);
  current.decode=async()=>{};current.dispatchEvent(new window.Event('load'));
  await waitFor(()=>host.querySelector('.photo-media').getAttribute('aria-busy')==='false');
  assert.ok(current.src.includes('/new-photo/'));
 }finally{oldDecode.resolve();app.unmount();host.remove()}
});

test('reduced motion keeps successfully decoded photos visible without entrance animation',async()=>{
 const previous=window.matchMedia;window.matchMedia=query=>({matches:query.includes('prefers-reduced-motion'),media:query,addEventListener(){},removeEventListener(){}});
 const host=document.createElement('div');document.body.append(host);
 const app=vue.createApp({render:()=>vue.h(PhotoMedia,{media:{id:'still-photo',width:800,height:1200},alt:'静止照片'})});app.mount(host);
 try{
  const photo=host.querySelector('img');photo.decode=async()=>{};photo.dispatchEvent(new window.Event('load'));
  await waitFor(()=>host.querySelector('.photo-media').getAttribute('aria-busy')==='false');
  assert.equal(host.querySelector('.photo-media--decoded'),null);
  assert.equal(host.querySelector('.photo-media--error'),null);
  assert.equal(host.querySelector('img'),photo);assert.equal(photo.getAttribute('width'),'800');assert.equal(photo.getAttribute('height'),'1200');
 }finally{app.unmount();host.remove();window.matchMedia=previous}
});
