import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createApp } from '../server/app.mjs';

test('persistent publication and media permissions across owners and visibility transitions',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'markr-'));
 const {app,store}=createApp({directory,viewer:req=>req.headers['x-test-viewer']||null});
 const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
 const base='http://127.0.0.1:'+server.address().port;
 const request=async(path,{user,body,method='GET'}={})=>{const headers={};if(user)headers['x-test-viewer']=user;if(body&&!(body instanceof FormData))headers['Content-Type']='application/json';const r=await fetch(base+'/api/'+path,{method,headers,body:body instanceof FormData?body:body?JSON.stringify(body):undefined});return {status:r.status,cache:r.headers.get('cache-control'),data:r.headers.get('content-type')?.includes('application/json')?await r.json():await r.arrayBuffer()}};
 try {
  assert.equal((await request('work',{method:'POST',body:{title:'unauthorized'}})).status,401);
  const bytes=await sharp({create:{width:64,height:48,channels:3,background:'#6699aa'}}).jpeg().withMetadata({exif:{IFD0:{Artist:'Markr QA metadata'}}}).toBuffer();
  assert.ok((await sharp(bytes).metadata()).exif);
  const form=new FormData();form.append('file',new Blob([bytes],{type:'image/jpeg'}),'photo.jpg');
  const uploaded=await request('assets',{user:'alice',method:'POST',body:form});assert.equal(uploaded.status,201);const asset=uploaded.data.id;
  const original=await request('media/'+asset+'/original',{user:'alice'});assert.deepEqual(Buffer.from(original.data),bytes);
  const display=await request('media/'+asset+'/display',{user:'alice'});assert.equal((await sharp(Buffer.from(display.data)).metadata()).exif,undefined);assert.equal(display.cache,'private, no-store');assert.equal('path' in uploaded.data,false);
  const draft=await request('work',{user:'alice',method:'POST',body:{title:'A photograph',assets:[asset],visibility:'public',tags:[{label:'街头',type:'content',visibility:'public'},{label:'待整理',type:'content',visibility:'private'},{label:'作者声明',type:'self_declaration',visibility:'public'}]}});assert.equal(draft.status,201);const id=draft.data.id;
  assert.equal((await request('work/'+id)).status,404);assert.equal((await request('media/'+asset+'/display')).status,404);
  assert.equal((await request('work/'+id,{user:'bob',method:'PUT',body:{title:'takeover'}})).status,404);
  assert.equal((await request('work',{user:'bob',method:'POST',body:{title:'foreign',assets:[asset]}})).status,404);
  assert.equal((await request('work/'+id,{user:'alice',method:'PUT',body:{status:'published'}})).status,200);
  assert.equal((await request('square')).data.works.length,1);assert.equal((await request('work/'+id)).data.tags.length,2);assert.equal((await request('studio',{user:'alice'})).data.work[0].tags.length,3);assert.equal((await request('work/'+id,{user:'alice',method:'PUT',body:{tags:[{label:'verified',type:'self_declaration',visibility:'public',source:'system'}]}})).status,400);assert.equal((await request('media/'+asset+'/display')).status,200);assert.equal((await request('media/'+asset+'/original')).status,404);
  await request('work/'+id,{user:'alice',method:'PUT',body:{distribute:false}});assert.equal((await request('square')).data.works.length,0);assert.equal((await request('work/'+id)).status,200);
  await request('work/'+id,{user:'alice',method:'PUT',body:{visibility:'unlisted'}});assert.equal((await request('work/'+id)).status,200);assert.equal((await request('square')).data.works.length,0);
  const hidden=(await request('work',{user:'alice',method:'POST',body:{title:'Hidden',text:'secret',status:'published'}})).data;
  const c=(await request('collection',{user:'alice',method:'POST',body:{title:'Portfolio',works:[id,hidden.id],status:'published',visibility:'public'}})).data;
  assert.equal((await request('collection/'+c.id)).data.items.length,1);assert.equal((await request('collection/'+c.id,{user:'alice'})).data.items.length,2);
  const p=await request('profile',{user:'alice',method:'POST',body:{name:'Alice',bio:'Photographer',accent:'#123456',modules:['collections','works']}});assert.equal(p.status,201);assert.equal((await request('profile/alice')).data.works.length,0);
  await request('work/'+id,{user:'alice',method:'PUT',body:{visibility:'public',allowOriginal:true}});assert.equal((await request('media/'+asset+'/original')).status,200);
  await request('work/'+id,{user:'alice',method:'PUT',body:{visibility:'private'}});assert.equal((await request('media/'+asset+'/display')).status,404);assert.equal((await request('media/'+asset+'/original')).status,404);
  await request('work/'+id,{user:'alice',method:'PUT',body:{status:'draft',visibility:'public'}});assert.equal((await request('work/'+id)).status,404);assert.equal((await request('media/'+asset+'/display')).status,404);
  assert.equal((await request('work/'+id,{user:'alice',method:'PUT',body:{assets:[asset,asset]}})).status,400);
  assert.equal((await request('work',{user:'alice',method:'POST',body:{title:'Empty',status:'published'}})).status,400);
  const invalid=new FormData();invalid.append('file',new Blob(['not an image']),'bad.jpg');assert.equal((await request('assets',{user:'alice',method:'POST',body:invalid})).status,400);
  assert.equal((await request('studio',{user:'alice'})).data.asset.length,1);
  store.db.close();const reopened=createApp({directory});assert.equal(reopened.store.get(id).title,'A photograph');reopened.store.db.close();
 }finally{await new Promise(r=>server.close(r));rmSync(directory,{recursive:true,force:true});}
});
test('default production identity rejects client-supplied identity headers',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'markr-'));const {app,store}=createApp({directory});const s=app.listen(0,'127.0.0.1');await new Promise(r=>s.once('listening',r));
 try{const r=await fetch('http://127.0.0.1:'+s.address().port+'/api/studio',{headers:{'x-test-viewer':'alice','x-user':'alice'}});assert.equal(r.status,401)}finally{await new Promise(r=>s.close(r));store.db.close();rmSync(directory,{recursive:true,force:true})}
});
