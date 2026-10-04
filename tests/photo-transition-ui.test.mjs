// Behavioral DOM tests with a controlled View Transition API, not browser animation acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {loadTool,vue,window,waitFor} from './helpers/tool-dom.mjs';

globalThis.history=window.history;
globalThis.MutationObserver=window.MutationObserver;
const require=createRequire(import.meta.url),{createRouter,createMemoryHistory,RouterView}=require('vue-router');
const Platform=(await import(await loadTool('src/views/Platform.vue'))).default;
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject}};
const work=(id,mediaId=`${id}-photo`)=>({id,kind:'work',title:`作品 ${id}`,text:'说明',photographer:'public-owner',photographerName:'林间',assets:[mediaId],media:[{id:mediaId,width:1200,height:800}],allowOriginal:false,status:'published',visibility:'public'});
const square=works=>({works,banner:[],nextCursor:null});
const namedTargets=()=>[...document.querySelectorAll('*')].map(element=>({element,name:element.style?.getPropertyValue('view-transition-name')||element.style?.viewTransitionName||''})).filter(item=>item.name&&item.name!=='none');
const flush=async()=>{await new Promise(setImmediate);await vue.nextTick()};
const visibleRect=()=>({x:24,y:40,left:24,top:40,right:324,bottom:240,width:300,height:200,toJSON(){return this}});
let sequence=0;

function transitionStub({manual=false,holdSkipFinish=false}={}){
 const records=[];
 const start=update=>{
  const finish=deferred(),completion=deferred(),record={old:namedTargets(),next:[],skipped:0,updated:false,finish:finish.resolve};records.push(record);
  // A skipped browser transition still invokes its update callback.
  let started=false;
  record.runUpdate=()=>{if(!started){started=true;Promise.resolve().then(()=>update()).then(()=>{record.updated=true;record.next=namedTargets();completion.resolve()},completion.reject)}return completion.promise};
  record.updateCallbackDone=completion.promise;
  record.ready=record.updateCallbackDone.then(()=>{if(record.skipped)throw new DOMException('Skipped','AbortError')});
  record.finished=record.updateCallbackDone.catch(()=>{}).then(()=>finish.promise);
  record.skipTransition=()=>{record.skipped++;if(!holdSkipFinish)finish.resolve()};
  record.ready.catch(()=>{});record.updateCallbackDone.catch(()=>{});
  if(!manual)queueMicrotask(()=>record.runUpdate().catch(()=>{}));
  return record;
 };
 return {records,start,finish(){for(const record of records)record.finish()}};
}

async function mount(path,fetcher,{reduced=false,supported=true,start,transitionOptions}={}){
 const imagePrototype=window.HTMLImageElement.prototype;
 const previous={fetch:globalThis.fetch,history:window.history.state,matchMedia:window.matchMedia,transition:document.startViewTransition,imageRect:imagePrototype.getBoundingClientRect,imageComplete:Object.getOwnPropertyDescriptor(imagePrototype,'complete')};
 const transitions=transitionStub(transitionOptions),calls=[],position=++sequence*100;
 // Happy DOM has no layout or network image loading. Model a visible frame and
 // an incomplete image until each test explicitly supplies its load/decode.
 imagePrototype.getBoundingClientRect=visibleRect;
 Object.defineProperty(imagePrototype,'complete',{configurable:true,get(){return false}});
 window.matchMedia=query=>({matches:query.includes('prefers-reduced-motion')&&reduced,media:query,addEventListener(){},removeEventListener(){}});
 if(supported)document.startViewTransition=start||transitions.start;else delete document.startViewTransition;
 window.history.replaceState({position},'');
 globalThis.fetch=async(url,options={})=>{calls.push({url,options});return fetcher(url,options)};
 const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:Platform},{path:'/work/:id',component:Platform},{path:'/collection/:id',component:Platform},{path:'/profile/:owner',component:Platform},{path:'/tools',component:{template:'<h1>工具箱</h1>'}}]});
 await router.push(path);await router.isReady();
 const historyHook=router.afterEach(to=>window.history.replaceState(to.path==='/'?{position}:{position:position+1,back:path==='/'?'/':null},''));
 const host=document.createElement('div');document.body.append(host);
 const app=vue.createApp({render:()=>vue.h(RouterView)});app.use(router);app.mount(host);
 return {host,router,calls,transitions,async close(){app.unmount();host.remove();historyHook();transitions.finish();await flush();globalThis.fetch=previous.fetch;window.matchMedia=previous.matchMedia;window.history.replaceState(previous.history,'');imagePrototype.getBoundingClientRect=previous.imageRect;if(previous.imageComplete)Object.defineProperty(imagePrototype,'complete',previous.imageComplete);else delete imagePrototype.complete;if(previous.transition===undefined)delete document.startViewTransition;else document.startViewTransition=previous.transition}};
}

