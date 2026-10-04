import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createApp } from '../server/app.mjs';

async function fixture(run) {
  const directory=mkdtempSync(join(tmpdir(),'markr-presentation-'));
  const {app,store}=createApp({directory,viewer:req=>req.headers['x-test-viewer']||null});
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}/api/`;
  const get=async(path,user)=>{const r=await fetch(base+path,{headers:user?{'x-test-viewer':user}:{}});return {status:r.status,data:await r.json()}};
  try {await run({base,store,get,directory});}
  finally {await new Promise(resolve=>server.close(resolve));store.db.close();rmSync(directory,{recursive:true,force:true});}
}
const work=(title,extra={})=>({title,text:title,assets:[],status:'published',visibility:'public',distribute:true,...extra});

test('square pagination is stable across inserts and revoked cursor access, with truthful attribution',()=>fixture(async({store,get})=>{
  for(let n=1;n<=5;n++) store.save('work','alice',work(`Photo ${n}`,n===2?{featuredRank:1}:{}),`work-${n}`);
  store.save('work','alice',work('Private',{visibility:'private',featuredRank:2}),'private');
  store.save('work','alice',work('Unlisted',{visibility:'unlisted',featuredRank:3}),'unlisted');
  store.save('work','alice',work('No distribution',{distribute:false}),'no-distribution');
  store.save('work','alice',work('Draft',{status:'draft'}),'draft');
  const first=(await get('square?limit=2')).data;
  assert.deepEqual(first.works.map(w=>w.id),['work-5','work-4']);
  assert.equal(first.nextCursor,'work-4');
  assert.equal(first.works[0].photographerName,null);
  assert.deepEqual(first.banner.map(w=>w.id),['work-2']);
  store.save('profile','alice',{name:'山与海',status:'published',visibility:'public'},'profile');
  store.save('work','alice',work('New arrival'),'new-arrival');
  store.save('work','alice',work('Now private',{visibility:'private'}),'work-4');
  const second=(await get('square?limit=2&cursor='+first.nextCursor)).data;
  assert.deepEqual(second.works.map(w=>w.id),['work-3','work-2']);
  assert.ok(second.works.every(w=>w.photographerName==='山与海'&&w.photographer==='alice'&&!Object.hasOwn(w,'owner')));
  const last=(await get('square?limit=2&cursor='+second.nextCursor)).data;
  assert.deepEqual(last.works.map(w=>w.id),['work-1']);assert.equal(last.nextCursor,null);
  assert.deepEqual((await get('square')).data.works.map(w=>w.id),['new-arrival','work-5','work-3','work-2','work-1']);
  for(const query of ['limit=0','limit=49','limit=1.5','limit=bad','limit=2&limit=3','cursor=unknown','cursor=a&cursor=b']) assert.equal((await get('square?'+query)).status,400,query);
}));

test('display dimensions follow orientation, old files are read without migration, and collection covers obey visibility',()=>fixture(async({base,store,get,directory})=>{
  const original=await sharp({create:{width:90,height:60,channels:3,background:'#798a86'}}).jpeg().withMetadata({orientation:6}).toBuffer();
  const form=new FormData();form.append('file',new Blob([original],{type:'image/jpeg'}),'oriented.jpg');
  const r=await fetch(base+'assets',{method:'POST',headers:{'x-test-viewer':'alice'},body:form});
  assert.equal(r.status,201);const asset=await r.json();
  assert.equal(asset.width,90);assert.equal(asset.height,60);
  assert.equal(asset.displayWidth,60);assert.equal(asset.displayHeight,90);
  assert.deepEqual(readFileSync(join(directory,'media',asset.id+'.original')),original);
  const publicWork=store.save('work','alice',work('Portrait',{assets:[asset.id]}),'portrait');
  const publicResult=(await get('work/'+publicWork.id)).data;
  assert.deepEqual(publicResult.media,[{id:asset.id,width:60,height:90}]);
  // Exercise pre-redesign records without changing their stored schema or original file.
  const {displayWidth,displayHeight,...legacy}=asset;
  store.save('asset','alice',legacy,asset.id);
  assert.deepEqual((await get('work/portrait')).data.media,publicResult.media);
  assert.equal(store.get(asset.id).displayWidth,undefined);
  const hiddenAsset=store.save('asset','alice',{displayWidth:800,displayHeight:600},'hidden-asset');
  store.save('work','alice',work('Private',{assets:[hiddenAsset.id],visibility:'private'}),'private-work');
  store.save('collection','alice',{title:'Collection',works:['private-work','portrait'],status:'published',visibility:'public'},'collection');
  const collection=(await get('collection/collection')).data;
  assert.deepEqual(collection.works,['portrait']);assert.deepEqual(collection.items.map(w=>w.id),['portrait']);
  assert.deepEqual(collection.coverMedia,{id:asset.id,width:60,height:90});
  assert.ok(!JSON.stringify(collection).includes('hidden-asset'));
  assert.equal((await get('collection/collection','alice')).data.coverMedia.id,'hidden-asset');
  store.save('profile','alice',{name:'Alice',cover:asset.id,status:'published',visibility:'public'},'profile');
  const profile=(await get('profile/alice')).data;
  assert.deepEqual(profile.coverMedia,collection.coverMedia);
  assert.deepEqual(profile.collections[0].coverMedia,collection.coverMedia);
  store.save('work','alice',work('Revoked',{assets:[asset.id],visibility:'private'}),'portrait');
  const revoked=(await get('collection/collection')).data;
  assert.deepEqual(revoked.works,[]);assert.equal(revoked.coverMedia,null);
  assert.equal((await get('work/portrait')).status,404);
  assert.equal((await fetch(base+'media/'+asset.id+'/original')).status,404);
  const removeCover=await fetch(base+'profile/profile',{method:'PUT',headers:{'x-test-viewer':'alice','Content-Type':'application/json'},body:JSON.stringify({cover:null})});
  assert.equal(removeCover.status,200);
  assert.equal((await get('profile/alice')).data.coverMedia,null);
  assert.equal((await fetch(base+'media/'+asset.id+'/display')).status,404);
  store.save('asset','alice',{width:200,height:300},'missing-file');
  store.save('work','alice',work('Missing preview',{assets:['missing-file']}),'missing-work');
  assert.deepEqual((await get('work/missing-work')).data.media,[{id:'missing-file',width:null,height:null}]);
  assert.equal((await get('square?limit=12')).status,200);
}));
