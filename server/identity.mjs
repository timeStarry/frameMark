import { randomBytes, randomUUID, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import validator from 'validator';
import { domainToASCII } from 'node:url';
export function normalizeEmail(value) {
  if(typeof value!=='string')throw failure(400,'请填写有效邮箱。');
  let email=value.trim().normalize('NFC').toLowerCase();
  const at=email.lastIndexOf('@');
  if(at>=0)email=email.slice(0,at+1)+domainToASCII(email.slice(at+1));
  if(!validator.isEmail(email,{allow_utf8_local_part:true,allow_display_name:false})||Buffer.byteLength(email)>254)throw failure(400,'请填写有效邮箱。');
  return email;
}
const derive = promisify(scrypt);
const digest = value => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const failure = (status,message) => Object.assign(new Error(message),{status});
const costs = { N:131072, r:8, p:1, maxmem:160*1024*1024 };
export async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = await derive(password,salt,64,costs);
  return `scrypt-v1$${salt}$${hash.toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  const [version,salt,hex] = encoded.split('$');
  if(version!=='scrypt-v1'||! /^[a-f0-9]{32}$/.test(salt)||! /^[a-f0-9]{128}$/.test(hex)) return false;
  const hash = await derive(password,salt,64,costs);
  return timingSafeEqual(hash,Buffer.from(hex,'hex'));
}
export function createIdentity(app, db, {enabled=false, registrationOpen=false, origin, testTransport=false, now=Date.now, sessionMs=7*86400000, idleMs=86400000, rateLimit=10, mailer}={}) {
  if(!enabled) return {enabled:false, middleware:(req,res,next)=>next()};
  const site = new URL(origin);
  if(site.origin!==origin || (site.protocol!=='https:' && !(testTransport && site.protocol==='http:' && ['127.0.0.1','localhost'].includes(site.hostname)))) throw Error('Identity requires an exact HTTPS origin');
  if(!Number.isSafeInteger(sessionMs)||sessionMs<1||!Number.isSafeInteger(idleMs)||idleMs<1||!Number.isSafeInteger(rateLimit)||rateLimit<1) throw Error('Invalid identity limits');
  // Additive migration only: existing records/owners remain untouched; older releases ignore these tables.
  db.exec(`BEGIN; CREATE TABLE IF NOT EXISTS identity_users(id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS identity_sessions(hash TEXT PRIMARY KEY, user TEXT REFERENCES identity_users(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL, touched INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS identity_pending(email TEXT PRIMARY KEY, hash TEXT UNIQUE NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS identity_rates(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL); PRAGMA user_version=1; COMMIT;`);
  const cookieName=site.protocol==='https:'?'__Host-markr_session':'markr_test_session';
  const cookie=(res,value,age)=>res.cookie(cookieName,value,{httpOnly:true,secure:site.protocol==='https:',sameSite:'lax',path:'/',maxAge:age});
  const prune=()=>{db.prepare('DELETE FROM identity_pending WHERE expires<=?').run(now());db.prepare('DELETE FROM identity_sessions WHERE expires<=? OR touched<=?').run(now(),now()-idleMs);db.prepare('DELETE FROM identity_rates WHERE expires<=?').run(now());};
  function session(req) {
    const raw=(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith(cookieName+'='));
    if(raw.length!==1) return null;
    const value=raw[0].slice(cookieName.length+1);if(!/^[A-Za-z0-9_-]{43}$/.test(value))return null;
    return db.prepare('SELECT * FROM identity_sessions WHERE hash=? AND expires>? AND touched>?').get(digest(value),now(),now()-idleMs)||null;
  }
  function issue(req,res,user) {
    if(req.identitySession) db.prepare('DELETE FROM identity_sessions WHERE hash=?').run(req.identitySession.hash);
    const value=token(), csrf=token(), expires=now()+(user?sessionMs:900000);
    db.prepare('INSERT INTO identity_sessions VALUES(?,?,?,?,?)').run(digest(value),user,csrf,expires,now());
    cookie(res,value,expires-now()); req.identitySession={hash:digest(value),user,csrf,expires}; req.viewer=user;
  }
  function rate(key,limit=rateLimit) {
    const id=digest(key);db.prepare('INSERT INTO identity_rates VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1').run(id,now()+900000);
    if(db.prepare('SELECT count FROM identity_rates WHERE key=?').get(id).count>limit) throw failure(429,'请求过于频繁，请在 15 分钟后重试。');
  }
  let hashes=0;
  async function bounded(fn) {if(hashes>=2)throw failure(503,'登录服务繁忙，请稍后重试。');hashes++;try{return await fn()}finally{hashes--}}
  const dummy=`scrypt-v1$${'0'.repeat(32)}$${'0'.repeat(128)}`;
  const wrap=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res)).catch(next);
  const middleware=(req,res,next)=>{
    try {
      if(!req.path.startsWith('/api/'))return next();
      prune();req.identitySession=session(req);req.viewer=req.identitySession?.user||null;
      if(req.identitySession)db.prepare('UPDATE identity_sessions SET touched=? WHERE hash=?').run(now(),req.identitySession.hash);
      if(req.path.startsWith('/api/')&&!['GET','HEAD','OPTIONS'].includes(req.method)) {
        if(req.headers.origin!==origin || req.headers['sec-fetch-site']==='cross-site')throw failure(403,'请求来源无效，请从本站重试。');
        const provided=req.headers['x-csrf-token'];
        if(!req.identitySession||typeof provided!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(provided)||!timingSafeEqual(Buffer.from(provided),Buffer.from(req.identitySession.csrf)))throw failure(403,'会话校验失败，请刷新页面后重试。');
      }
      next();
    }catch(e){next(e)}
  };
  // Must be mounted after middleware and JSON parser; installRoutes is called by app.mjs.
  function installRoutes() {
    app.get('/api/auth/session',wrap((req,res)=>{if(!req.identitySession){rate('bootstrap:'+req.ip,60);issue(req,res,null)}res.json({user:req.viewer,csrfToken:req.identitySession.csrf,registrationOpen});}));
    function passwordInput(value) {if(typeof value!=='string'||[...value].length<15||Buffer.byteLength(value)>256)throw failure(400,'密码至少 15 个字符，最多 256 字节。');return value;}
    const registration=()=>{if(!registrationOpen)throw failure(403,'注册尚未开放。');if(typeof mailer?.sendVerification!=='function')throw failure(503,'验证邮件服务暂不可用。');};
    app.post('/api/auth/register',wrap(async(req,res)=>{
      registration();rate('register-ip:'+req.ip,5);const email=normalizeEmail(req.body?.email);rate('register-email:'+email,3);
      if(!db.prepare('SELECT id FROM identity_users WHERE email=?').get(email)) {
        const value=token(),hash=digest(value);
        db.prepare('INSERT INTO identity_pending VALUES(?,?,?) ON CONFLICT(email) DO UPDATE SET hash=excluded.hash,expires=excluded.expires').run(email,hash,now()+1800000);
        try {await bounded(()=>mailer.sendVerification({to:email,url:origin+'/login#verify='+value}))}
        catch {db.prepare('DELETE FROM identity_pending WHERE hash=?').run(hash);throw failure(503,'验证邮件暂时发送失败，请稍后重试。');}
      }
      res.status(202).json({message:'如果该邮箱可以注册，验证邮件已发送。请在 30 分钟内打开链接并设置密码。'});
    }));
    app.post('/api/auth/verify',wrap(async(req,res)=>{
      registration();rate('verify-ip:'+req.ip);const value=req.body?.token,password=passwordInput(req.body?.password);
      if(typeof value!=='string'||! /^[A-Za-z0-9_-]{43}$/.test(value))throw failure(400,'验证链接无效或已过期。');
      const pending=db.prepare('SELECT * FROM identity_pending WHERE hash=? AND expires>?').get(digest(value),now());
      if(!pending)throw failure(400,'验证链接无效或已过期。');
      const encoded=await bounded(()=>hashPassword(password)),id=randomUUID();
      // Recheck after async hashing. Atomic consumption prevents duplicate creation and token replay.
      db.exec('BEGIN IMMEDIATE');
      try {
        const current=db.prepare('SELECT * FROM identity_pending WHERE hash=? AND expires>?').get(digest(value),now());
        if(!current)throw failure(400,'验证链接无效或已过期。');
        db.prepare('INSERT INTO identity_users VALUES(?,?,?,?)').run(id,current.email,encoded,now());
        db.prepare('DELETE FROM identity_pending WHERE hash=?').run(digest(value));db.exec('COMMIT');
      }catch(e){db.exec('ROLLBACK');if(e.code?.includes('CONSTRAINT'))throw failure(400,'验证链接无效或已使用。');throw e}
      issue(req,res,id);res.status(201).json({user:id,csrfToken:req.identitySession.csrf});
    }));
    app.post('/api/auth/login',wrap(async(req,res)=>{
      rate('auth-ip:'+req.ip);const email=normalizeEmail(req.body?.email),password=passwordInput(req.body?.password);rate('account:'+email);
      const user=db.prepare('SELECT * FROM identity_users WHERE email=?').get(email);
      const valid=await bounded(()=>verifyPassword(password,user?.password||dummy));
      if(!valid||!user)throw failure(401,'邮箱或密码不正确。');
      issue(req,res,user.id);res.json({user:user.id,csrfToken:req.identitySession.csrf});
    }));
    app.post('/api/auth/logout',wrap((req,res)=>{db.prepare('DELETE FROM identity_sessions WHERE hash=?').run(req.identitySession.hash);cookie(res,'',0);res.json({user:null});}));
    app.post('/api/auth/logout-all',wrap((req,res)=>{if(!req.viewer)throw failure(401,'请先登录。');db.prepare('DELETE FROM identity_sessions WHERE user=?').run(req.viewer);cookie(res,'',0);res.json({user:null});}));
  }
  return {enabled:true,middleware,installRoutes};
}
