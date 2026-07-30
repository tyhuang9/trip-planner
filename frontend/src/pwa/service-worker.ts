/// <reference lib="webworker" />

import { clientsClaim } from 'workbox-core'
import { cleanupOutdatedCaches, matchPrecache, precacheAndRoute } from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ revision: string | null; url: string }>
  __DUPERT_PWA_POLICY__: string
}

const OFFLINE_SHELL_URL = '/offline.html'
const PWA_POLICY = 'static-precache;navigation-network-only;runtime-cache-none'

// VitePWA injects only content-hashed static assets plus the explicitly
// revisioned offline shell, manifest, and icons. No runtime responses enter a
// cache through this worker.
precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()
clientsClaim()
self.__DUPERT_PWA_POLICY__ = PWA_POLICY

registerRoute(new NavigationRoute(async (options) => {
  try {
    // Keep direct-route SPA behavior server-owned while online. In particular,
    // do not cache index or any authenticated navigation response.
    return await fetch(options.request)
  } catch {
    return await matchPrecache(OFFLINE_SHELL_URL) ?? Response.error()
  }
}))

// Updates remain waiting until the visible prompt receives user consent.
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    void self.skipWaiting()
  }
})
