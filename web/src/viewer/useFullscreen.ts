// Element fullscreen with the webkit prefix (desktop Safari, iPadOS). iPhone
// Safari has no element fullscreen, so `supported` is false and the entry hides.
import { onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

type WebkitDocument = Document & {
  webkitFullscreenEnabled?: boolean
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}
type WebkitElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }

export function useFullscreen(target: Ref<HTMLElement | null>) {
  const doc = document as WebkitDocument
  const supported = Boolean(doc.fullscreenEnabled ?? doc.webkitFullscreenEnabled)
  const active = ref(false)

  const current = () => doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null
  const sync = () => {
    active.value = current() !== null
  }

  async function toggle() {
    if (!supported) return
    try {
      if (current()) {
        await (doc.exitFullscreen ? doc.exitFullscreen() : doc.webkitExitFullscreen?.())
      } else {
        const el = target.value as WebkitElement | null
        if (!el) return
        await (el.requestFullscreen ? el.requestFullscreen() : el.webkitRequestFullscreen?.())
      }
    } catch {
      // Denied (no user activation, iframe policy): stay as we are.
    }
    sync()
  }

  onMounted(() => {
    document.addEventListener('fullscreenchange', sync)
    document.addEventListener('webkitfullscreenchange', sync)
  })
  onBeforeUnmount(() => {
    document.removeEventListener('fullscreenchange', sync)
    document.removeEventListener('webkitfullscreenchange', sync)
  })

  return { supported, active, toggle }
}
