import test from 'node:test'
import assert from 'node:assert/strict'
import sharp from 'sharp'
import {loadTool,vue,window,waitFor,resources} from './helpers/tool-dom.mjs'

const {useEditor}=await import(await loadTool('src/tools/core/useEditor.ts'))
const {collageDefaults}=await import(await loadTool('src/tools/core/collage.ts'))
const {renderDocument}=await import(await loadTool('src/tools/engine/pipeline.ts'))
const ToolWorkspace=(await import(await loadTool('src/tools/components/ToolWorkspace.vue'))).default
const AssetList=(await import(await loadTool('src/tools/components/AssetList.vue'))).default
const CanvasViewport=(await import(await loadTool('src/tools/components/CanvasViewport.vue'))).default
const ExportPanel=(await import(await loadTool('src/tools/components/ExportPanel.vue'))).default

function mount(component){
  const app=vue.createApp(component)
  app.component('router-link',{props:['to'],setup:(props,{slots})=>()=>vue.h('a',{href:props.to},slots.default?.())})
  const host=document.createElement('div');document.body.append(host);app.mount(host)
  return {host,close(){app.unmount();host.remove()}}
}
function shortcut(target,shiftKey=false){target.dispatchEvent(new window.KeyboardEvent('keydown',{key:'z',ctrlKey:true,shiftKey,bubbles:true,cancelable:true}))}
const sample=async()=>new File([await sharp({create:{width:80,height:60,channels:3,background:'#aabbcc'}}).png().toBuffer()],'focus.png',{type:'image/png'})

test('undo shortcuts obey busy controls and preserve native editing inside contenteditable descendants',async()=>{
  let editor
  const m=mount({setup(){editor=useEditor(collageDefaults,renderDocument,d=>({width:d.width,height:d.height}),12);return()=>vue.h('div',[vue.h('button','outside'),vue.h('div',{contenteditable:'true'},[vue.h('span','editable')])])}})
  try{
    await editor.importFiles([await sample()]);editor.doc.value.gap=32;editor.commit()
    editor.busy.value=true;shortcut(m.host.querySelector('button'));await vue.nextTick();assert.equal(editor.doc.value.gap,32)
    editor.busy.value=false;shortcut(m.host.querySelector('[contenteditable] span'));assert.equal(editor.doc.value.gap,32)
    shortcut(m.host.querySelector('button'));assert.equal(editor.doc.value.gap,16)
    shortcut(m.host.querySelector('button'),true);assert.equal(editor.doc.value.gap,32)
    editor.busy.value=true;window.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape'}));assert.equal(editor.busy.value,false)
  }finally{m.close()}
  assert.equal(resources.open,0)
})

test('responsive panels preserve focused controls without rebuilding the workspace, then release media listeners',async()=>{
  const previous=window.matchMedia,listeners=new Set(),media={matches:false,addEventListener(type,listener){if(type==='change')listeners.add(listener)},removeEventListener(type,listener){listeners.delete(listener)}}
  window.matchMedia=()=>media
  const m=mount({setup:()=>()=>vue.h(ToolWorkspace,{title:'测试',busy:false,canUndo:false,canRedo:false,hasAssets:false,error:'',status:''},{assets:()=>vue.h('button',{class:'asset-fixture'},'素材操作'),canvas:()=>vue.h('div',{class:'canvas-fixture'},'预览'),properties:()=>vue.h('input',{class:'property-fixture',value:'保留设置'})})})
  try{
    const asset=m.host.querySelector('.asset-fixture'),input=m.host.querySelector('.property-fixture')
    asset.focus();media.matches=true;for(const listener of listeners)await listener();await vue.nextTick()
    assert.equal(m.host.querySelector('[aria-controls="tool-assets"]').getAttribute('aria-pressed'),'true')
    assert.equal(document.activeElement,asset)
    const propertyTab=m.host.querySelector('[aria-controls="tool-properties"]');propertyTab.click();await vue.nextTick();input.focus()
    media.matches=false;for(const listener of listeners)await listener();media.matches=true;for(const listener of listeners)await listener();await vue.nextTick()
    assert.equal(document.activeElement,input);assert.equal(input.value,'保留设置')
    assert.equal(m.host.querySelector('[aria-controls="tool-properties"]').getAttribute('aria-pressed'),'true')
    propertyTab.focus();media.matches=false;for(const listener of listeners)await listener();assert.equal(document.activeElement,m.host.querySelector('.inspector'))
  }finally{m.close();window.matchMedia=previous}
  assert.equal(listeners.size,0)
})

