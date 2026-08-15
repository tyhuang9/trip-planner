import { useEffect, useRef, useState } from 'react'
import { Link, Navigate } from 'react-router'
import { bootstrapGuestSession } from '../api/guestSession'
import { AuthBootstrapShell } from '../auth/AuthBootstrapShell'
import { useAuth } from '../auth/useAuth'
import styles from './LaunchRoute.module.css'

type BootstrapState =
  | { kind: 'idle' | 'loading' }
  | { kind: 'guest'; publicId: string }
  | { kind: 'missing' | 'error' }

export function LaunchRoute() {
  const { isAuthenticated, isInitializing } = useAuth()
  const [state, setState] = useState<BootstrapState>({ kind: 'idle' })
  const [attempt, setAttempt] = useState(0)
  const startedAttemptRef = useRef<number | null>(null)
  const cancelledRef = useRef(false)

  useEffect(() => {
    if (isInitializing || isAuthenticated || startedAttemptRef.current === attempt) {
      return
    }

    startedAttemptRef.current = attempt
    setState({ kind: 'loading' })

    bootstrapGuestSession()
      .then((session) => {
        if (cancelledRef.current) return
        setState(
          session === null
            ? { kind: 'missing' }
            : { kind: 'guest', publicId: session.publicId },
        )
      })
      .catch(() => {
        if (!cancelledRef.current) setState({ kind: 'error' })
      })
  }, [attempt, isAuthenticated, isInitializing])

  // Keep the one in-flight bootstrap usable across StrictMode's synthetic
  // setup/cleanup cycle, while still suppressing updates after a real unmount.
  useEffect(() => {
    cancelledRef.current = false
    return () => {
      cancelledRef.current = true
    }
  }, [])

  if (isAuthenticated) {
    return <Navigate to="/trips" replace />
  }

  if (isInitializing || state.kind === 'idle' || state.kind === 'loading') {
    return <AuthBootstrapShell />
  }

  if (state.kind === 'guest') {
    return <Navigate to={`/trips/${encodeURIComponent(state.publicId)}`} replace />
  }

  if (state.kind === 'missing') {
    return <Navigate to="/login" replace />
  }

  return (
    <main id="main" className={styles.shell}>
      <section className={styles.card} role="alert">
        <h1>We could not restore your trip</h1>
        <p>
          Check your connection and try restoring the guest session again.
        </p>
        <div className={styles.actions}>
          <button
            className={styles.primaryButton}
            type="button"
            onClick={() => setAttempt((current) => current + 1)}
          >
            Try again
          </button>
          <Link className={styles.secondaryLink} to="/login">
            Sign in
          </Link>
        </div>
      </section>
    </main>
  )
}
