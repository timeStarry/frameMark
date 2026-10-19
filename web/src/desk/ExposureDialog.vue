<script setup lang="ts">
// Asks before a save widens who can see the collection (spec §7). The parent
// mounts it while a check is pending and unmounts it on either answer.
import ConfirmDialog from '../me/ConfirmDialog.vue'

defineProps<{ changes: { kind: string; detail: string }[] }>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()
</script>

<template>
  <ConfirmDialog
    title="这次修改会扩大公开范围"
    body="保存后，下面这些会被更多人看到："
    confirm-label="确认并保存"
    cancel-label="撤销这次修改"
    :open="true"
    @confirm="emit('confirm')"
    @cancel="emit('cancel')"
  >
    <ul class="changes">
      <li v-for="(c, i) in changes" :key="`${c.kind}-${i}`">{{ c.detail }}</li>
    </ul>
  </ConfirmDialog>
</template>

<style scoped>
.changes {
  margin-top: var(--space-12);
  padding-left: 1.25em;
  list-style: disc;
  color: var(--fg);
}
</style>