test('asset removal, reordering and clear return keyboard focus to an available control',async()=>{
  const assets=vue.ref(['a','b','c'].map(id=>({id,url:'data:image/png;base64,',width:80,height:60,file:{name:id+'.png'}}))),selected=vue.ref('b')
  const m=mount({setup:()=>()=>vue.h(AssetList,{assets:assets.value,selected:selected.value,busy:false,multiple:true,onRemove:id=>assets.value=assets.value.filter(a=>a.id!==id),onMove:(id,delta)=>{const next=[...assets.value],index=next.findIndex(a=>a.id===id);[next[index],next[index+delta]]=[next[index+delta],next[index]];assets.value=next},onClear:()=>assets.value=[]})})
  try{
    const remove=m.host.querySelector('[aria-label="移除 b.png"]');remove.focus();remove.click();await vue.nextTick();await vue.nextTick()
    assert.equal(document.activeElement.closest('[data-asset-id]').dataset.assetId,'c')
    const move=m.host.querySelector('[aria-label="前移 c.png"]');move.focus();move.click();await vue.nextTick();await vue.nextTick()
    assert.equal(document.activeElement.closest('[data-asset-id]').dataset.assetId,'c');assert.equal(assets.value[0].id,'c')
    const clear=[...m.host.querySelectorAll('button')].find(b=>b.textContent==='清空素材');clear.focus();clear.click();await vue.nextTick();await vue.nextTick()
    assert.equal(document.activeElement,m.host.querySelector('.asset-add'))
  }finally{m.close()}
})

test('nonmodal export moves focus to its heading and restores the original opener',async()=>{
  const open=vue.ref(false),settings=vue.ref(collageDefaults())
  const m=mount({setup:()=>()=>vue.h('div',[vue.h('button',{class:'open-export',onClick:()=>open.value=true},'导出'),vue.h(ExportPanel,{open:open.value,settings:settings.value,size:{width:1080,height:1080},busy:false,hasAssets:true,hasResult:false,stale:false,filename:'markr',onClose:()=>open.value=false})])})
  try{
    const opener=m.host.querySelector('.open-export');opener.focus();opener.click();await waitFor(()=>document.activeElement===m.host.querySelector('.export-heading h2'))
    assert.equal(m.host.querySelector('[aria-modal]'),null)
    m.host.querySelector('.export-heading button').click();await vue.nextTick();await vue.nextTick()
    assert.equal(document.activeElement,opener)
  }finally{m.close()}
})

test('canvas transparency indicator follows output setting and is absent for an empty workspace',async()=>{
  const hasAssets=vue.ref(false),transparent=vue.ref(false)
  const m=mount({setup:()=>()=>vue.h(CanvasViewport,{hasAssets:hasAssets.value,transparent:transparent.value,size:{width:400,height:300},description:'测试预览'})})
  try{
    assert.equal(m.host.querySelector('.transparent-output'),null)
    hasAssets.value=true;await vue.nextTick();assert.ok(m.host.querySelector('.canvas-stage'));assert.equal(m.host.querySelector('.transparent-output'),null)
    transparent.value=true;await vue.nextTick();assert.ok(m.host.querySelector('.canvas-stage.transparent-output'))
    hasAssets.value=false;await vue.nextTick();assert.equal(m.host.querySelector('.transparent-output'),null)
  }finally{m.close()}
})

test('successful replacement restores focus from removed asset controls and does not steal focus moved during import',async()=>{
  const assets=vue.ref([{id:'before',url:'data:image/png;base64,',width:80,height:60,file:{name:'before.png'}}]),selected=vue.ref('before'),busy=vue.ref(false)
  let finish
  const m=mount({setup:()=>()=>vue.h('div',[vue.h('button',{class:'other-action'},'其他操作'),vue.h(AssetList,{assets:assets.value,selected:selected.value,busy:busy.value,onImport:()=>{busy.value=true;finish=()=>{assets.value=[{...assets.value[0],id:'after',file:{name:'after.png'}}];selected.value='after';busy.value=false}}})])})
  try{
    const choose=()=>{const input=m.host.querySelector('input[type=file]');Object.defineProperty(input,'files',{configurable:true,value:[new File(['fixture'],'after.png',{type:'image/png'})]});input.dispatchEvent(new window.Event('change',{bubbles:true}))}
    let replace=m.host.querySelector('[aria-label="替换 before.png"]');replace.focus();replace.click();await vue.nextTick();choose();await vue.nextTick();finish();await vue.nextTick();await vue.nextTick()
    assert.equal(document.activeElement,m.host.querySelector('.asset-select'))
    replace=m.host.querySelector('[aria-label="替换 after.png"]');replace.focus();replace.click();await vue.nextTick();choose();await vue.nextTick()
    const other=m.host.querySelector('.other-action');other.focus();finish();await vue.nextTick();await vue.nextTick();assert.equal(document.activeElement,other)
  }finally{m.close()}
})

test('keyboard import from empty canvas lands on a surviving canvas control after image loads',async()=>{
  const WatermarkTool=(await import(await loadTool('src/tools/watermark/WatermarkTool.vue'))).default
  const m=mount(WatermarkTool)
  try{
    const trigger=m.host.querySelector('.editor-empty button');trigger.focus();trigger.click();await vue.nextTick()
    const input=m.host.querySelector('input[type=file]');Object.defineProperty(input,'files',{configurable:true,value:[await sample()]});input.dispatchEvent(new window.Event('change',{bubbles:true}))
    await waitFor(()=>m.host.querySelector('.canvas-stage canvas')?.width>1)
    assert.equal(document.activeElement,m.host.querySelector('.canvas-status select'))
  }finally{m.close()}
  assert.equal(resources.open,0)
})
