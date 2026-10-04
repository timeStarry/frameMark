<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { accountRequest } from '../auth/session.mjs'
import StudioView from './StudioView.vue'
import FeaturedPhoto from '../components/photography/FeaturedPhoto.vue'
import PhotoGrid from '../components/photography/PhotoGrid.vue'
import ProfileHeader from '../components/photography/ProfileHeader.vue'
import PageState from '../components/photography/PageState.vue'
import WorkViewer from '../components/photography/WorkViewer.vue'
import { isPublicPath, publicHistoryPosition, publicPositionFor, rememberPublicPosition } from '../composables/publicBrowse.js'
import { createPhotoTransitionController } from '../composables/photoTransition.js'

const route = useRoute(), router = useRouter()
const page = ref(null), state = ref('loading'), error = ref('')
const appending = ref(false), appendError = ref(''), announcement = ref('')
const root = ref(null), pageCount = ref(1)
const photoTransition = createPhotoTransitionController(router, {
  getRoot: () => root.value,
  getReturnHint: to => publicPositionFor(to.fullPath, publicHistoryPosition()),
})
let requestVersion = 0, controller, loadedPath = '', loadedPosition = null, focusId = null, disposed = false
const section = computed(() => route.path === '/' ? 'square' : route.path.split('/')[1])
const featured = computed(() => page.value?.banner?.find(work => work.assets?.length || work.media?.length))
const modules = computed(() => (page.value?.modules || ['works', 'collections']).filter(value => value === 'works' || value === 'collections'))
const title = computed(() => section.value === 'square' ? '广场' : page.value?.name || page.value?.title || (section.value === 'profile' ? '摄影师' : '作品'))

