import { App } from '@capacitor/app'
import { Capacitor } from '@capacitor/core'

import type { BuildTarget, DeploymentEnvironment } from './buildProfile'

export type ActualPlatform = 'web' | 'ios' | 'android'

export type AppLifecycleState = 'foreground' | 'background'

export interface PlatformCapabilities {
  appAccessGate: boolean
  appLifecycle: boolean
  browserMapsLoader: boolean
  serviceWorker: boolean
  vercelAnalytics: boolean
}

export interface PlatformRuntime {
  actualPlatform: ActualPlatform
  backendBaseUrl: string
  capabilities: Readonly<PlatformCapabilities>
  environment: DeploymentEnvironment
  target: BuildTarget
}

function detectActualPlatform(): ActualPlatform {
  const reported = Capacitor.getPlatform()
  if (reported === 'ios' || reported === 'android') {
    return reported
  }
  return 'web'
}

const target = __DUPERT_BUILD_TARGET__
const environment = __DUPERT_DEPLOYMENT_ENVIRONMENT__

export const platformRuntime: Readonly<PlatformRuntime> = Object.freeze({
  target,
  environment,
  actualPlatform: detectActualPlatform(),
  backendBaseUrl: __DUPERT_BACKEND_BASE_URL__,
  capabilities: Object.freeze({
    appAccessGate: target === 'web',
    appLifecycle: true,
    browserMapsLoader: target === 'web',
    serviceWorker: target === 'web',
    vercelAnalytics: target === 'web' && environment === 'production',
  }),
})

/**
 * One app-lifecycle seam for browser visibility and Capacitor foreground events.
 * Callers never need to scatter native-platform checks.
 */
export function subscribeToAppLifecycle(
  listener: (state: AppLifecycleState) => void,
): () => void {
  if (target === 'native') {
    const nativeListener = App.addListener('appStateChange', ({ isActive }) => {
      listener(isActive ? 'foreground' : 'background')
    }).catch(() => undefined)

    return () => {
      void nativeListener.then((handle) => handle?.remove())
    }
  }

  const emitVisibilityState = () => {
    listener(document.visibilityState === 'hidden' ? 'background' : 'foreground')
  }

  document.addEventListener('visibilitychange', emitVisibilityState)
  window.addEventListener('pageshow', emitVisibilityState)
  window.addEventListener('focus', emitVisibilityState)

  return () => {
    document.removeEventListener('visibilitychange', emitVisibilityState)
    window.removeEventListener('pageshow', emitVisibilityState)
    window.removeEventListener('focus', emitVisibilityState)
  }
}
