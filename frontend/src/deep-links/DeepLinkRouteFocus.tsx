import { useEffect } from 'react'
import { useLocation } from 'react-router'
import { takeDeepLinkRouteFocusRequest } from './routeFocusRequest'

/** Moves focus only after navigation initiated by the deep-link subsystem. */
export function DeepLinkRouteFocus() {
  const location = useLocation()

  useEffect(() => {
    if (!takeDeepLinkRouteFocusRequest(location.pathname)) return
    let loadingFocused = false
    let completed = false

    const focusRoute = () => {
      const main = document.getElementById('main')
      const heading = main?.querySelector('h1')
      if (heading instanceof HTMLElement) {
        heading.tabIndex = -1
        heading.focus()
        completed = true
        return
      }
      if (main && !loadingFocused) {
        main.tabIndex = -1
        main.focus()
        loadingFocused = true
      }
    }

    focusRoute()
    if (completed) return
    const observer = new MutationObserver(() => {
      focusRoute()
      if (completed) observer.disconnect()
    })
    observer.observe(document.body, { childList: true, subtree: true })
    const timeout = window.setTimeout(() => observer?.disconnect(), 2_000)
    return () => {
      window.clearTimeout(timeout)
      observer?.disconnect()
    }
  }, [location.key, location.pathname])

  return null
}
