<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import { accountRequest } from '../auth/session.mjs'
import { aiDeclaration, licenses } from '../shared/declarations.mjs'

const route = useRoute(), router = useRouter()
const tab = ref('work'), me = ref(null), identityEnabled = ref(false)
const studio = ref({ asset: [], work: [], collection: [], profile: [] })
const readState = ref('loading'), readError = ref(''), hasData = ref(false)
const mutationState = ref(''), mutationError = ref(''), mutationMessage = ref(''), mutationOwner = ref('')
const mutationOperation = ref('')
const uploadProgress = ref(''), uploadRetry = shallowRef(null)
const contentTitle = ref(null)
const profile = ref(emptyProfile()), profileBaseline = ref(snapshot(profile.value))
let draftSequence = 0
const drafts = ref({ work: makeDraft(), collection: makeDraft() })
const draft = computed(() => drafts.value[tab.value === 'collection' ? 'collection' : 'work'])
const busy = computed(() => Boolean(mutationState.value))
const records = computed(() => studio.value[tab.value === 'collection' ? 'collection' : 'work'])
const contentDirty = computed(() => ['work', 'collection'].some(kind => snapshot(drafts.value[kind].form) !== drafts.value[kind].baseline))
const profileDirty = computed(() => snapshot(profile.value) !== profileBaseline.value)
const dirty = computed(() => contentDirty.value || profileDirty.value || Boolean(uploadRetry.value))
const activeDirty = computed(() => snapshot(draft.value.form) !== draft.value.baseline)
const selectedLicense = computed(() => licenses[draft.value.form.license])
const retryAvailable = computed(() => uploadRetry.value?.key === draft.value.key && tab.value === 'work')
const visibilityLabels = { private: '私密', unlisted: '仅链接', public: '公开' }
const image = id => '/api/media/' + encodeURIComponent(id) + '/display'
const api = accountRequest
let alive = true, readVersion = 0, readController, mutationController, allowLeave = false

