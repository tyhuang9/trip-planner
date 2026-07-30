import type { PropsWithChildren } from 'react'
import { SpeedInsights } from '@vercel/speed-insights/react'
import { AppAccessGate } from '../access/AppAccessGate'
import { PwaUpdatePrompt } from '../pwa/PwaUpdatePrompt'
import { platformRuntime } from './runtime'

export function PlatformIntegrations({ children }: PropsWithChildren) {
  return (
    <AppAccessGate>
      {children}
      {platformRuntime.capabilities.serviceWorker ? <PwaUpdatePrompt /> : null}
      {platformRuntime.capabilities.vercelAnalytics ? <SpeedInsights /> : null}
    </AppAccessGate>
  )
}
