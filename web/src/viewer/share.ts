// Share a collection link: the system share sheet where there is one,
// otherwise copy to the clipboard.
export type ShareResult = 'shared' | 'copied' | 'cancelled' | 'failed'

export async function share(url: string, title: string): Promise<ShareResult> {
  const nav = typeof navigator === 'undefined' ? undefined : navigator
  if (nav && typeof nav.share === 'function') {
    try {
      await nav.share({ url, title })
      return 'shared'
    } catch (e) {
      // The user closed the sheet; anything else falls through to copying.
      if (e instanceof DOMException && e.name === 'AbortError') return 'cancelled'
    }
  }
  if (nav?.clipboard && typeof nav.clipboard.writeText === 'function') {
    try {
      await nav.clipboard.writeText(url)
      return 'copied'
    } catch {
      return 'failed'
    }
  }
  return 'failed'
}