function snapshot(value) { return JSON.stringify(value) }
function emptyForm() {
  return { title: '', text: '', license: null, aiDeclaration: null, assets: [], works: [], status: 'draft', visibility: 'private', distribute: true, allowOriginal: false }
}
function emptyProfile() { return { name: '', bio: '', accent: '#ccd4c4', layout: 'grid', modules: ['works', 'collections'], cover: null } }
function contentForm(record = {}) {
  return { ...emptyForm(), ...record, assets: [...(record.assets || [])], works: [...(record.works || [])], license: record.license?.code || record.license || null, aiDeclaration: record.aiDeclaration?.code || record.aiDeclaration || null }
}
function makeDraft(record) {
  const form = contentForm(record)
  return { key: ++draftSequence, id: record?.id || null, form, baseline: snapshot(form) }
}
function resetFeedback() { mutationError.value = ''; mutationMessage.value = ''; mutationOwner.value = ''; mutationOperation.value = '' }
function current(context) {
  return alive && route.path === context.routePath && me.value === context.user && (!context.key || drafts.value[context.kind].key === context.key)
}
function contextFor(kind) { return { path: route.fullPath, routePath: route.path, user: me.value, kind, key: kind === 'profile' || kind === 'account' ? null : drafts.value[kind].key } }
function upsert(kind, record) {
  const index = studio.value[kind].findIndex(item => item.id === record.id)
  if (index < 0) studio.value[kind].unshift(record)
  else studio.value[kind].splice(index, 1, record)
}
async function load() {
  if (busy.value) return
  const version = ++readVersion, path = route.path
  readController?.abort()
  readController = new AbortController()
  readState.value = 'loading'; readError.value = ''
  try {
    const identity = await api('me', { signal: readController.signal })
    if (!alive || version !== readVersion || route.path !== path) return
    me.value = identity.user; identityEnabled.value = identity.identityEnabled === true
    if (!identity.user) { readState.value = 'locked'; return }
    const data = await api('studio', { signal: readController.signal })
    if (!alive || version !== readVersion || route.path !== path) return
    studio.value = { asset: data.asset || [], work: data.work || [], collection: data.collection || [], profile: data.profile || [] }
    if (!hasData.value) {
      profile.value = { ...emptyProfile(), ...(studio.value.profile[0] || {}) }
      profileBaseline.value = snapshot(profile.value)
    }
    hasData.value = true; readState.value = 'ready'
  } catch (error) {
    if (alive && version === readVersion && route.path === path && error.name !== 'AbortError') {
      readError.value = error.message || '暂时无法载入工作台。'; readState.value = 'error'
    }
  }
}
async function mutate(kind, state, task) {
  if (busy.value || !hasData.value) return
  const context = contextFor(kind)
  mutationState.value = state; mutationOperation.value = state; mutationOwner.value = kind; mutationError.value = ''; mutationMessage.value = ''
  mutationController = new AbortController()
  try { await task(context, mutationController.signal) }
  catch (error) {
    if (!current(context) || error.name === 'AbortError') return
    mutationError.value = error.message || '操作未完成，请重试。'
    if (error.status === 401) {
      allowLeave = true
      await router.replace({ path: '/login', query: { returnTo: context.path } })
    }
  } finally {
    if (alive) { mutationState.value = ''; uploadProgress.value = '' }
  }
}
function selectTab(next) { if (!busy.value) tab.value = next }
function discardDraft(kind) {
  const target = drafts.value[kind]
  const unfinishedUpload = uploadRetry.value?.key === target.key
  if ((snapshot(target.form) !== target.baseline || unfinishedUpload) && !window.confirm('此草稿有未保存的修改或未完成的上传。放弃这些内容？')) return false
  if (uploadRetry.value?.key === target.key) uploadRetry.value = null
  return true
}
function fresh() {
  if (busy.value || !discardDraft(tab.value)) return
  drafts.value[tab.value] = makeDraft(); resetFeedback()
  nextTick(() => contentTitle.value?.focus())
}
function edit(record) {
  if (busy.value || !discardDraft(record.kind)) return
  drafts.value[record.kind] = makeDraft(record); tab.value = record.kind; resetFeedback()
  nextTick(() => contentTitle.value?.focus())
}
async function save() {
  const kind = tab.value
  if (!['work', 'collection'].includes(kind)) return
  const target = drafts.value[kind], body = snapshot(target.form), id = target.id
  await mutate(kind, 'save', async (context, signal) => {
    const record = await api(kind + (id ? '/' + encodeURIComponent(id) : ''), { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body, signal })
    if (!current(context)) return
    upsert(kind, record)
    target.id = record.id; target.form = contentForm(record); target.baseline = snapshot(target.form)
    mutationMessage.value = record.status === 'published' ? '已保存发布设置。' : '草稿已保存。'
  })
}
async function upload(event) {
  const files = Array.from(event.target.files || [])
  event.target.value = ''
  if (!files.length || busy.value || tab.value !== 'work') return
  if (retryAvailable.value && !window.confirm('仍有未完成的上传。改为上传新选择的文件？')) return
  uploadRetry.value = null
  await uploadFiles(files)
}
async function uploadFiles(files, completedBefore = 0) {
  const target = drafts.value.work
  await mutate('work', 'upload', async (context, signal) => {
    let completed = completedBefore
    for (let index = 0; index < files.length; index++) {
      if (!current(context)) return
      uploadProgress.value = `正在上传 ${index + 1} / ${files.length}：${files[index].name}`
      const body = new FormData(); body.append('file', files[index])
      try {
        const asset = await api('assets', { method: 'POST', body, signal })
        if (!current(context)) return
        upsert('asset', asset)
        if (!target.form.assets.includes(asset.id)) target.form.assets.push(asset.id)
        completed++
      } catch (error) {
        if (current(context) && error.name !== 'AbortError') {
          uploadRetry.value = { key: target.key, files: files.slice(index), completed }
          error.message = `${error.message || '上传失败。'} 已完成 ${completed} 张，尚有 ${files.length - index} 张未完成；已完成的素材已保留。`
        }
        throw error
      }
    }
    if (current(context)) { uploadRetry.value = null; mutationMessage.value = `${completed} 张素材上传完成，已选入当前草稿。请保存草稿。` }
  })
}
async function retryUpload() {
  if (!retryAvailable.value || busy.value) return
  const retry = uploadRetry.value
  await uploadFiles(retry.files, retry.completed)
}
async function saveProfile() {
  const id = studio.value.profile[0]?.id, body = snapshot(profile.value)
  await mutate('profile', 'profile', async (context, signal) => {
    const record = await api('profile' + (id ? '/' + encodeURIComponent(id) : ''), { method: id ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body, signal })
    if (!current(context)) return
    upsert('profile', record); profile.value = { ...emptyProfile(), ...record }; profileBaseline.value = snapshot(profile.value)
    mutationMessage.value = '主页已保存。'
  })
}
async function logout(all = false) {
  if (busy.value || (dirty.value && !window.confirm('有未保存的修改。仍要退出登录？'))) return
  await mutate('account', 'logout', async (context, signal) => {
    await api('auth/' + (all ? 'logout-all' : 'logout'), { method: 'POST', signal })
    if (!current(context)) return
    allowLeave = true; await router.replace('/login')
  })
}
function beforeUnload(event) {
  if (!dirty.value && !busy.value) return
  event.preventDefault(); event.returnValue = ''
}
function canLeave() {
  if (allowLeave || (!dirty.value && !busy.value)) return true
  return window.confirm(busy.value ? '上传或保存尚未完成。仍要离开工作台？' : '有未保存的修改。仍要离开工作台？')
}
onBeforeRouteLeave(canLeave)
onBeforeRouteUpdate(canLeave)
onMounted(() => { window.addEventListener('beforeunload', beforeUnload); load() })
onBeforeUnmount(() => { alive = false; readVersion++; readController?.abort(); mutationController?.abort(); window.removeEventListener('beforeunload', beforeUnload) })
</script>

