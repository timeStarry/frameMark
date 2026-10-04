<script setup>
defineProps({ owner: { type: String, default: '' }, name: { type: String, default: '' } })
</script>

<template>
  <router-link v-if="owner" class="photographer-byline" :to="`/profile/${owner}`">{{ name?.trim() ? `@${name.trim()}` : '摄影师' }}</router-link>
  <span v-else class="photographer-byline">{{ name?.trim() ? `@${name.trim()}` : '摄影师' }}</span>
</template>

<style scoped>
.photographer-byline { display: block; width: max-content; min-height: 44px; max-width: 100%; color: var(--markr-muted); font-size: 12px; line-height: 44px; text-decoration: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; transition: color 140ms cubic-bezier(.2,0,0,1); }
a.photographer-byline:hover, a.photographer-byline:focus-visible { color: var(--markr-text); }
</style>
