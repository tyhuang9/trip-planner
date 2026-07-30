import { useEffect, type PropsWithChildren } from 'react'
import { App } from '@capacitor/app'
import { captureDeepLink } from '../deep-links/capture'

/** Native builds intentionally omit browser access-gate and analytics code. */
export function PlatformIntegrations({ children }: PropsWithChildren) {
  useEffect(() => {
    let disposed = false
    let removeListener: (() => void) | undefined

    void App.getLaunchUrl()
      .then((result) => {
        if (!disposed) captureDeepLink(result?.url)
      })
      .catch(() => undefined)
    void App.addListener('appUrlOpen', ({ url }) => {
      if (!disposed) captureDeepLink(url)
    }).then((listener) => {
      if (disposed) {
        void listener.remove()
      } else {
        removeListener = () => void listener.remove()
      }
    }).catch(() => undefined)

    return () => {
      disposed = true
      removeListener?.()
    }
  }, [])

  return <>{children}</>
}