function imageGeometry(image){
 Object.defineProperties(image,{complete:{configurable:true,value:true},naturalWidth:{configurable:true,value:1200},naturalHeight:{configurable:true,value:800}});
 image.getBoundingClientRect=visibleRect;
}
async function loaded(image,decode=async()=>{}){
 imageGeometry(image);image.decode=decode;image.dispatchEvent(new window.Event('load'));await flush();
}
async function openPhoto(m,id){
 await waitFor(()=>m.host.querySelector(`#photo-work-${id} img`));
 const link=m.host.querySelector(`#photo-work-${id}`);await loaded(link.querySelector('img'));link.focus();link.click();
 return link;
}
async function finish(record){record.finish();await record.finished;await flush()}

test('actual photo link and Back transition only the same image after fresh reads and target decode',async()=>{
 const workRequest=deferred(),first=work('one','shared-photo'),duplicate=work('two','shared-photo');let squareReads=0;
 const m=await mount('/',url=>{
  if(url==='/api/square?limit=12'){squareReads++;return response(square([first,duplicate]))}
  if(url==='/api/work/one')return workRequest.promise;
  throw Error(`Unexpected request: ${url}`);
 });
 try{
  const origin=await openPhoto(m,'one');await waitFor(()=>m.transitions.records.length===1&&m.calls.some(call=>call.url==='/api/work/one'));
  const enter=m.transitions.records[0];assert.equal(enter.old.length,1);assert.equal(enter.old[0].element,origin.querySelector('img'));assert.equal(enter.old[0].name,'markr-photo');assert.equal(enter.updated,false);
  assert.ok(enter.old.every(item=>item.element.tagName==='IMG'));
  workRequest.resolve(response(first));await waitFor(()=>m.host.querySelector('.work-viewer img'));
  const target=m.host.querySelector('.work-viewer img'),decode=deferred();await loaded(target,()=>decode.promise);
  assert.equal(enter.updated,false);decode.resolve();await enter.updateCallbackDone;
  assert.equal(enter.next.length,1);assert.equal(enter.next[0].element,target);assert.equal(enter.next[0].name,enter.old[0].name);
  await finish(enter);assert.equal(namedTargets().length,0);
  m.host.querySelector('.work-viewer__back').click();await waitFor(()=>m.transitions.records.length===2&&squareReads===2);
  await waitFor(()=>m.host.querySelector('#photo-work-one img'));
  const restored=m.host.querySelector('#photo-work-one img');await loaded(restored);
  const back=m.transitions.records[1];await back.updateCallbackDone;
  assert.equal(back.old.length,1);assert.equal(back.old[0].element,target);assert.equal(back.next.length,1);assert.equal(back.next[0].element,restored);
  assert.equal(document.activeElement,m.host.querySelector('#photo-work-one'));
  assert.equal(m.calls.filter(call=>call.url==='/api/work/one').length,1);
  for(const call of m.calls){assert.equal(call.options.credentials,'same-origin');assert.equal(call.options.cache,'no-store')}
  await finish(back);assert.equal(namedTargets().length,0);assert.equal(document.documentElement.hasAttribute('data-markr-photo-transition'),false);
 }finally{workRequest.resolve(response(first));await m.close()}
});

test('permission and target image errors release the transition without retaining an old photo',async()=>{
 for(const failure of ['permission','image']){
  const record=work(`error-${failure}`),m=await mount('/',async url=>url==='/api/square?limit=12'?response(square([record])):failure==='permission'?response({error:'内容不存在'},404):response(record));
  try{
   await openPhoto(m,record.id);await waitFor(()=>m.transitions.records.length===1);
   const transition=m.transitions.records[0];
   if(failure==='permission')await waitFor(()=>m.host.querySelector('[role=alert]'));
   else{await waitFor(()=>m.host.querySelector('.work-viewer img'));m.host.querySelector('.work-viewer img').dispatchEvent(new window.Event('error'))}
   await waitFor(()=>transition.updated);assert.ok(transition.skipped>0);assert.equal(namedTargets().length,0);
   if(failure==='permission'){assert.equal(m.host.querySelector('img'),null);assert.match(m.host.textContent,/内容不存在/)}
   else assert.match(m.host.textContent,/无法载入/);
   assert.equal(document.documentElement.hasAttribute('data-markr-photo-transition'),false);
  }finally{await m.close()}
 }
});