<template>
  <section class="studio-page" aria-labelledby="studio-heading">
    <header class="studio-header">
      <h1 id="studio-heading">工作台</h1>
      <div v-if="hasData" class="studio-session">
        <button type="button" :disabled="busy" @click="logout()">退出登录</button>
        <button type="button" :disabled="busy" @click="logout(true)">退出所有会话</button>
      </div>
    </header>
    <p v-if="readState === 'loading'" class="studio-state" role="status">正在载入工作台……</p>
    <div v-if="readState === 'error'" class="studio-notice" role="alert" data-testid="studio-read-error">
      <p>{{ readError }}</p><button type="button" :disabled="busy" @click="load">重新载入</button>
    </div>
    <div v-if="readState === 'locked'" class="studio-state">
      <h2>{{ identityEnabled ? '请先登录' : '登录暂未开放' }}</h2>
      <router-link v-if="identityEnabled" to="/login?returnTo=%2Fstudio">登录</router-link>
      <router-link to="/tools">打开工具箱</router-link>
    </div>
    <div v-if="hasData" data-testid="studio-workspace">
      <nav class="studio-tabs" aria-label="工作台分区">
        <button v-for="entry in [{ key: 'work', label: '作品' }, { key: 'collection', label: '作品集' }, { key: 'profile', label: '主页' }]" :key="entry.key" type="button" :aria-pressed="tab === entry.key" :disabled="busy" :data-testid="'studio-tab-' + entry.key" @click="selectTab(entry.key)">{{ entry.label }}</button>
      </nav>
      <p v-if="busy" class="studio-feedback" role="status">{{ mutationState === 'upload' ? uploadProgress || '正在准备上传……' : mutationState === 'logout' ? '正在退出登录……' : '正在保存……' }}</p>
      <div v-if="mutationError" class="studio-notice" role="alert" data-testid="studio-mutation-error">
        <p>{{ mutationError }}</p>
        <button v-if="retryAvailable" type="button" :disabled="busy" data-testid="studio-upload-retry" @click="retryUpload">重试未完成的上传</button>
        <button v-else-if="mutationOperation === 'save' && mutationOwner === tab && ['work', 'collection'].includes(tab)" type="button" :disabled="busy" @click="save">重试保存</button>
        <button v-else-if="mutationOwner === 'profile' && tab === 'profile'" type="button" :disabled="busy" @click="saveProfile">重试保存主页</button>
      </div>
      <p v-if="mutationMessage" class="studio-feedback" role="status">{{ mutationMessage }}</p>

      <div v-if="tab !== 'profile'" class="studio-workspace">
        <aside class="studio-list" :aria-label="tab === 'work' ? '作品列表' : '作品集列表'">
          <div class="studio-list-heading"><h2>{{ tab === 'work' ? '作品' : '作品集' }} <span>{{ records.length }}</span></h2><button type="button" :disabled="busy" data-testid="studio-new" @click="fresh">新建</button></div>
          <p v-if="!records.length" class="studio-empty">{{ tab === 'work' ? '还没有作品。可以先保存草稿。' : '还没有作品集。选择已有作品组成作品集。' }}</p>
          <ul v-else class="studio-records">
            <li v-for="record in records" :key="record.id" :class="{ 'studio-record-active': draft.id === record.id }">
              <button type="button" :disabled="busy" :data-testid="'studio-edit-' + record.id" :aria-label="'编辑 ' + record.title" :aria-pressed="draft.id === record.id" @click="edit(record)">
                <strong>{{ record.title }}</strong><span>{{ record.status === 'draft' ? '草稿' : '已发布' }} · {{ visibilityLabels[record.visibility] || record.visibility }}</span>
              </button>
              <router-link :to="'/' + tab + '/' + record.id" :aria-label="'查看 ' + record.title">查看</router-link>
            </li>
          </ul>
        </aside>
        <form class="studio-editor" data-testid="studio-content-form" @submit.prevent="save">
          <div class="studio-editor-heading"><h2>{{ draft.id ? '编辑' : '新建' }}{{ tab === 'work' ? '作品' : '作品集' }}</h2><span>{{ activeDirty ? '未保存' : draft.id ? '已保存' : '新草稿' }}</span></div>
          <fieldset :disabled="busy" class="studio-fields">
            <legend>内容</legend>
            <label :for="'studio-' + tab + '-title'">标题</label>
            <input :id="'studio-' + tab + '-title'" ref="contentTitle" v-model="draft.form.title" data-testid="studio-title" required maxlength="200">
            <label :for="'studio-' + tab + '-text'">{{ tab === 'work' ? '文字' : '说明' }}</label>
            <textarea :id="'studio-' + tab + '-text'" v-model="draft.form.text" rows="5"></textarea>
            <template v-if="tab === 'work'">
              <label for="studio-upload">上传成片</label>
              <input id="studio-upload" type="file" accept="image/jpeg,image/png,image/webp" multiple data-testid="studio-upload" aria-describedby="studio-upload-note" @change="upload">
              <p id="studio-upload-note" class="studio-help">每张默认上限 20 MB，选择后上传。展示图不含位置元数据。</p>
              <div v-if="retryAvailable && !mutationError" class="studio-upload-pending"><p class="studio-help">仍有 {{ uploadRetry.files.length }} 张未完成上传。</p><button type="button" :disabled="busy" data-testid="studio-upload-retry" @click="retryUpload">重试未完成的上传</button></div>
              <div v-if="studio.asset.length" class="studio-assets" role="group" aria-label="选择素材">
                <label v-for="(asset, index) in studio.asset" :key="asset.id" class="studio-asset">
                  <img :src="image(asset.id)" alt="" loading="lazy" width="96" height="72">
                  <span class="studio-check"><input v-model="draft.form.assets" type="checkbox" :value="asset.id" :aria-label="'选择素材 ' + (index + 1)">选用 {{ index + 1 }}</span>
                </label>
              </div>
              <p v-if="draft.form.assets.length" class="studio-help">已选 {{ draft.form.assets.length }} 张，按选择顺序展示。</p>
            </template>
            <div v-else role="group" aria-label="选择成员作品" class="studio-members">
              <p class="studio-member-heading">选择成员作品</p>
              <p v-if="!studio.work.length" class="studio-help">先保存作品，再添加到作品集。</p>
              <label v-for="work in studio.work" :key="work.id" class="studio-check"><input v-model="draft.form.works" type="checkbox" :value="work.id">{{ work.title }} <span>{{ visibilityLabels[work.visibility] }}</span></label>
              <p class="studio-help">作品集不会改变成员作品的可见性。访客只能看到有权访问的成员。</p>
            </div>
          </fieldset>
          <fieldset :disabled="busy" class="studio-fields">
            <legend>发布</legend>
            <div class="studio-pair">
              <div><label for="studio-status">状态</label><select id="studio-status" v-model="draft.form.status"><option value="draft">草稿</option><option value="published">发布</option></select></div>
              <div><label for="studio-visibility">可见性</label><select id="studio-visibility" v-model="draft.form.visibility" aria-describedby="studio-visibility-note"><option value="private">私密</option><option value="unlisted">仅链接</option><option value="public">公开</option></select></div>
            </div>
            <p id="studio-visibility-note" class="studio-help">私密仅自己可见；仅链接不出现在广场和主页，获得链接的人可以访问。草稿不公开。</p>
            <label class="studio-check"><input v-model="draft.form.distribute" type="checkbox">公开时进入广场</label>
          </fieldset>
          <fieldset v-if="tab === 'work'" :disabled="busy" class="studio-fields">
            <legend>许可与声明</legend>
            <label for="studio-ai">作者声明</label><select id="studio-ai" v-model="draft.form.aiDeclaration"><option :value="null">未声明</option><option :value="aiDeclaration.code">{{ aiDeclaration.label }}</option></select>
            <label for="studio-license">版权许可</label><select id="studio-license" v-model="draft.form.license"><option :value="null">未选择 CC 许可</option><option v-for="license in licenses" :key="license.code" :value="license.code">{{ license.label }} · {{ license.name }}</option></select>
            <p class="studio-help">只有权利人能授予许可。未使用 AI 与禁止 AI 训练是不同声明。</p>
            <a v-if="selectedLicense" :href="selectedLicense.url" target="_blank" rel="noopener noreferrer" class="studio-text-link">阅读所选许可官方说明 ↗</a>
            <label class="studio-check"><input v-model="draft.form.allowOriginal" type="checkbox">允许访客下载原文件</label>
            <p class="studio-help">原文件可能含位置元数据；此设置不改变作品的可见性。</p>
          </fieldset>
          <div class="studio-save-row"><button class="studio-primary" :disabled="busy" data-testid="studio-save">{{ draft.id ? '保存修改' : '保存' }}</button><span>{{ activeDirty ? '修改尚未保存' : '' }}</span></div>
        </form>
      </div>

      <form v-else class="studio-editor studio-profile" data-testid="studio-profile-form" @submit.prevent="saveProfile">
        <div class="studio-editor-heading"><h2>摄影师主页</h2><span>{{ profileDirty ? '未保存' : studio.profile.length ? '已保存' : '尚未创建' }}</span></div>
        <fieldset :disabled="busy" class="studio-fields">
          <legend>内容</legend>
          <label for="studio-profile-name">名称</label><input id="studio-profile-name" v-model="profile.name" data-testid="studio-profile-name" required maxlength="200">
          <label for="studio-profile-bio">简介</label><textarea id="studio-profile-bio" v-model="profile.bio" rows="4"></textarea>
          <label for="studio-cover">封面</label><select id="studio-cover" v-model="profile.cover"><option :value="null">无封面</option><option v-for="(asset, index) in studio.asset" :key="asset.id" :value="asset.id">素材 {{ index + 1 }} · {{ asset.id.slice(0, 8) }}</option></select>
          <img v-if="profile.cover" :src="image(profile.cover)" alt="主页封面预览" class="studio-cover-preview">
          <p class="studio-help">主页及封面公开可见。</p>
        </fieldset>
        <fieldset :disabled="busy" class="studio-fields">
          <legend>展示</legend>
          <label for="studio-accent">配色</label><input id="studio-accent" v-model="profile.accent" type="color">
          <div class="studio-pair"><div><label for="studio-layout">布局</label><select id="studio-layout" v-model="profile.layout"><option value="grid">网格</option><option value="column">单列</option></select></div><div><label for="studio-modules">模块顺序</label><select id="studio-modules" v-model="profile.modules"><option :value="['works', 'collections']">作品优先</option><option :value="['collections', 'works']">作品集优先</option></select></div></div>
        </fieldset>
        <div class="studio-save-row"><button class="studio-primary" :disabled="busy" data-testid="studio-profile-save">保存主页</button><router-link v-if="studio.profile.length" :to="'/profile/' + me" class="studio-text-link">查看主页</router-link></div>
      </form>
    </div>
  </section>
