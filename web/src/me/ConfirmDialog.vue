<script setup lang="ts">
// A modal confirmation on the native <dialog> (spec §10). Opens with
// showModal() (falls back to the open attribute where it is missing, e.g.
// happy-dom), focuses 取消, and emits cancel for 取消, Esc and the dialog's
// own cancel event, plus any native close while `open` is still set. The
// parent owns focus return after it closes.
import { nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'

const props = defineProps<{
  title: string
  body: string
  confirmLabel: string
  open: boolean
  /** Server message from a failed confirm. */
  error?: string
  busy?: boolean
  /** Label for the cancel button; defaults to 取消. */
  cancelLabel?: string
  /** Disables confirm without marking it busy (e.g. a stale manifest). */
  confirmDisabled?: boolean
}>()
const emit = defineEmits<{ confirm: []; cancel: [] }>()

const el = ref<HTMLDialogElement | null>(null)
const cancelBtn = ref<HTMLButtonElement | null>(null)
const id = useId()

async function show() {
  const d = el.value
  if (!d) return
  if (!d.open) {
    if (typeof d.showModal === 'function') {
      try {
        d.showModal()
      } catch {
        d.setAttribute('open', '')
      }
    } else d.setAttribute('open', '')
  }
  await nextTick()
  cancelBtn.value?.focus()
}

function hide() {
  const d = el.value
  if (!d) return
  if (typeof d.close === 'function' && d.open) d.close()
  d.removeAttribute('open')
}

watch(
  () => props.open,
  (v) => (v ? void show() : hide()),
)
onMounted(() => {
  if (props.open) void show()
})
onBeforeUnmount(hide)

function onCancelEvent(e: Event) {
  // Keep the dialog open until the parent flips `open`.
  e.preventDefault()
  emit('cancel')
}

/**
 * A close the cancel event could not veto (browsers may ignore preventDefault
 * without fresh user activation) leaves the parent's `open` true; report it as
 * a cancel so the parent's state matches and the next open fires its watch.
 * `close` is dispatched as a queued task, so it can arrive after the dialog
 * was already reopened; only a dialog that is still closed counts.
 */
function onCloseEvent() {
  if (props.open && !el.value?.open) emit('cancel')
}

function onKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  e.preventDefault()
  e.stopPropagation()
  emit('cancel')
}

function onConfirm() {
  if (!props.busy && !props.confirmDisabled) emit('confirm')
}
</script>

<template>
  <dialog
    ref="el"
    class="confirm"
    :aria-labelledby="`${id}-title`"
    :aria-describedby="`${id}-body`"
    @cancel="onCancelEvent"
    @close="onCloseEvent"
    @keydown="onKeydown"
  >
    <h2 :id="`${id}-title`">{{ title }}</h2>
    <p :id="`${id}-body`">{{ body }}</p>
    <slot />
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div class="actions">
      <button ref="cancelBtn" type="button" @click="emit('cancel')">{{ cancelLabel ?? '取消' }}</button>
      <button type="button" class="danger" :disabled="busy || confirmDisabled" :aria-busy="busy ? 'true' : undefined" @click="onConfirm">
        {{ confirmLabel }}
      </button>
    </div>
  </dialog>
</template>

<style scoped>
.confirm {
  width: min(420px, calc(100vw - 32px));
  padding: var(--space-24);
  border: 1px solid var(--line);
  background: var(--bg-wall);
  color: var(--fg);
}
.confirm::backdrop {
  background: rgba(0, 0, 0, 0.6);
}
h2 {
  font-family: var(--font-title);
  font-weight: 400;
  font-size: 1.25rem;
  margin-bottom: var(--space-12);
}
p {
  color: var(--fg-muted);
}
.error {
  margin-top: var(--space-12);
  color: var(--fg);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-12);
  margin-top: var(--space-24);
}
button {
  min-height: 44px;
  min-width: 44px;
  padding: 0 var(--space-16);
  border: 1px solid var(--line);
  border-radius: 0;
  background: transparent;
  color: var(--fg);
  cursor: pointer;
}
button.danger {
  border-color: var(--fg);
}
button:disabled {
  cursor: default;
  opacity: 0.6;
}
button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
