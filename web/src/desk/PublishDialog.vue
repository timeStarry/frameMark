<script setup lang="ts">
// Shows the publish manifest before going live (spec §8). A refusal arrives
// as `message`; a stale manifest blocks 发布 until it is regenerated.
import { computed } from 'vue'
import ConfirmDialog from '../me/ConfirmDialog.vue'
import type { Manifest } from '../api/types'
import { manifestLines } from './labels'

const props = defineProps<{
  manifest: Manifest | null
  license: string | null
  aiDeclaration: string | null
  message: string
  stale: boolean
  busy: boolean
}>()
const emit = defineEmits<{ confirm: []; cancel: []; regenerate: [] }>()

const body = computed(() =>
  props.manifest ? manifestLines(props.manifest, props.license, props.aiDeclaration).join(' · ') : '正在生成发布清单…',
)
</script>

<template>
  <ConfirmDialog
    title="发布这组照片"
    :body="body"
    confirm-label="发布"
    :open="true"
    :error="message || undefined"
    :busy="busy"
    :confirm-disabled="manifest === null || stale"
    @confirm="emit('confirm')"
    @cancel="emit('cancel')"
  >
    <button v-if="stale" type="button" class="regenerate" @click="emit('regenerate')">重新生成清单</button>
  </ConfirmDialog>
</template>

<style scoped>
.regenerate {
  margin-top: var(--space-12);
  min-height: 44px;
  min-width: 44px;
  padding: 0 var(--space-16);
  border: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  color: var(--fg);
  cursor: pointer;
}
.regenerate:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
