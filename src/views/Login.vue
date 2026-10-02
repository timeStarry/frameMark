<script setup>
import { computed, ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { readSession, safeReturnTo, loginReturnTarget, accountSession, accountRequest } from '../auth/session.mjs'
const route=useRoute(),router=useRouter(),busy=ref(true),error=ref(''),message=ref(''),enabled=ref(false),registrationOpen=ref(false),mode=ref('login'),email=ref(''),password=ref(''),confirmation=ref(''),verification=ref('')
const returnTo=computed(()=>safeReturnTo(route.query.returnTo))
async function checkSession(){busy.value=true;error.value='';try{const session=await readSession();enabled.value=session.identityEnabled===true;if(enabled.value){const state=await accountSession();registrationOpen.value=state.registrationOpen}const target=loginReturnTarget(session,route.query.returnTo);if(target&&!verification.value)await router.replace(target)}catch(e){error.value=e.message}finally{busy.value=false}}
function switchMode(){mode.value=mode.value==='login'?'register':'login';password.value='';confirmation.value='';error.value='';message.value=''}
async function submit(){if(busy.value)return;busy.value=true;error.value='';message.value='';try{
 if(mode.value==='verify'&&password.value!==confirmation.value)throw Error('两次密码不一致。')
 const payload=mode.value==='verify'?{token:verification.value,password:password.value}:mode.value==='register'?{email:email.value}:{email:email.value,password:password.value}
 const result=await accountRequest('auth/'+mode.value,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
 password.value='';confirmation.value=''
 if(result.user){verification.value='';await router.replace(returnTo.value)}else message.value=result.message
 }catch(e){error.value=e.message}finally{busy.value=false}}
onMounted(async()=>{const match=/^#verify=([A-Za-z0-9_-]{43})$/.exec(route.hash);if(match){verification.value=match[1];mode.value='verify';await router.replace({path:'/login',query:route.query,hash:''})}else if(route.hash){error.value='验证链接格式无效。';await router.replace({path:'/login',query:route.query,hash:''})}await checkSession()})
</script>
<template>
 <section class="markr-page login-page">
  <div class="login-intro"><span class="eyebrow">YOUR SPACE ON MARKR</span><h1>把作品整理成<br>属于你的空间。</h1><p>保存草稿、发布作品、整理作品集，分享你的摄影视角。</p><div class="login-rule"></div><router-link to="/tools">只想处理照片？打开工具箱 →</router-link></div>
  <div class="login-panel"><span class="eyebrow">ACCOUNT</span><h2>{{mode==='verify'?'验证邮箱并设置密码':mode==='register'?'注册 Markr':'登录 Markr'}}</h2>
   <p v-if="busy" role="status" class="state-message">正在处理……</p>
   <div v-if="error" role="alert" class="state-message state-error">{{error}}<button v-if="!enabled" class="btn btn-secondary" @click="checkSession">重试</button></div>
   <p v-if="message" role="status" class="state-message">{{message}}</p>
   <div v-if="!busy&&!enabled" class="state-message"><span class="status-label">登录暂未开放</span><p>账户服务尚未启用，当前不能登录或注册。工具箱无需账号即可使用。</p></div>
   <form v-if="enabled" class="login-fields" @submit.prevent="submit">
    <label v-if="mode!=='verify'">邮箱<input v-model="email" type="email" required maxlength="254" autocomplete="email" :disabled="busy" placeholder="you@example.com"></label>
    <template v-if="mode!=='register'"><label>密码<input v-model="password" required type="password" minlength="15" :autocomplete="mode==='verify'?'new-password':'current-password'" :disabled="busy"></label><small>至少 15 个字符，最多 256 字节；可使用长口令。</small></template>
    <label v-if="mode==='verify'">再次输入密码<input v-model="confirmation" required type="password" minlength="15" autocomplete="new-password" :disabled="busy"></label>
    <p v-if="mode==='register'" class="return-note">我们将发送验证链接。验证邮箱后设置密码，不限制邮箱服务商。</p>
    <button class="btn btn-primary" :disabled="busy">{{mode==='verify'?'完成注册':mode==='register'?'发送验证邮件':'登录'}}</button>
    <button v-if="registrationOpen&&mode!=='verify'" type="button" class="btn btn-secondary" :disabled="busy" @click="switchMode">{{mode==='register'?'已有账户？登录':'创建账户'}}</button>
    <router-link v-if="mode==='verify'" to="/login" @click="verification='';mode='login'">返回邮箱登录</router-link>
   </form>
   <p class="return-note">登录成功后将返回{{returnTo.startsWith('/studio')?'我的工作台':'原来的页面'}}。</p><router-link class="login-back" to="/">返回广场</router-link>
  </div>
 </section>
</template>
<style scoped>
.login-page{min-height:calc(100vh - 180px);display:grid;grid-template-columns:1fr 420px;align-items:center;gap:clamp(40px,7vw,120px);padding-top:72px;padding-bottom:72px}.login-intro h1{font-size:clamp(32px,4.5vw,58px);line-height:1.2;font-weight:450;letter-spacing:-.035em;margin:24px 0}.login-intro>p{color:var(--markr-muted);max-width:400px;line-height:1.9}.login-rule{height:1px;max-width:400px;background:var(--markr-line);margin:32px 0}.login-intro a{font-size:13px;color:var(--markr-accent);text-decoration:none}.login-panel{padding:32px;border:1px solid var(--markr-line);background:var(--markr-surface);border-radius:var(--markr-radius)}.login-panel h2{font-size:26px;font-weight:500;margin:14px 0 24px}.state-message{font-size:13px;line-height:1.8;padding:16px;background:var(--markr-surface-raised);border:1px solid var(--markr-line);border-radius:var(--markr-radius-small);color:var(--markr-muted);margin-bottom:24px}.status-label{display:block;color:var(--markr-text);margin-bottom:6px}.state-error{border-color:var(--markr-error);color:var(--markr-error)}.state-message .btn{margin-top:12px}.login-fields label{display:block;font-size:13px;margin:16px 0;color:var(--markr-muted)}.login-fields input{display:block;width:100%;padding:12px;border:1px solid var(--markr-line);border-radius:var(--markr-radius-small);background:var(--markr-bg);margin-top:8px;color:var(--markr-muted)}.login-fields .btn{width:100%;margin-top:8px}.return-note{font-size:12px;color:var(--markr-muted);margin-top:16px}.login-back{display:inline-block;margin-top:24px;color:var(--markr-text);font-size:13px;text-decoration:none}@media(max-width:850px){.login-page{grid-template-columns:1fr;max-width:620px;padding-top:40px;gap:32px}.login-intro h1{font-size:36px}.login-rule{margin:20px 0}.login-panel{padding:24px}}
</style>
