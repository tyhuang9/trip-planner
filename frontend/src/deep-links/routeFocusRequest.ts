let focusTarget: string | null = null

export function requestDeepLinkRouteFocus(target: string) {
  focusTarget = target
}

export function takeDeepLinkRouteFocusRequest(pathname: string) {
  if (focusTarget !== pathname) return false
  focusTarget = null
  return true
}

export function __resetDeepLinkRouteFocusForTests() {
  focusTarget = null
}
