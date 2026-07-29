import { useEffect, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { verifyEmail } from '../api/auth'
import { parseApiError } from '../api/errors'
import { listTrips } from '../api/trips'
import { useAuthStore } from '../auth/authStore'
import { safeReturnPath } from '../auth/safeReturnPath'
import { tripKeys } from '../hooks/useTrips'
import { usePageTitle } from '../utils/usePageTitle'
import { clearDeepLinkHandoff, consumeDeepLinkHandoff, getDeepLinkHandoff, putDeepLinkHandoff } from '../deep-links/vault'
import { requestDeepLinkRouteFocus } from '../deep-links/routeFocusRequest'
import { useAuth } from '../auth/useAuth'
import styles from './AuthForm.module.css'

type VerificationState = 'verifying' | 'verified' | 'error'

export function EmailVerificationPage() {
  usePageTitle('Verify email - Dupert')

  const [searchParams] = useSearchParams()
  const { handoffId } = useParams()
  const [handoff] = useState(() => getDeepLinkHandoff(handoffId))
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { isAuthenticated, isInitializing, logout } = useAuth()
  const setSession = useAuthStore((state) => state.setSession)
  const token = handoff?.kind === 'verify-email' ? handoff.token : searchParams.get('token') ?? ''
  const returnTo = handoff?.kind === 'verify-email' ? handoff.returnTo : safeReturnPath(searchParams.get('return'))
  const hasToken = token.trim().length > 0
  const [verification, setVerification] = useState<{
    state: VerificationState
    message: string
  }>({
    state: 'verifying',
    message: 'Verifying your email...',
  })
  const startedRef = useRef(false)
  const [identitySwitchRequired, setIdentitySwitchRequired] = useState(isAuthenticated)
  const [identitySwitchConfirmed, setIdentitySwitchConfirmed] = useState(false)
  const [isSwitchingIdentity, setIsSwitchingIdentity] = useState(false)
  const [identitySwitchError, setIdentitySwitchError] = useState<string | null>(null)

  if (isAuthenticated && !identitySwitchRequired) setIdentitySwitchRequired(true)

  useEffect(() => {
    if (!hasToken) return
    if (isInitializing || isAuthenticated) return
    if (identitySwitchRequired && !identitySwitchConfirmed) return
    if (startedRef.current) return
    startedRef.current = true

    verifyEmail({ token })
      .then((res) => {
        if (!identitySwitchConfirmed && useAuthStore.getState().authStatus === 'authenticated') {
          startedRef.current = false
          setIdentitySwitchRequired(true)
          return
        }
        setSession({
          accessToken: res.accessToken,
          expiresInSeconds: res.expiresInSeconds,
          user: res.user,
        })
        void queryClient.prefetchQuery({
          queryKey: tripKeys.lists(),
          queryFn: listTrips,
        })
        setVerification({
          state: 'verified',
          message: 'Your email is verified. Taking you to Dupert...',
        })
        const destination = typeof returnTo === 'string'
          ? returnTo
          : returnTo.kind === 'share'
            ? `/link/${putDeepLinkHandoff(returnTo)}`
            : returnTo.path
        consumeDeepLinkHandoff(handoffId)
        if (handoffId) requestDeepLinkRouteFocus(destination)
        navigate(destination, { replace: true })
      })
      .catch((err) => {
        setVerification({
          state: 'error',
          message:
            parseApiError(err).topMessage ??
            'This verification link is invalid or expired.',
        })
        clearDeepLinkHandoff(handoffId)
      })
  }, [handoffId, hasToken, identitySwitchConfirmed, identitySwitchRequired, isAuthenticated, isInitializing, navigate, queryClient, returnTo, setSession, token])

  const confirmIdentitySwitch = async () => {
    if (isSwitchingIdentity) return
    setIsSwitchingIdentity(true)
    setIdentitySwitchError(null)
    try {
      await logout()
      setIdentitySwitchConfirmed(true)
    } catch {
      setIdentitySwitchError('Could not sign out. Your current session was not changed.')
    } finally {
      setIsSwitchingIdentity(false)
    }
  }

  const state = hasToken ? verification.state : 'error'
  const message = hasToken
    ? isInitializing
      ? 'Checking your current session...'
      : verification.message
    : 'This verification link is invalid or expired.'
  const needsIdentitySwitch = hasToken && !isInitializing && identitySwitchRequired && !identitySwitchConfirmed

  return (
    <main id="main" className={styles.shell}>
      <div className={`${styles.card} ${styles.resultCard}`}>
        <h1 className={styles.title}>
          {state === 'verified' ? 'Email verified' : 'Verify email'}
        </h1>
        <p className={styles.subtitle}>
          {state === 'verifying'
            ? 'Checking your verification link.'
            : 'Dupert account verification.'}
        </p>
        {needsIdentitySwitch ? (
          <div className={identitySwitchError ? styles.banner : styles.bannerWarning} role="alert">
            <span>{identitySwitchError ?? 'This verification link may belong to a different account. Sign out before verifying it to protect your current session.'}</span>
          </div>
        ) : <div
          className={
            state === 'error'
              ? styles.banner
              : `${styles.bannerSuccess} ${styles.centeredNotice}`
          }
          role={state === 'error' ? 'alert' : 'status'}
        >
          {message}
        </div>}
        {needsIdentitySwitch ? (
          <button className={styles.submit} type="button" disabled={isSwitchingIdentity} onClick={() => void confirmIdentitySwitch()}>
            {isSwitchingIdentity ? 'Signing out...' : 'Sign out and verify this email'}
          </button>
        ) : null}
        <p className={styles.altLink}>
          <Link to="/login">Back to sign in</Link>
        </p>
      </div>
    </main>
  )
}

export default EmailVerificationPage