function capturePosition() {
  if (!loadedPath || state.value !== 'ready') return
  const activeId = document.activeElement?.id
  const originId = activeId?.startsWith('photo-') || activeId?.startsWith('featured-') ? activeId : focusId
  const originImage = (originId && document.getElementById(originId)?.querySelector('img[data-photo-id]')) || root.value?.querySelector('.work-viewer__stage img[data-photo-id]')
  rememberPublicPosition(loadedPath, {
    top: window.scrollY, left: window.scrollX, pages: pageCount.value,
    focusId: originId, mediaId: originImage?.dataset.photoId,
    position: loadedPosition,
  })
}
function rememberOrigin(id) { focusId = id; capturePosition() }
function goBack() {
  const back = window.history.state?.back
  if (typeof back === 'string' && back.startsWith('/') && !back.startsWith('//')) router.back()
  else router.push('/')
}
function sameRequest(version) { return !disposed && version === requestVersion }
function mergeWorks(current, incoming) {
  const ids = new Set(current.map(work => work.id))
  return [...current, ...incoming.filter(work => !ids.has(work.id) && ids.add(work.id))]
}
async function requestSquare(cursor, signal) {
  const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
  return accountRequest(`square?limit=12${suffix}`, { signal })
}
async function placePage(version, restore, navigationFocus) {
  await nextTick()
  if (!sameRequest(version) || !root.value) return
  document.title = `${title.value} · Markr`
  const active = document.activeElement
  if (active && active !== navigationFocus && active !== document.body && active !== document.documentElement) return
  const focus = restore?.focusId ? document.getElementById(restore.focusId) : null
  const target = focus || root.value.querySelector('.work-viewer, #public-page-title') || root.value
  target.focus?.({ preventScroll: true })
  const lostOrigin = restore?.focusId && !focus
  window.scrollTo({ top: lostOrigin ? 0 : restore?.top || 0, left: lostOrigin ? 0 : restore?.left || 0, behavior: 'instant' })
}
async function load({ restore = null } = {}) {
  const path = route.path
  if (!isPublicPath(path)) return
  const version = ++requestVersion
  const navigationFocus = document.activeElement
  let replayFailed = false
  controller?.abort()
  controller = new AbortController()
  const signal = controller.signal
  page.value = null; state.value = 'loading'; error.value = ''
  appending.value = false; appendError.value = ''; announcement.value = ''; pageCount.value = 1
  loadedPath = route.fullPath; loadedPosition = publicHistoryPosition(); focusId = restore?.focusId || null
  try {
    let data = path === '/' ? await requestSquare(null, signal) : await accountRequest(path.slice(1), { signal })
    if (!sameRequest(version)) return
    if (path === '/') {
      data = { ...data, works: Array.isArray(data.works) ? data.works : [], nextCursor: data.nextCursor || null }
      const visited = new Set()
      while (pageCount.value < (restore?.pages || 1) && data.nextCursor && !visited.has(data.nextCursor)) {
        visited.add(data.nextCursor)
        let more
        try { more = await requestSquare(data.nextCursor, signal) }
        catch (failure) {
          if (!sameRequest(version) || failure.name === 'AbortError') throw failure
          appendError.value = failure.message || '暂时无法恢复后续作品，请重试。'
          replayFailed = true
          break
        }
        if (!sameRequest(version)) return
        data.works = mergeWorks(data.works, more.works || [])
        data.nextCursor = more.nextCursor || null
        pageCount.value += 1
      }
    } else if (!data?.id) throw Error('内容不存在或暂时无法查看。')
    page.value = data; state.value = 'ready'
  } catch (failure) {
    if (!sameRequest(version) || failure.name === 'AbortError') return
    error.value = failure.message || '暂时无法载入，请重试。'; state.value = 'error'
  }
  if (sameRequest(version)) {
    await placePage(version, replayFailed ? null : restore, navigationFocus)
    if (sameRequest(version)) photoTransition.pageReady(route.fullPath, { ok: state.value === 'ready' && !replayFailed })
  }
}
async function loadMore() {
  if (appending.value || !page.value?.nextCursor) return
  const version = requestVersion, cursor = page.value.nextCursor
  const launchTarget = document.activeElement
  const launchedFromButton = launchTarget?.classList.contains('public-page__continue')
  appending.value = true; appendError.value = ''; announcement.value = ''
  try {
    const data = await requestSquare(cursor, controller.signal)
    if (!sameRequest(version)) return
    const previous = page.value.works.length
    page.value.works = mergeWorks(page.value.works, data.works || [])
    page.value.nextCursor = data.nextCursor && data.nextCursor !== cursor ? data.nextCursor : null
    pageCount.value += 1
    announcement.value = `已载入 ${page.value.works.length - previous} 件作品，共 ${page.value.works.length} 件。`
    if (launchedFromButton && !page.value.nextCursor) {
      await nextTick()
      if (!sameRequest(version)) return
      if (document.activeElement === launchTarget || document.activeElement === document.body) {
        const firstNew = page.value.works.slice(previous).find(work => work.id !== featured.value?.id)
        const links = root.value?.querySelectorAll('.photo-tile__link')
        const target = firstNew ? document.getElementById(`photo-${firstNew.kind === 'collection' ? 'collection' : 'work'}-${firstNew.id}`) : links?.[links.length - 1]
        target?.focus({ preventScroll: true })
      }
    }
  } catch (failure) {
    if (sameRequest(version) && failure.name !== 'AbortError') appendError.value = failure.message || '暂时无法载入更多作品。'
  } finally { if (sameRequest(version)) appending.value = false }
}
watch(() => route.fullPath, () => {
  capturePosition()
  if (!isPublicPath(route.path)) {
    ++requestVersion; controller?.abort(); loadedPath = ''; return
  }
  const restore = publicPositionFor(route.fullPath, publicHistoryPosition())
  load({ restore })
}, { immediate: true })
onBeforeUnmount(() => { capturePosition(); disposed = true; ++requestVersion; controller?.abort(); photoTransition.dispose() })
</script>

