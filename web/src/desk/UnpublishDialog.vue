<script setup lang="ts">
// Asks before taking a published collection down.
import ConfirmDialog from '../me/ConfirmDialog.vue'

const emit = defineEmits<{ confirm: []; cancel: [] }>()
</script>

<template>
  <ConfirmDialog
    title="撤回这组照片？"
    body="撤回后访客将看不到这组照片，链接会失效"
    confirm-label="撤回"
    :open="true"
    @confirm="emit('confirm')"
    @cancel="emit('cancel')"
  />
</template>
