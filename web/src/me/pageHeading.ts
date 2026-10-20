// Title and focus for an account page (spec §10). On an in-app navigation the
// page h1 takes focus, so keyboard and screen-reader users land on the new
// page instead of <body> (the link they activated is often unmounted). The
// first page of a visit keeps the browser's own focus handling: vue-router
// records the previous location in history.state.back, which is null there.
import { nextTick, onBeforeUnmount, onMounted, watch, type Ref } from 'vue'

const BASE = 'Markr'

function arrivedInApp(): boolean {
  try {
    const back = (window.history.state as { back?: unknown } | null)?.back
    return typeof back === 'string'
  } catch {
    return false
  }
}

export function usePageHeading(heading: Ref<HTMLElement | null>, title: () => string): void {
  watch(title, (t) => (document.title = `${t} — ${BASE}`), { immediate: true })
  onMounted(() => {
    if (!arrivedInApp()) return
    void nextTick(() => heading.value?.focus({ preventScroll: true }))
  })
  onBeforeUnmount(() => {
    document.title = BASE
  })
}
