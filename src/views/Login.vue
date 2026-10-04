<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { readSession, safeReturnTo, loginReturnTarget, accountSession, accountRequest } from '../auth/session.mjs'
const route = useRoute(), router = useRouter()
const busy = ref(true), error = ref(''), linkError = ref(''), message = ref('')
const enabled = ref(false), sessionReady = ref(false), sessionFailed = ref(false)
const privateTrial = ref(false), trialAcknowledged = ref(false), registrationOpen = ref(false)
const mode = ref('login'), email = ref(''), password = ref(''), confirmation = ref(''), verification = ref('')
const returnTo = computed(() => safeReturnTo(route.query.returnTo))
const visibleError = computed(() => error.value || linkError.value)
let alive = true, requestVersion = 0
const isCurrentRequest = (id, path) => alive && id === requestVersion && route.path === path
onBeforeUnmount(() => { alive = false; requestVersion++ })
async function checkSession() {
  if (!alive || route.path !== '/login') return
  const id = ++requestVersion, path = route.path
  busy.value = true
  error.value = ''
  enabled.value = false
  sessionReady.value = false
  sessionFailed.value = false
  try {
    const session = await readSession()
    if (!isCurrentRequest(id, path)) return
    if (session.identityEnabled === true) {
      const state = await accountSession()
      if (!isCurrentRequest(id, path)) return
      registrationOpen.value = state.registrationOpen === true
      privateTrial.value = state.privateTrial === true
      enabled.value = true
    }
    sessionReady.value = true
    const target = loginReturnTarget(session, route.query.returnTo)
    if (target && !verification.value && !linkError.value) await router.replace(target)
  } catch (e) {
    if (!isCurrentRequest(id, path)) return
    sessionFailed.value = true
    error.value = e.message || '暂时无法连接账户服务，请重试。'
  } finally { if (isCurrentRequest(id, path)) busy.value = false }
}
function switchMode() {
  mode.value = mode.value === 'login' ? 'register' : 'login'
  password.value = ''; confirmation.value = ''; error.value = ''; linkError.value = ''; message.value = ''
}
async function submit() {
  if (!alive || route.path !== '/login' || busy.value || !enabled.value || !sessionReady.value) return
  const id = ++requestVersion, path = route.path, destination = returnTo.value
  busy.value = true; error.value = ''; linkError.value = ''; message.value = ''
  try {
    if (mode.value === 'verify' && password.value !== confirmation.value) throw Error('两次密码不一致。')
    const payload = mode.value === 'verify' ? {token: verification.value, password: password.value}
      : mode.value === 'register' ? {email: email.value} : {email: email.value, password: password.value}
    if (privateTrial.value && mode.value !== 'register' && !trialAcknowledged.value) throw Error('请确认仅使用一次性试验密码。')
    if (privateTrial.value) payload.trialAcknowledged = trialAcknowledged.value
    const result = await accountRequest('auth/' + mode.value, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload)})
    if (!isCurrentRequest(id, path)) return
    password.value = ''; confirmation.value = ''
    if (result.user) { verification.value = ''; await router.replace(destination) }
    else message.value = result.message
  } catch (e) { if (isCurrentRequest(id, path)) error.value = e.message }
  finally { if (isCurrentRequest(id, path)) busy.value = false }
}
onMounted(async () => {
  const match = /^#verify=([A-Za-z0-9_-]{43})$/.exec(route.hash)
  if (match) { verification.value = match[1]; mode.value = 'verify' }
  else if (route.hash) linkError.value = '验证链接格式无效，请重新打开完整链接或使用邮箱登录。'
  if (route.hash) await router.replace({path: '/login', query: route.query, hash: ''})
  await checkSession()
})
</script>
<template>
 <section class="markr-page login-page" aria-labelledby="login-title">
  <div class="login-panel">
   <h1 id="login-title">{{mode==='verify'?'验证邮箱并设置密码':mode==='register'?'注册 Markr':'登录 Markr'}}</h1>
   <p v-if="busy" role="status" class="state-message">正在处理……</p>
   <div v-if="visibleError" role="alert" class="state-message state-error">{{visibleError}}<button v-if="sessionFailed" class="btn btn-secondary" :disabled="busy" @click="checkSession">重试</button></div>
   <p v-if="privateTrial" role="note" class="state-message trial-notice">私网 HTTP 试验：仅限当前 Tailscale 入口。请使用一次性密码，不要输入常用或正式密码；试验数据与正式数据分开。</p>
   <p v-if="message" role="status" class="state-message">{{message}}</p>
   <div v-if="sessionReady&&!busy&&!enabled" class="state-message"><span class="status-label">登录暂未开放</span><p>账户服务尚未启用，当前不能登录或注册。</p><router-link to="/tools">打开工具箱，无需账号</router-link></div>
   <form v-if="enabled" class="login-fields" :aria-busy="busy" @submit.prevent="submit">
    <label v-if="mode!=='verify'" class="field-label">邮箱<input v-model="email" type="email" required maxlength="254" autocomplete="email" :disabled="busy" placeholder="you@example.com"></label>
    <template v-if="mode!=='register'"><label class="field-label">密码<input v-model="password" required type="password" minlength="15" :autocomplete="mode==='verify'?'new-password':'current-password'" :disabled="busy" aria-describedby="password-hint"></label><small id="password-hint" class="field-hint">至少 15 个字符，最多 256 字节；可使用长口令。</small></template>
    <label v-if="mode==='verify'" class="field-label">再次输入密码<input v-model="confirmation" required type="password" minlength="15" autocomplete="new-password" :disabled="busy"></label>
    <p v-if="mode==='register'" class="return-note">我们将发送验证链接。验证邮箱后设置密码，不限制邮箱服务商。</p>
    <label v-if="privateTrial&&mode!=='register'" class="trial-check"><input v-model="trialAcknowledged" type="checkbox" required :disabled="busy"><span>我确认仅使用一次性试验密码</span></label>
    <button class="btn btn-primary" :disabled="busy">{{mode==='verify'?'完成注册':mode==='register'?'发送验证邮件':'登录'}}</button>
    <button v-if="registrationOpen&&mode!=='verify'" type="button" class="account-switch" :disabled="busy" @click="switchMode">{{mode==='register'?'已有账户？登录':'创建账户'}}</button>
    <router-link v-if="mode==='verify'" class="account-switch" to="/login" @click="verification='';mode='login'">返回邮箱登录</router-link>
   </form>
   <p v-if="enabled" class="return-note">登录后返回{{returnTo.startsWith('/studio')?'我的工作台':'原来的页面'}}。</p>
   <router-link class="login-back" to="/">返回广场</router-link>
  </div>
 </section>
