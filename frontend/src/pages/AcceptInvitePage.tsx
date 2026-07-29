import { useEffect, useRef } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { parseApiError } from '../api/errors'
import { useAuth } from '../auth/useAuth'
import { useAcceptShareLink } from '../hooks/useShareLinks'
import { usePageTitle } from '../utils/usePageTitle'
import styles from './SharePages.module.css'

export default function AcceptInvitePage() {
  usePageTitle('Accept invite – Dupert')

  const { token } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const { isAuthenticated, isInitializing } = useAuth()
  const acceptMutation = useAcceptShareLink()
  const returnPath = `${location.pathname}${location.search}`
  const autoAcceptStartedRef = useRef(false)

  const handleAccept = async () => {
    if (!token || acceptMutation.isPending) return
    try {
      const accepted = await acceptMutation.mutateAsync(token)
      navigate(`/trips/${encodeURIComponent(accepted.publicId)}`, { replace: true })
    } catch {
      // React Query owns the visible error state.
    }
  }

  useEffect(() => {
    if (isInitializing || !isAuthenticated || !token || autoAcceptStartedRef.current) {
      return
    }
    autoAcceptStartedRef.current = true
    void acceptMutation
      .mutateAsync(token)
      .then((accepted) => {
        navigate(`/trips/${encodeURIComponent(accepted.publicId)}`, { replace: true })
      })
      .catch(() => {
        // React Query owns the visible error state; this prevents an unhandled rejection.
      })
  }, [acceptMutation, isAuthenticated, isInitializing, navigate, token])

  return (
    <main id="main" className={styles.narrowShell}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.heading}>Accept invite</h1>
          <p className={styles.subheading}>Join this shared itinerary.</p>
        </div>
      </header>

      <section className={styles.section}>
        {acceptMutation.error && (
          <p className={styles.banner} role="alert">
            {parseApiError(acceptMutation.error).topMessage}
          </p>
        )}

        {isInitializing ? (
          <p className={styles.subheading}>Checking your session...</p>
        ) : isAuthenticated ? (
          <div className={styles.actions}>
            {acceptMutation.isPending ? (
              <p className={styles.subheading}>Accepting invite...</p>
            ) : null}
            <button
              type="button"
              className={styles.primaryButton}
              onClick={() => void handleAccept()}
              disabled={acceptMutation.isPending || !token}
            >
              {acceptMutation.isPending ? 'Accepting...' : 'Accept invite'}
            </button>
          </div>
        ) : (
          <div className={styles.actions}>
            <Link
              to={`/login?return=${encodeURIComponent(returnPath)}`}
              className={styles.primaryButton}
            >
              Sign in
            </Link>
            <Link
              to={`/register?return=${encodeURIComponent(returnPath)}`}
              className={styles.secondaryLink}
            >
              Create account
            </Link>
            <Link
              to={`/share/${encodeURIComponent(token ?? '')}/guest`}
              className={styles.secondaryLink}
            >
              Continue as guest
            </Link>
          </div>
        )}
      </section>
    </main>
  )
}
