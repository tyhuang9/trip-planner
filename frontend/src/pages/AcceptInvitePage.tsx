import { useEffect, useRef } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router'
import { parseApiError } from '../api/errors'
import { useAuth } from '../auth/useAuth'
import { useAcceptShareLink } from '../hooks/useShareLinks'
import { usePageTitle } from '../utils/usePageTitle'
import { getDeepLinkHandoff } from '../deep-links/vault'
import { clearDeepLinkHandoff } from '../deep-links/vault'
import { requestDeepLinkRouteFocus } from '../deep-links/DeepLinkRouteFocus'
import styles from './SharePages.module.css'

export default function AcceptInvitePage() {
  usePageTitle('Accept invite – Dupert')

  const { token: routeToken, handoffId } = useParams()
  const handoff = getDeepLinkHandoff(handoffId)
  const token = handoff?.kind === 'share' ? handoff.token : routeToken
  const location = useLocation()
  const navigate = useNavigate()
  const { isAuthenticated, isInitializing } = useAuth()
  const acceptMutation = useAcceptShareLink()
  const returnPath = handoffId ? `/link/${handoffId}` : `${location.pathname}${location.search}`
  const autoAcceptStartedRef = useRef(false)

  const handleAccept = async () => {
    if (!token || acceptMutation.isPending) return
    try {
      const accepted = await acceptMutation.mutateAsync(token)
      clearDeepLinkHandoff(handoffId)
      const destination = `/trips/${encodeURIComponent(accepted.publicId)}`
      requestDeepLinkRouteFocus(destination)
      navigate(destination, { replace: true })
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
        clearDeepLinkHandoff(handoffId)
        const destination = `/trips/${encodeURIComponent(accepted.publicId)}`
        requestDeepLinkRouteFocus(destination)
        navigate(destination, { replace: true })
      })
      .catch(() => {
        // React Query owns the visible error state; this prevents an unhandled rejection.
      })
  }, [acceptMutation, handoffId, isAuthenticated, isInitializing, navigate, token])

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
              <p className={styles.subheading} role="status" aria-live="polite">Accepting invite...</p>
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
              to={handoffId ? `/link/${handoffId}/guest` : `/share/${encodeURIComponent(token ?? '')}/guest`}
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
