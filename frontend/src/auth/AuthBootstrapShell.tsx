import { useEffect, useState } from 'react'
import { useAuth } from './useAuth'
import {
  getPendingLogoutPersistence,
  hasPendingLogoutIntent,
} from './logoutIntent'
import styles from './AuthBootstrapShell.module.css'

const SLOW_SERVER_MESSAGE_DELAY_MS = 2_500

/**
 * Keeps an app-shaped surface visible while the refresh-cookie probe settles.
 * The delayed copy prevents a transient probe from sounding like an error.
 */
export function AuthBootstrapShell() {
  const { authStatus, retryAuthResolution } = useAuth()
  const [isSlow, setIsSlow] = useState(false)
  const isOfflineUnknown = authStatus === 'offline-unknown'
  const isPendingLogout = isOfflineUnknown && hasPendingLogoutIntent()
  const isMemoryOnlyLogout =
    isPendingLogout && getPendingLogoutPersistence() === 'memory-only'

  useEffect(() => {
    if (isOfflineUnknown) return undefined
    const timer = window.setTimeout(() => setIsSlow(true), SLOW_SERVER_MESSAGE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [isOfflineUnknown])

  return (
    <main id="main" className={styles.shell}>
      <section
        className={styles.card}
        role={isOfflineUnknown ? 'alert' : 'status'}
        aria-live="polite"
        aria-busy={isOfflineUnknown ? undefined : 'true'}
      >
        {!isOfflineUnknown ? <span className={styles.spinner} aria-hidden="true" /> : null}
        <h1>
          {isPendingLogout
            ? 'Finishing sign out'
            : isOfflineUnknown
              ? 'We could not confirm your session'
              : 'Preparing your trip planner'}
        </h1>
        <p>
          {isPendingLogout
            ? isMemoryOnlyLogout
              ? 'You are signed out in this open app, but this device could not save the pending sign-out. Keep Dupert open and reconnect so it can revoke the server session.'
              : 'You are signed out on this device. Dupert will finish revoking the server session when the connection returns.'
            : isOfflineUnknown
            ? 'Your private trips are hidden until Dupert can reach the server.'
            : isSlow
              ? 'The server is taking longer than usual.'
              : 'Restoring your session…'}
        </p>
        {isOfflineUnknown ? (
          <button
            className={styles.retryButton}
            type="button"
            onClick={() => void retryAuthResolution()}
          >
            Try again
          </button>
        ) : null}
      </section>
    </main>
  )
}