</template>

<style scoped>
.studio-page{max-width:1280px;margin:auto;padding:32px clamp(16px,4vw,56px) 64px;color:var(--markr-text,#eeeee9);font-size:14px;line-height:1.7}
.studio-header,.studio-list-heading,.studio-editor-heading,.studio-save-row,.studio-session{display:flex;align-items:center;gap:12px}
.studio-header{justify-content:space-between;flex-wrap:wrap;margin-bottom:20px}.studio-header h1{font-size:30px;font-weight:450;letter-spacing:-.025em;line-height:1.25;margin:0}
.studio-page h2{font-size:18px;font-weight:500;margin:0;overflow-wrap:anywhere}.studio-page p{margin:0;overflow-wrap:anywhere}.studio-page a{color:inherit;text-decoration:none}
.studio-page button,.studio-page input:not([type=checkbox]),.studio-page select,.studio-page textarea{min-height:44px;border:1px solid var(--markr-line-strong,#41494d);border-radius:6px;font:inherit;color:inherit;background:var(--markr-bg,#090a0b)}
.studio-page button{padding:9px 14px;cursor:pointer;transition:background 140ms cubic-bezier(.2,0,0,1),border-color 140ms cubic-bezier(.2,0,0,1)}.studio-page button:hover:not(:disabled){border-color:var(--markr-muted,#a0a4a8)}.studio-page button:disabled{opacity:.5;cursor:not-allowed}
.studio-page :is(button,input,select,textarea,a):focus-visible{outline:2px solid var(--markr-accent,#ccd4c4);outline-offset:3px}.studio-session{flex-wrap:wrap}.studio-session button{background:transparent;border-color:transparent;color:var(--markr-muted,#a0a4a8);font-size:13px}
.studio-tabs{display:flex;gap:24px;border-bottom:1px solid var(--markr-line,#282d31);margin-bottom:24px}.studio-tabs button{position:relative;background:transparent;border:0;border-radius:0;padding:10px 0;color:var(--markr-muted,#a0a4a8)}.studio-tabs button[aria-pressed=true]{color:var(--markr-text,#eeeee9)}.studio-tabs button[aria-pressed=true]::after{content:'';position:absolute;bottom:-1px;left:0;right:0;height:2px;background:var(--markr-accent,#ccd4c4)}
.studio-state{padding:32px 0;color:var(--markr-muted,#a0a4a8)}.studio-state a{display:inline-flex;align-items:center;min-height:44px;margin:12px 24px 0 0}.studio-notice{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:16px;border:1px solid #584044;border-radius:6px;color:var(--markr-error,#e5a6a2);margin-bottom:20px}.studio-notice p{flex:1;min-width:180px}.studio-notice button{flex-shrink:0}.studio-feedback{margin-bottom:20px!important;color:var(--markr-muted,#a0a4a8)}
.studio-workspace{display:grid;grid-template-columns:minmax(220px,280px) minmax(0,1fr);gap:40px;align-items:start}.studio-list-heading{justify-content:space-between;margin-bottom:12px}.studio-list-heading h2 span{color:var(--markr-muted,#a0a4a8);font-size:13px;font-weight:400;margin-left:8px}.studio-list-heading button{font-size:13px;background:transparent}.studio-empty{font-size:13px;color:var(--markr-muted,#a0a4a8);padding:16px 0}.studio-records{list-style:none;padding:0;margin:0}.studio-records li{display:flex;align-items:center;border-bottom:1px solid var(--markr-line,#282d31);gap:8px;padding:6px 0}.studio-records li>button{display:flex;flex:1;min-width:0;align-items:flex-start;flex-direction:column;text-align:left;gap:4px;border-color:transparent;border-radius:0;background:transparent;padding:8px}.studio-records strong{font-size:14px;font-weight:400;overflow-wrap:anywhere}.studio-records span{font-size:12px;color:var(--markr-muted,#a0a4a8)}.studio-records a{display:flex;align-items:center;justify-content:center;min-width:44px;min-height:44px;font-size:12px;color:var(--markr-muted,#a0a4a8)}.studio-record-active>button{border-left-color:var(--markr-accent,#ccd4c4)!important;background:var(--markr-surface,#121416)!important}
.studio-editor{min-width:0;background:var(--markr-surface,#121416);padding:24px;border-radius:6px}.studio-editor-heading{justify-content:space-between;margin-bottom:24px}.studio-editor-heading>span,.studio-save-row>span{font-size:12px;color:var(--markr-muted,#a0a4a8)}.studio-fields{margin:0 0 28px;padding:0;border:0;min-width:0}.studio-fields legend{display:block;width:100%;padding:0 0 12px;margin-bottom:4px;border-bottom:1px solid var(--markr-line,#282d31);font-size:14px;font-weight:500}.studio-fields>label,.studio-pair label{display:block;margin:16px 0 8px;font-size:13px}.studio-page input:not([type=checkbox]),.studio-page select,.studio-page textarea{display:block;width:100%;box-sizing:border-box;padding:10px 12px}.studio-page textarea{resize:vertical}.studio-page input[type=file]{font-size:13px;padding:9px}.studio-page input[type=file]::file-selector-button{min-height:28px;margin-right:12px;color:inherit;background:var(--markr-surface-raised,#1a1d20);border:0;border-radius:3px;cursor:pointer}.studio-page input[type=color]{width:80px;padding:5px}.studio-help{font-size:12px;color:var(--markr-muted,#a0a4a8);margin-top:8px!important;line-height:1.7}.studio-pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}.studio-check{display:flex!important;align-items:center;min-height:44px;gap:10px;margin:8px 0!important;cursor:pointer;font-size:13px}.studio-check input{width:18px;height:18px;flex-shrink:0;accent-color:var(--markr-accent,#ccd4c4)}.studio-check span{color:var(--markr-muted,#a0a4a8);font-size:12px}.studio-fields:disabled .studio-check{cursor:not-allowed}.studio-assets{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:12px;margin-top:16px;max-height:360px;overflow:auto}.studio-asset{margin:0!important;padding:0;min-width:0}.studio-asset img{display:block;width:100%;height:88px;object-fit:contain;background:var(--markr-bg,#090a0b)}.studio-asset .studio-check{margin:0!important}.studio-text-link{display:inline-flex;align-items:center;min-height:44px;font-size:13px;text-decoration:underline!important;text-underline-offset:4px}.studio-primary{background:var(--markr-accent,#ccd4c4)!important;color:var(--markr-bg,#090a0b)!important;border-color:var(--markr-accent,#ccd4c4)!important}.studio-save-row{flex-wrap:wrap}.studio-profile{max-width:720px}.studio-cover-preview{display:block;max-width:100%;max-height:220px;object-fit:contain;margin-top:16px}
@media(max-width:760px){.studio-workspace{grid-template-columns:1fr;gap:24px}.studio-records{max-height:260px;overflow:auto}.studio-editor{padding:20px}.studio-header{align-items:flex-start}.studio-session{gap:0}.studio-session button{padding-left:0;padding-right:16px}.studio-tabs{margin-bottom:20px}.studio-page{padding-top:24px}}
@media(max-width:420px){.studio-pair{grid-template-columns:1fr;gap:0}.studio-editor{padding:16px}.studio-editor-heading{align-items:flex-start}.studio-header h1{font-size:28px}}
@media(prefers-reduced-motion:reduce){.studio-page button{transition:none}}
</style>
