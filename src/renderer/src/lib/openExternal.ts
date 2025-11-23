export function openExternalSafe(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  try {
    if (window.api && typeof window.api.openExternal === 'function') {
      window.api.openExternal(url)
      return true
    }
    return false
  } catch {
    return false
  }
}