test('a stalled destination cannot hold the transition update callback or block normal later rendering',async()=>{
 const pending=deferred(),record=work('slow'),m=await mount('/',url=>url==='/api/square?limit=12'?response(square([record])):pending.promise);
 try{
  await openPhoto(m,'slow');await waitFor(()=>m.transitions.records.length===1);
  const transition=m.transitions.records[0];await waitFor(()=>transition.updated,2000);
  assert.ok(transition.skipped>0);assert.equal(m.router.currentRoute.value.path,'/work/slow');assert.equal(namedTargets().length,0);
  pending.resolve(response(record));await waitFor(()=>m.host.querySelector('.work-viewer img'));await loaded(m.host.querySelector('.work-viewer img'));
  assert.equal(namedTargets().length,0);assert.equal(m.transitions.records.length,1);
 }finally{pending.resolve(response(record));await m.close()}
});

test('a newer navigation cancels the transition and stale destination response cannot replace the new page',async()=>{
 const pending=deferred(),record=work('stale');let signal;
 const m=await mount('/',(url,options)=>{
  if(url==='/api/square?limit=12')return response(square([record]));
  if(url==='/api/work/stale'){signal=options.signal;return pending.promise}
  if(url==='/api/work/current')return response(work('current'));
  throw Error(`Unexpected request: ${url}`);
 });
 try{
  await openPhoto(m,'stale');await waitFor(()=>signal&&m.transitions.records.length===1);
  const transition=m.transitions.records[0];await m.router.push('/work/current');await waitFor(()=>m.host.textContent.includes('作品 current'));
  await waitFor(()=>transition.updated);assert.ok(transition.skipped>0);assert.equal(signal.aborted,true);
  pending.resolve(response(record));await flush();assert.doesNotMatch(m.host.textContent,/作品 stale/);assert.equal(namedTargets().length,0);
 }finally{pending.resolve(response(record));await m.close()}
});

test('a host that delays the update callback cannot block routing and a late callback cannot navigate again',async()=>{
 const record=work('delayed-host'),m=await mount('/',async url=>response(url==='/api/square?limit=12'?square([record]):record),{transitionOptions:{manual:true}});
 try{
  await openPhoto(m,record.id);await waitFor(()=>m.transitions.records.length===1);
  const transition=m.transitions.records[0];assert.equal(m.router.currentRoute.value.path,'/');
  await waitFor(()=>m.router.currentRoute.value.path==='/work/delayed-host',2000);
  assert.ok(transition.skipped>0);assert.equal(namedTargets().length,0);
  await waitFor(()=>m.host.querySelector('.work-viewer img'));
  await transition.runUpdate();await flush();
  assert.equal(m.calls.filter(call=>call.url==='/api/work/delayed-host').length,1);assert.equal(namedTargets().length,0);
 }finally{await m.close()}
});

test('late completion of a superseded transition cannot remove a newer transition name or root ownership',async()=>{
 const oldRequest=deferred(),first=work('old-owner'),second=work('new-owner');
 const m=await mount('/',url=>{
  if(url==='/api/square?limit=12')return response(square([first,second]));
  if(url==='/api/work/old-owner')return oldRequest.promise;
  if(url==='/api/work/new-owner')return response(second);
  throw Error(`Unexpected request: ${url}`);
 },{transitionOptions:{holdSkipFinish:true}});
 try{
  await openPhoto(m,first.id);await waitFor(()=>m.transitions.records.length===1&&m.router.currentRoute.value.path==='/work/old-owner');
  const old=m.transitions.records[0];await m.router.push('/');await waitFor(()=>m.host.querySelector('#photo-work-new-owner'));
  await openPhoto(m,second.id);await waitFor(()=>m.transitions.records.length===2&&m.host.querySelector('.work-viewer img'));
  const current=m.transitions.records[1],image=m.host.querySelector('.work-viewer img');await loaded(image);await current.updateCallbackDone;
  const owner=document.documentElement.getAttribute('data-markr-photo-transition');assert.ok(owner);
  await finish(old);
  assert.equal(document.documentElement.getAttribute('data-markr-photo-transition'),owner);
  assert.equal(namedTargets().length,1);assert.equal(namedTargets()[0].element,image);
  await finish(current);assert.equal(namedTargets().length,0);
 }finally{oldRequest.resolve(response(first));await m.close()}
});