<template>
  <StudioView v-if="route.path === '/studio'" />
  <section v-else ref="root" class="public-page" :class="{ 'public-page--viewer': section === 'work' }" tabindex="-1">
    <h1 v-if="section === 'square' || state !== 'ready'" id="public-page-title" class="public-page__sr" tabindex="-1">{{ title }}</h1>
    <PageState v-if="state === 'loading'" kind="loading" message="正在载入……" />
    <PageState v-else-if="state === 'error'" kind="error" :message="error" @retry="load()" />
    <template v-else-if="page">
      <template v-if="section === 'square'">
        <FeaturedPhoto v-if="featured" :work="featured" @navigate="rememberOrigin" />
        <PhotoGrid v-if="page.works.length" :works="page.works" paginated :eager-first="!featured" :exclude-id="featured?.id || ''" reveal-key="square" @navigate="rememberOrigin" />
        <PageState v-else-if="!featured" message="广场还没有公开作品。" />
        <div v-if="page.nextCursor || appending || appendError" class="public-page__more">
          <p v-if="appendError" role="alert">{{ appendError }}</p>
          <button class="public-page__continue" type="button" :disabled="appending" @click="loadMore">{{ appending ? '正在载入……' : appendError ? '重试' : '继续浏览' }}</button>
        </div>
        <p class="public-page__sr" role="status" aria-live="polite">{{ announcement }}</p>
      </template>
      <WorkViewer v-else-if="section === 'work'" :work="page" @back="goBack" />
      <template v-else-if="section === 'collection'">
        <button type="button" class="public-page__back" @click="goBack"><span aria-hidden="true">←</span> 返回</button>
        <header class="collection-intro">
          <h1 id="public-page-title" tabindex="-1">{{ page.title }}</h1>
          <p v-if="page.text">{{ page.text }}</p>
        </header>
        <PhotoGrid v-if="page.items?.length" :works="page.items" :reveal-key="route.path" @navigate="rememberOrigin" />
        <PageState v-else message="此作品集暂时没有可查看的作品。" />
      </template>
      <template v-else-if="section === 'profile'">
        <ProfileHeader :profile="page" />
        <section v-for="module in modules" :key="module" class="profile-section" :aria-labelledby="`profile-${module}`">
          <h2 :id="`profile-${module}`">{{ module === 'works' ? '作品' : '作品集' }}</h2>
          <PhotoGrid v-if="page[module]?.length" :works="page[module]" :eager-first="!page.cover && !page.coverMedia && module === modules[0]" :show-author="false" :column="page.layout === 'column'" :reveal-key="`${route.path}:${module}`" @navigate="rememberOrigin" />
          <PageState v-else :message="module === 'works' ? '暂无公开作品。' : '暂无公开作品集。'" />
        </section>
      </template>
    </template>
  </section>
</template>

<style scoped>
.public-page { max-width: 1600px; width: 100%; margin-inline: auto; padding: 32px clamp(16px, 4vw, 64px) 64px; color: var(--markr-text); outline: none; }
.public-page--viewer { padding-top: 16px; }
.public-page__sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.public-page__more { display: grid; justify-items: center; gap: 16px; margin-top: 48px; }
.public-page__more p { color: var(--markr-error); font-size: 13px; }
.public-page__more button { min-height: 44px; padding: 10px 24px; border: 1px solid var(--markr-line-strong); border-radius: 6px; background: transparent; color: var(--markr-text); font-size: 13px; cursor: pointer; }
.public-page__more button:hover:not(:disabled) { border-color: var(--markr-muted); }
.public-page__more button:disabled { opacity: .55; cursor: wait; }
.public-page__back { display: inline-flex; align-items: center; gap: 10px; min-height: 44px; padding: 8px 0; border: 0; color: var(--markr-muted); background: transparent; cursor: pointer; font-size: 13px; }
.collection-intro { max-width: 760px; margin: 24px 0 40px; }
.collection-intro h1 { font-size: clamp(28px, 3vw, 36px); font-weight: 400; line-height: 1.35; letter-spacing: -.025em; overflow-wrap: anywhere; }
.collection-intro p { margin-top: 16px; color: var(--markr-muted); font-size: 15px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; }
.profile-section + .profile-section { margin-top: 48px; }
.profile-section > h2 { margin: 0 0 24px; font-size: 15px; font-weight: 500; }
@media (max-width: 639px) { .public-page { padding-top: 20px; padding-bottom: 40px; } .public-page--viewer { padding-top: 8px; } .collection-intro { margin-bottom: 32px; } .public-page__more { margin-top: 32px; } }
</style>
