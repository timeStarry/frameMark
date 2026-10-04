<script setup>
import { computed } from 'vue'
import PhotoMedia from './PhotoMedia.vue'
const props = defineProps({ profile: { type: Object, required: true } })
const cover = computed(() => props.profile.coverMedia || (props.profile.cover ? { id: props.profile.cover, width: 22, height: 9 } : null))
</script>

<template>
  <header class="profile-header">
    <PhotoMedia v-if="cover" class="profile-header__cover" :media="cover" :alt="`${profile.name || '摄影师'}的封面`" eager fit="cover" />
    <div class="profile-header__identity">
      <span class="profile-header__accent" :style="{ backgroundColor: profile.accent || 'var(--markr-accent)' }" aria-hidden="true"></span>
      <h1 id="public-page-title" tabindex="-1">{{ profile.name || '摄影师' }}</h1>
      <p v-if="profile.bio">{{ profile.bio }}</p>
    </div>
  </header>
</template>

<style scoped>
.profile-header { margin-bottom: 48px; }
.profile-header__cover { aspect-ratio: 2.7; width: 100%; max-height: 440px; margin-bottom: 32px; }
.profile-header__identity { position: relative; max-width: 680px; padding-top: 20px; }
.profile-header__accent { position: absolute; top: 0; left: 0; width: 24px; height: 2px; }
.profile-header h1 { font-size: clamp(28px, 3vw, 36px); line-height: 1.3; font-weight: 500; letter-spacing: -.025em; overflow-wrap: anywhere; }
.profile-header p { margin-top: 16px; color: var(--markr-muted); font-size: 15px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 639px) { .profile-header { margin-bottom: 32px; } .profile-header__cover { aspect-ratio: 1.5; margin-bottom: 24px; } }
</style>
