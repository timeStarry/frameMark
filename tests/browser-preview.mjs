// Isolated, anonymous, read-only UI fixtures. Never points at production data.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createApp } from '../server/app.mjs';
import { licenses, aiDeclaration } from '../src/shared/declarations.mjs';
const directory=mkdtempSync(join(tmpdir(),'markr-browser-'));
const {app,store}=createApp({directory});
mkdirSync(join(directory,'media'),{recursive:true});
for(let i=1;i<=3;i++){
 const svg=`<svg width="1200" height="800" xmlns="http://www.w3.org/2000/svg"><rect width="1200" height="800" fill="${['#284958','#6b513e','#333650'][i-1]}"/><circle cx="${i*240}" cy="300" r="160" fill="#c8a477"/><path d="M0 680L400 430L720 620L1200 250V800H0Z" fill="#12171d"/><text x="50" y="80" fill="white" font-size="32">Markr UI fixture ${i}</text></svg>`;
 const bytes=await sharp(Buffer.from(svg)).png().toBuffer();
 writeFileSync(join(directory,'media',`fixture-${i}.original`),bytes);
 writeFileSync(join(directory,'media',`fixture-${i}.webp`),await sharp(bytes).webp().toBuffer());
 store.save('asset','qa-fixture',{format:'png',width:1200,height:800,bytes:bytes.length},`fixture-${i}`);
}
store.save('work','qa-fixture',{title:'界面测试组图',text:'用于验证观看、翻页和返回。合成测试图形，不是用户摄影作品。',assets:['fixture-1','fixture-2','fixture-3'],status:'published',visibility:'public',distribute:true,allowOriginal:false,featuredRank:1,license:licenses.by,aiDeclaration},'fixture-group');
store.save('work','qa-fixture',{title:'界面测试文字作品',text:'纯文字作品的空图状态。',assets:[],status:'published',visibility:'public',distribute:true,allowOriginal:false},'fixture-text');
store.save('work','qa-fixture',{title:'仅链接界面测试',text:'不进入广场和主页。',assets:['fixture-2'],status:'published',visibility:'unlisted',distribute:true,allowOriginal:false},'fixture-unlisted');
store.save('work','qa-fixture',{title:'私密界面测试',text:'不可匿名查看。',assets:[],status:'published',visibility:'private',distribute:false,allowOriginal:false},'fixture-private');
store.save('collection','qa-fixture',{title:'界面测试作品集',text:'只展示可读成员。',works:['fixture-group','fixture-text','fixture-private'],status:'published',visibility:'public'},'fixture-collection');
store.save('profile','qa-fixture',{name:'界面测试摄影师',bio:'隔离 QA 数据；没有账户或凭据。',accent:'#c8a477',layout:'grid',modules:['collections','works'],cover:'fixture-3',status:'published',visibility:'public'},'fixture-profile');
app.listen(18142,'127.0.0.1',()=>console.log('Anonymous UI fixture preview on 127.0.0.1:18142; '+directory));
