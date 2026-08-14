import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/focus-rings.css'
import './index.css'
import App from './App.tsx'
import { AppAccessGate } from './access/AppAccessGate.tsx'
import { AuthProvider } from './auth/AuthContext.tsx'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './api/queryClient.ts'
import { ColorModeProvider } from './theme/ColorModeProvider.tsx'
import { applyColorMode, readStoredColorMode } from './theme/colorMode.ts'
import { markPerformance } from './performance/timing.ts'
import { SpeedInsights } from '@vercel/speed-insights/react'
import { OutageBoundary } from './outage/OutageBoundary.tsx'
import { StartupAuthGate, StartupBoundary } from './startup/StartupBoundary.tsx'

applyColorMode(readStoredColorMode())
markPerformance('app-mounted')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ColorModeProvider>
      <QueryClientProvider client={queryClient}>
        <AppAccessGate>
          <StartupBoundary>
            <OutageBoundary>
            <AuthProvider>
              <StartupAuthGate>
                <App />
                <SpeedInsights />
              </StartupAuthGate>
            </AuthProvider>
            </OutageBoundary>
          </StartupBoundary>
        </AppAccessGate>
      </QueryClientProvider>
    </ColorModeProvider>
  </StrictMode>,
)
