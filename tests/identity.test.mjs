import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {createApp} from '../server/app.mjs';
import {normalizeEmail,hashPassword,verifyPassword} from '../server/identity.mjs';
import {createSmtpMailer,smtpSettings} from '../server/mail.mjs';
const password='isolated fixture long passphrase 2026';
async function fixture(options={}) {
 const directory=mkdtempSync(join(tmpdir(),'markr-identity-')),outbox=[];let time=Date.now();
 const identity={enabled:true,registrationOpen:true,origin:'http://localhost',testTransport:true,now:()=>time,mailer:{sendVerification:async message=>outbox.push(message)},...options};
 let state=createApp({directory,identity}),server=state.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 let base='http://127.0.0.1:'+server.address().port;
 function client(){let cookie='',csrf='';return {
  get cookie(){return cookie},get csrf(){return csrf},set cookie(v){cookie=v},
  async request(path,{method='GET',body,headers={}}={}){
   const h={cookie,...headers};if(method!=='GET'){h.origin=identity.origin;h['x-csrf-token']=csrf;if(body&&!(body instanceof FormData))h['content-type']='application/json'}Object.assign(h,headers);
   const r=await fetch(base+'/api/'+path,{method,headers:h,body:body instanceof FormData?body:body?JSON.stringify(body):undefined});const set=r.headers.get('set-cookie');if(set)cookie=set.split(';')[0];
   const data=r.headers.get('content-type')?.includes('application/json')?await r.json():Buffer.from(await r.arrayBuffer());if(data.csrfToken)csrf=data.csrfToken;
   return {status:r.status,data,set,headers:r.headers};
  },async bootstrap(){return this.request('auth/session')},
  async register(email){await this.bootstrap();assert.equal((await this.request('auth/register',{method:'POST',body:{email}})).status,202);const message=outbox.at(-1);return new URL(message.url).hash.slice('#verify='.length)},
  async create(email){const token=await this.register(email);const r=await this.request('auth/verify',{method:'POST',body:{token,password}});assert.equal(r.status,201);return r.data.user}
 }}
 return {client,outbox,get store(){return state.store},tick:ms=>{time+=ms},async restart(){await new Promise(r=>server.close(r));state.store.db.close();state=createApp({directory,identity});server=state.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base='http://127.0.0.1:'+server.address().port},async close(){await new Promise(r=>server.close(r));state.store.db.close();rmSync(directory,{recursive:true,force:true})}};
}
test('email normalization preserves aliases, validates international domains and password hashing is salted',async()=>{
 assert.equal(normalizeEmail(' Alice+Photos@Example.COM '),'alice+photos@example.com');assert.equal(normalizeEmail('摄影@例子.公司'),normalizeEmail('摄影@xn--fsqu00a.xn--55qx5d'));assert.notEqual(normalizeEmail('a.b@example.com'),normalizeEmail('ab@example.com'));assert.equal(normalizeEmail('摄影@例子.公司'),'摄影@xn--fsqu00a.xn--55qx5d');
 for(const input of ['bad','a\r\nBcc:b@example.com',{},'a@localhost'])assert.throws(()=>normalizeEmail(input));
 const a=await hashPassword(password),b=await hashPassword(password);assert.notEqual(a,b);assert.ok(await verifyPassword(password,a));assert.equal(await verifyPassword('wrong password long enough',a),false);assert.equal(await verifyPassword(password,'corrupt'),false);
});
test('verified email cookie identity owns persistent upload, drafts, publications, collections and profile',async()=>{
 const f=await fixture();try{const alice=f.client(),bob=f.client(),guest=f.client();const id=await alice.create('Alice@example.com');const bobId=await bob.create('bob@example.com');assert.notEqual(id,bobId);
 assert.equal((await alice.request('me')).data.user,id);const hash=f.store.db.prepare('SELECT password FROM identity_users WHERE id=?').get(id).password;assert.ok(hash.startsWith('scrypt-v1$'));assert.equal(hash.includes(password),false);
 const form=new FormData();form.append('file',new Blob([await sharp({create:{width:40,height:30,channels:3,background:'#987654'}}).png().toBuffer()]),'photo.png');const a=await alice.request('assets',{method:'POST',body:form});assert.equal(a.status,201);
 const work=await alice.request('work',{method:'POST',body:{title:'Real session draft',assets:[a.data.id],visibility:'public'}});assert.equal(work.status,201);assert.equal(work.data.owner,id);
 assert.equal((await guest.request('work/'+work.data.id)).status,404);assert.equal((await bob.request('work/'+work.data.id,{method:'PUT',body:{title:'steal'}})).status,404);assert.equal((await bob.request('work',{method:'POST',body:{title:'steal image',assets:[a.data.id]}})).status,404);
 assert.equal((await alice.request('work/'+work.data.id,{method:'PUT',body:{status:'published'}})).status,200);assert.equal((await guest.request('square')).data.works.length,1);assert.equal((await guest.request('media/'+a.data.id+'/display')).status,200);assert.equal((await guest.request('media/'+a.data.id+'/original')).status,404);
 assert.equal((await alice.request('collection',{method:'POST',body:{title:'Portfolio',works:[work.data.id],status:'published',visibility:'public'}})).status,201);assert.equal((await alice.request('profile',{method:'POST',body:{name:'Alice',cover:a.data.id}})).status,201);assert.equal((await guest.request('profile/'+id)).status,200);
 assert.equal((await bob.request('studio')).data.work.length,0);await f.restart();assert.equal((await alice.request('me')).data.user,id);assert.equal((await alice.request('studio')).data.work.length,1);
 const oldCookie=alice.cookie;assert.equal((await alice.request('auth/logout',{method:'POST'})).status,200);alice.cookie=oldCookie;assert.equal((await alice.request('studio')).status,401);
 await alice.bootstrap();assert.equal((await alice.request('auth/login',{method:'POST',body:{email:' ALICE@EXAMPLE.COM ',password}})).status,200);assert.equal((await alice.request('studio')).data.work.length,1);
 }finally{await f.close()}
});
test('verification is one-time, expires, replaces older links and never creates a user before verification',async()=>{
 const f=await fixture();try{const c=f.client();const first=await c.register('pending@example.com');assert.equal(f.store.db.prepare('SELECT count(*) n FROM identity_users').get().n,0);
 assert.equal((await c.request('auth/login',{method:'POST',body:{email:'pending@example.com',password}})).status,401);
 const token=await c.register('PENDING@example.com');assert.notEqual(first,token);assert.equal((await c.request('auth/verify',{method:'POST',body:{token:first,password}})).status,400);
 const verified=await c.request('auth/verify',{method:'POST',body:{token,password}});assert.equal(verified.status,201);assert.equal((await c.request('auth/verify',{method:'POST',body:{token,password}})).status,400);
 const before=f.outbox.length;await c.request('auth/register',{method:'POST',body:{email:'pending@example.com'}});assert.equal(f.outbox.length,before);assert.equal(f.store.db.prepare('SELECT count(*) n FROM identity_users').get().n,1);
 const expired=await c.register('expired@example.com');f.tick(1800001);await c.bootstrap();assert.equal((await c.request('auth/verify',{method:'POST',body:{token:expired,password}})).status,400);
 }finally{await f.close()}
});
test('CSRF, origin, header spoofing, session rotation, idle expiry and global revocation fail closed',async()=>{
 const f=await fixture({idleMs:1000,sessionMs:5000});try{const a=f.client();await a.bootstrap();const anonymous=a.cookie;const token=await a.register('sessions@example.com');await a.request('auth/verify',{method:'POST',body:{token,password}});assert.notEqual(a.cookie,anonymous);
 for(const headers of [{'x-csrf-token':''},{'x-csrf-token':'é'.repeat(43)},{origin:'https://evil.example'},{'sec-fetch-site':'cross-site'}])assert.equal((await a.request('work',{method:'POST',body:{title:'blocked',text:'x'},headers})).status,403);
 const second=f.client();await second.bootstrap();assert.equal((await second.request('auth/login',{method:'POST',body:{email:'sessions@example.com',password}})).status,200);
 assert.equal((await a.request('auth/logout-all',{method:'POST'})).status,200);assert.equal((await second.request('studio')).status,401);
 await a.bootstrap();await a.request('auth/login',{method:'POST',body:{email:'sessions@example.com',password}});f.tick(1001);assert.equal((await a.request('studio')).status,401);
 const fake=f.client();fake.cookie=anonymous;assert.equal((await fake.request('studio',{headers:{'x-user':'any','x-test-viewer':'any'}})).status,401);
 }finally{await f.close()}
});
test('absolute expiry remains fixed despite activity and HTTPS cookies have host-only security flags',async()=>{
 const f=await fixture({origin:'https://markr.example',testTransport:false,sessionMs:2500,idleMs:2000});try{const c=f.client();const b=await c.bootstrap();assert.match(b.set,/__Host-markr_session=/);assert.match(b.set,/HttpOnly/);assert.match(b.set,/Secure/);assert.match(b.set,/SameSite=Lax/);assert.doesNotMatch(b.set,/Domain=/);await c.create('expiry@example.com');f.tick(1500);assert.equal((await c.request('studio')).status,200);f.tick(1100);assert.equal((await c.request('studio')).status,401)}finally{await f.close()}
});
test('persistent rate limiting, closed registration, invalid input, mail failure and missing mail adapter',async()=>{
 const f=await fixture({rateLimit:2});try{const c=f.client();await c.bootstrap();for(let i=0;i<2;i++)assert.equal((await c.request('auth/login',{method:'POST',body:{email:'missing@example.com',password}})).status,401);await f.restart();assert.equal((await c.request('auth/login',{method:'POST',body:{email:'missing@example.com',password}})).status,429);f.tick(900001);await c.bootstrap();assert.equal((await c.request('auth/login',{method:'POST',body:{email:'missing@example.com',password}})).status,401)}finally{await f.close()}
 for(const options of [{registrationOpen:false},{mailer:null},{mailer:{sendVerification:async()=>{throw Error('secret smtp error')}}}]){const x=await fixture(options);try{const c=x.client();await c.bootstrap();const r=await c.request('auth/register',{method:'POST',body:{email:'failure@example.com'}});assert.equal(r.status,options.registrationOpen===false?403:503);assert.equal(JSON.stringify(r.data).includes('secret'),false);assert.equal(x.store.db.prepare('SELECT count(*) n FROM identity_pending').get().n,0)}finally{await x.close()}}
});
test('disabled identity adds no identity tables; insecure non-test origin rejected; smtp configuration is lazy and TLS constrained',async()=>{
 const directory=mkdtempSync(join(tmpdir(),'markr-disabled-'));try{const {store}=createApp({directory});assert.equal(store.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name LIKE 'identity_%'").get().n,0);store.db.close();assert.throws(()=>createApp({directory,identity:{enabled:true,origin:'http://markr.example'}}));assert.equal(createSmtpMailer({}),null);assert.throws(()=>createSmtpMailer({SMTP_HOST:'smtp.example',SMTP_USER:'fixture',SMTP_PASSWORD:'fixture',SMTP_FROM:'markr@example.com',SMTP_PORT:'25'}));}finally{rmSync(directory,{recursive:true,force:true})}
});

test('SMTP file reference uses only whitelisted fields, respects TLS and rejects unsafe permissions',()=>{
 const directory=mkdtempSync(join(tmpdir(),'markr-mail-')),file=join(directory,'smtp.env');try{writeFileSync(file,"THREADMARK_SMTP_HOST=smtp.example.com\nTHREADMARK_SMTP_PORT=587\nTHREADMARK_SMTP_USERNAME=fixture@example.com\nTHREADMARK_SMTP_PASSWORD='fixture special # value'\nTHREADMARK_SMTP_FROM_EMAIL=fixture@example.com\nTHREADMARK_SMTP_STARTTLS=true\nTHREADMARK_SMTP_USE_SSL=false\nUNRELATED_SECRET=fixture\n",{mode:0o600});const env={SMTP_CONFIG_FILE:file,SMTP_CONFIG_PREFIX:'THREADMARK_'};assert.equal(smtpSettings(env).SMTP_PASSWORD,'fixture special # value');assert.equal('UNRELATED_SECRET' in smtpSettings(env),false);const mail=createSmtpMailer(env);assert.equal(mail.connectionInfo.tls,'STARTTLS');mail.close();chmodSync(file,0o644);assert.throws(()=>smtpSettings(env),/unavailable or unsafe/);}finally{rmSync(directory,{recursive:true,force:true})}
});
test('verification token is stored hashed and concurrent replay creates at most one account',async()=>{
 const f=await fixture();try{const a=f.client(),b=f.client();const token=await a.register('race@example.com');await b.bootstrap();const pending=f.store.db.prepare('SELECT hash FROM identity_pending').get();assert.notEqual(pending.hash,token);const results=await Promise.all([a.request('auth/verify',{method:'POST',body:{token,password}}),b.request('auth/verify',{method:'POST',body:{token,password}})]);assert.deepEqual(results.map(x=>x.status).sort(),[201,400]);assert.equal(f.store.db.prepare('SELECT count(*) n FROM identity_users').get().n,1);}finally{await f.close()}
});
