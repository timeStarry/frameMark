import {Window} from 'happy-dom'
import {readFile} from 'node:fs/promises'
import {resolve,dirname,extname} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL,fileURLToPath} from 'node:url'
import ts from 'typescript'
import {parse,compileScript} from '@vue/compiler-sfc'
import {createCanvas,loadImage} from '@napi-rs/canvas'
import sharp from 'sharp'
const require=createRequire(import.meta.url),root=fileURLToPath(new URL('../../',import.meta.url)),cache=new Map()
export const window=new Window({url:'http://localhost/'})
for(const key of ['window','document','HTMLElement','Element','SVGElement','Node','Image','HTMLCanvasElement'])globalThis[key]=key==='window'?window:window[key]
Object.defineProperty(document,'fonts',{value:{ready:Promise.resolve(),load:async()=>[]}})
const canvases=new WeakMap()
function backing(element){let canvas=canvases.get(element);if(!canvas){canvas=createCanvas(element.width||1,element.height||1);canvases.set(element,canvas)}if(canvas.width!==element.width)canvas.width=Math.max(1,element.width);if(canvas.height!==element.height)canvas.height=Math.max(1,element.height);return canvas}
window.HTMLCanvasElement.prototype.getContext=function(){const context=backing(this).getContext('2d');const draw=context.drawImage.bind(context);context.drawImage=(source,...args)=>draw(source instanceof window.HTMLCanvasElement?backing(source):source,...args);return context}
window.HTMLCanvasElement.prototype.toBlob=function(callback,type,quality){return backing(this).toBlob(callback,type,quality)}
export const resources={open:0,peak:0}
globalThis.createImageBitmap=async(file,options={})=>{const image=await loadImage(await sharp(Buffer.from(await file.arrayBuffer())).rotate().resize(options.resizeWidth,options.resizeHeight,{fit:'fill'}).png().toBuffer()),c=createCanvas(image.width,image.height);c.getContext('2d').drawImage(image,0,0);resources.open++;resources.peak=Math.max(resources.peak,resources.open);let closed=false;c.close=()=>{if(!closed){closed=true;resources.open--}};return c}
export const vue=await import('vue')
export async function loadTool(relative){const path=resolve(root,relative);if(cache.has(path))return cache.get(path);let source=await readFile(path,'utf8');if(extname(path)==='.vue')source=compileScript(parse(source,{filename:path}).descriptor,{id:'unit-'+path,inlineTemplate:true}).content;source=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;source=source.replace(/import\s+['"][^'"]+\.css['"];?/g,'');const ast=ts.createSourceFile(path,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);const imports=ast.statements.filter(ts.isImportDeclaration).reverse();for(const statement of imports){const name=statement.moduleSpecifier.text;let url;if(name.startsWith('.')){let target=resolve(dirname(path),name);if(!extname(target))target+='.ts';url=await loadTool(target)}else url=pathToFileURL(require.resolve(name)).href;source=source.slice(0,statement.moduleSpecifier.getStart(ast))+JSON.stringify(url)+source.slice(statement.moduleSpecifier.getEnd())}const url='data:text/javascript;base64,'+Buffer.from(source).toString('base64');cache.set(path,url);return url}
export async function waitFor(predicate,timeout=3000){const start=Date.now();while(!predicate()){if(Date.now()-start>timeout)throw new Error('condition timed out');await new Promise(r=>setTimeout(r,10));await vue.nextTick()}}