</template>
<style scoped>
.login-page{min-height:calc(100vh - 160px);display:flex;align-items:flex-start;justify-content:center;padding-top:clamp(48px,10vh,112px);padding-bottom:64px}
.login-panel{width:100%;max-width:400px}
.login-panel h1{font-size:28px;line-height:1.3;font-weight:500;letter-spacing:-.025em;margin-bottom:32px}
.state-message{font-size:14px;line-height:1.7;color:var(--markr-muted);margin-bottom:24px;overflow-wrap:anywhere}
.state-message a{display:inline-flex;align-items:center;min-height:44px;color:var(--markr-text)}
.trial-notice{padding:16px;border:1px solid var(--markr-line-strong);border-radius:6px;background:var(--markr-surface)}
.status-label{display:block;color:var(--markr-text);margin-bottom:8px}
.state-error{color:var(--markr-error)}
.state-message .btn{display:flex;margin-top:12px}
.field-label{display:block;font-size:14px;margin:20px 0 8px;color:var(--markr-text)}
.field-label input{display:block;width:100%;min-height:48px;padding:12px;border:1px solid var(--markr-line-strong);border-radius:6px;background:var(--markr-surface);margin-top:8px;color:var(--markr-text)}
.field-hint,.return-note{font-size:13px;color:var(--markr-muted);line-height:1.7}
.trial-check{display:flex;align-items:center;gap:12px;min-height:44px;margin:20px 0;color:var(--markr-text);font-size:14px;cursor:pointer}
.trial-check input{flex:0 0 18px;width:18px;height:18px;margin:0;accent-color:var(--markr-accent)}
.login-fields .btn{width:100%;margin-top:24px}
.account-switch{display:flex;align-items:center;justify-content:center;min-height:44px;width:100%;padding:8px;margin-top:8px;background:none;border:0;color:var(--markr-muted);font:inherit;font-size:14px;cursor:pointer;text-decoration:none}
.account-switch:hover{color:var(--markr-text)}
.account-switch:disabled{opacity:.45;cursor:not-allowed}
.return-note{margin-top:16px}
.login-back{display:inline-flex;align-items:center;min-height:44px;margin-top:24px;color:var(--markr-muted);font-size:14px;text-decoration:none}
.login-back:hover{color:var(--markr-text)}
@media(max-width:600px){.login-page{padding-top:40px}.login-panel h1{font-size:28px}}
</style>