test('reduced motion, unsupported API and direct work entry retain ordinary navigation',async()=>{
 for(const options of [{reduced:true},{supported:false}]){
  const record=work('fallback'),m=await mount('/',async url=>response(url==='/api/square?limit=12'?square([record]):record),options);
  try{await openPhoto(m,'fallback');await waitFor(()=>m.host.querySelector('.work-viewer'));assert.equal(m.transitions.records.length,0);assert.equal(namedTargets().length,0);assert.equal(document.documentElement.hasAttribute('data-markr-photo-transition'),false)}finally{await m.close()}
 }
 const direct=await mount('/work/direct',async()=>response(work('direct')));
 try{await waitFor(()=>direct.host.querySelector('.work-viewer'));assert.equal(direct.transitions.records.length,0);assert.equal(namedTargets().length,0)}finally{await direct.close()}
});

test('an exception starting the browser transition falls back to one normal navigation',async()=>{
 const record=work('start-failed'),m=await mount('/',async url=>response(url==='/api/square?limit=12'?square([record]):record),{start(){throw Error('Host transition unavailable')}});
 try{
  await openPhoto(m,record.id);await waitFor(()=>m.host.querySelector('.work-viewer img'));
  assert.equal(m.router.currentRoute.value.path,'/work/start-failed');assert.equal(m.calls.filter(call=>call.url==='/api/work/start-failed').length,1);
  assert.equal(namedTargets().length,0);assert.equal(document.documentElement.hasAttribute('data-markr-photo-transition'),false);
 }finally{await m.close()}
});

// Keep this last: the conservative authorization latch intentionally survives
// component teardown for the document's entire lifetime after speculation.
test('a previously speculative document waits for fresh HEAD permission before matching the viewer image',async()=>{
 const {createAdjacentPreloader}=await import(await loadTool('src/composables/useAdjacentPreload.js'));
 const seed=createAdjacentPreloader({document,window,navigator:{onLine:true},imageFactory:()=>({src:'',decode:async()=>{}})});
 seed.update({workId:'seed',ids:['seed-current','seed-adjacent'],index:0});seed.decoded('seed-current');seed.dispose();
 for(const permitted of [true,false]){
  const authorization=deferred(),record=work(permitted?'allowed':'denied','guarded-photo');
  const m=await mount('/',(url,options)=>{
   if(url==='/api/square?limit=12')return response(square([record]));
   if(url===`/api/work/${record.id}`)return response(record);
   assert.equal(url,'/api/media/guarded-photo/display');assert.equal(options.method,'HEAD');return authorization.promise;
  });
  try{
   await openPhoto(m,record.id);await waitFor(()=>m.transitions.records.length===1&&m.calls.some(call=>call.options.method==='HEAD'));
   const transition=m.transitions.records[0],head=m.calls.find(call=>call.options.method==='HEAD');
   assert.equal(transition.updated,false);assert.equal(m.host.querySelector('.work-viewer img'),null);
   assert.equal(head.options.credentials,'same-origin');assert.equal(head.options.cache,'no-store');assert.equal(head.options.mode,'same-origin');
   authorization.resolve(new Response(null,{status:permitted?200:404}));
   if(permitted){
    await waitFor(()=>m.host.querySelector('.work-viewer img'));assert.equal(transition.updated,false);
    const image=m.host.querySelector('.work-viewer img');await loaded(image);await transition.updateCallbackDone;
    assert.equal(transition.next.length,1);assert.equal(transition.next[0].element,image);assert.ok(image.src.endsWith('/api/media/guarded-photo/display'));
    await finish(transition);
   }else{
    await waitFor(()=>m.host.querySelector('.work-viewer [role=alert]'));await waitFor(()=>transition.updated);
    assert.ok(transition.skipped>0);assert.equal(m.host.querySelector('.work-viewer img'),null);assert.equal(namedTargets().length,0);
   }
  }finally{authorization.resolve(new Response(null,{status:404}));await m.close()}
 }
});
