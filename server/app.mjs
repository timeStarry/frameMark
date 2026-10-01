import express from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStore, canRead, inSquare } from './store.mjs';

export function createApp({ directory = './data', viewer = () => null, staticDirectory = './dist' } = {}) {
  const app = express(), store = createStore(directory);
  const mediaDirectory = resolve(directory, 'media'); mkdirSync(mediaDirectory, { recursive:true, mode:0o700 });
  app.disable('x-powered-by');
  app.use((req,res,next) => { res.set('X-Content-Type-Options','nosniff'); res.set('Referrer-Policy','no-referrer'); if(req.path.startsWith('/api/')) res.set('Cache-Control','private, no-store'); req.viewer = viewer(req); next(); });
  app.use(express.json({limit:'128kb'}));
  const fail = (status,message) => Object.assign(new Error(message),{status});
  const auth = (req,res,next) => req.viewer ? next() : next(fail(401,'身份入口尚未启用，请等待管理员配置。'));
  const owned = (id, user, kind) => { const r=store.get(id); if(!r || r.owner!==user || (kind && r.kind!==kind)) throw fail(404,'内容不存在'); return r; };
  const visible = (id,user,kind) => { const r=store.get(id); if(!r || r.kind!==kind || !canRead(r,user)) throw fail(404,'内容不存在'); return r; };
  const clean = r => { const {owner,...data}=r; return {...data, tags:(data.tags||[]).filter(t=>t.visibility==='public'&&t.source==='author'&&['content','self_declaration'].includes(t.type)), photographer:owner}; };
  const wrap = fn => (req,res,next) => Promise.resolve().then(()=>fn(req,res)).catch(next);
  app.get('/api/health', (req,res)=>res.json({ok:true, identityEnabled:false}));
  app.get('/api/me',(req,res)=>res.json({user:req.viewer}));
  app.get('/api/square',(req,res)=>res.json({works:store.list('work').filter(inSquare).map(clean), banner:store.list('work').filter(r=>inSquare(r)&&r.featuredRank>0).sort((a,b)=>a.featuredRank-b.featuredRank).map(clean)}));
  app.get('/api/studio',auth,(req,res)=>res.json(Object.fromEntries(['asset','work','collection','profile'].map(k=>[k,store.list(k).filter(r=>r.owner===req.viewer)]))));
  const upload = multer({storage:multer.memoryStorage(),limits:{fileSize:Number(process.env.MAX_UPLOAD_MB||20)*1024*1024,files:1}});
  app.post('/api/assets',auth,upload.single('file'),wrap(async(req,res)=>{
    if(!req.file) throw fail(400,'请选择图片');
    const count=store.list('asset').filter(r=>r.owner===req.viewer).length;
    if(count>=Number(process.env.MAX_ASSETS||100)) throw fail(413,'素材配额已满');
    const image=sharp(req.file.buffer,{limitInputPixels:40000000}), meta=await image.metadata();
    if(!['jpeg','png','webp'].includes(meta.format) || (meta.pages||1)>1) throw fail(400,'仅支持单帧 JPEG、PNG、WebP');
    const display=await image.rotate().resize({width:2400,height:2400,fit:'inside',withoutEnlargement:true}).webp({quality:85}).toBuffer();
    const id=randomUUID(), original=join(mediaDirectory,id+'.original'), preview=join(mediaDirectory,id+'.webp');
    try {
      writeFileSync(original,req.file.buffer,{flag:'wx',mode:0o600}); writeFileSync(preview,display,{flag:'wx',mode:0o600});
      res.status(201).json(store.save('asset',req.viewer,{format:meta.format,width:meta.width,height:meta.height,bytes:req.file.size,createdAt:new Date().toISOString()},id));
    } catch(e) { for(const p of [original,preview]) {try{unlinkSync(p)}catch{}} throw e; }
  }));
  function validate(req,kind,existing={}) {
    const b=req.body, data={...existing};
    for(const field of ['title','text','bio','name']) if(b[field]!==undefined) { if(typeof b[field]!=='string'||b[field].length>10000) throw fail(400,'文本格式无效'); data[field]=b[field].trim(); }
    if(kind!=='profile') {
      data.status=b.status??data.status??'draft'; data.visibility=b.visibility??data.visibility??'private';
      if(!['draft','published'].includes(data.status)||!['private','unlisted','public'].includes(data.visibility)) throw fail(400,'可见性或状态无效');
      data.distribute=b.distribute??data.distribute??true; data.allowOriginal=b.allowOriginal??data.allowOriginal??false;
      if(typeof data.distribute!=='boolean'||typeof data.allowOriginal!=='boolean') throw fail(400,'开关格式无效');
      if(!data.title) throw fail(400,'请填写标题');
    }
    if(b.tags!==undefined) {
      if(!Array.isArray(b.tags)||b.tags.length>20) throw fail(400,'标记列表无效');
      data.tags=b.tags.map(t=>{
        if(!t||typeof t.label!=='string'||!t.label.trim()||t.label.length>64||!['content','self_declaration'].includes(t.type)||!['public','private'].includes(t.visibility)) throw fail(400,'作者标记格式无效');
        if(t.source!==undefined&&t.source!=='author') throw fail(400,'作者不能创建系统标记');
        return {label:t.label.trim(),type:t.type,source:'author',visibility:t.visibility};
      });
    }
    const refField=kind==='work'?'assets':kind==='collection'?'works':null;
    if(refField) { const ids=b[refField]??data[refField]??[]; if(!Array.isArray(ids)||ids.length>40||new Set(ids).size!==ids.length) throw fail(400,'引用列表无效'); ids.forEach(id=>owned(id,req.viewer,kind==='work'?'asset':'work')); data[refField]=ids; }
    if(kind==='work' && data.status==='published' && !data.assets.length && !data.text) throw fail(400,'发布需要图片或文字');
    if(kind==='profile') {
      data.status='published'; data.visibility='public';
      data.accent=b.accent??data.accent??'#c8a477'; if(!/^#[0-9a-f]{6}$/i.test(data.accent)) throw fail(400,'颜色无效');
      data.layout=b.layout??data.layout??'grid'; if(!['grid','column'].includes(data.layout)) throw fail(400,'布局无效');
      data.modules=b.modules??data.modules??['works','collections']; if(!Array.isArray(data.modules)||data.modules.length!==2||!data.modules.includes('works')||!data.modules.includes('collections')) throw fail(400,'模块顺序无效');
      data.cover=b.cover??data.cover??null; if(data.cover) owned(data.cover,req.viewer,'asset');
    }
    data.updatedAt=new Date().toISOString(); return data;
  }
  for(const kind of ['work','collection','profile']) {
    app.post('/api/'+kind,auth,wrap((req,res)=>res.status(201).json(store.save(kind,req.viewer,validate(req,kind)))));
    app.put('/api/'+kind+'/:id',auth,wrap((req,res)=>{const old=owned(req.params.id,req.viewer,kind);res.json(store.save(kind,req.viewer,validate(req,kind,old),old.id));}));
  }
  app.get('/api/work/:id',wrap((req,res)=>res.json(clean(visible(req.params.id,req.viewer,'work')))));
  app.get('/api/collection/:id',wrap((req,res)=>{const c=visible(req.params.id,req.viewer,'collection');res.json({...clean(c),items:c.works.map(id=>store.get(id)).filter(r=>r?.kind==='work'&&canRead(r,req.viewer)).map(clean)});}));
  app.get('/api/profile/:owner',wrap((req,res)=>{ const owner=req.params.owner, p=store.list('profile').find(r=>r.owner===owner); if(!p) throw fail(404,'主页不存在');res.json({...clean(p),works:store.list('work').filter(r=>r.owner===owner&&r.status==='published'&&r.visibility==='public').map(clean),collections:store.list('collection').filter(r=>r.owner===owner&&r.status==='published'&&r.visibility==='public').map(clean)}); }));
  app.get('/api/media/:id/:variant',wrap((req,res)=>{
    const a=store.get(req.params.id),original=req.params.variant==='original';
    if(!a||a.kind!=='asset'||!['display','original'].includes(req.params.variant)) throw fail(404,'图片不存在');
    const works=store.list('work').filter(w=>w.assets.includes(a.id)&&canRead(w,req.viewer));
    const profileCover=!original&&store.list('profile').some(p=>p.cover===a.id);
    if(a.owner!==req.viewer&&!profileCover&&!works.some(w=>!original||w.allowOriginal)) throw fail(404,'图片不存在');
    res.set('Cache-Control','private, no-store');
    if(original) {res.type(a.format==='jpeg'?'image/jpeg':'image/'+a.format);res.attachment('Markr-'+a.id+'.'+a.format);}
    else res.type('image/webp');
    res.sendFile(join(mediaDirectory,a.id+(original?'.original':'.webp')));
  }));
  app.use('/api',(req,res)=>res.status(404).json({error:'接口不存在'}));
  app.use(express.static(resolve(staticDirectory)));
  app.get('/{*path}',(req,res)=>res.sendFile(resolve(staticDirectory,'index.html')));
  app.use((err,req,res,next)=>res.status(err.status|| (err.code==='LIMIT_FILE_SIZE'?413:400)).json({error:err.status||err.code?err.message:'处理失败，请检查图片格式后重试。'}));
  return {app,store};
}
