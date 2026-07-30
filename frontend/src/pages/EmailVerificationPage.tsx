import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
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

type VerificationState = 'verifying' | 'verified' | 'verified-current-session-unchanged' | 'error'

interface VerificationRequest {
  locationKey: string
  token: string
}

export function EmailVerificationPage() {
  usePageTitle('Verify email - Dupert')

  const [searchParams] = useSearchParams()
  const { handoffId } = useParams()
  const handoff = useMemo(() => getDeepLinkHandoff(handoffId), [handoffId])
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { isAuthenticated, isInitializing, logout } = useAuth()
  const setSession = useAuthStore((state) => state.setSession)
  const token = handoff?.kind === 'verify-email' ? handoff.token : searchParams.get('token') ?? ''
  const returnTo = handoff?.kind === 'verify-email' ? handoff.returnTo : safeReturnPath(searchParams.get('return'))
  const hasToken = token.trim().length > 0
  const [verification, setVerification] = useState<{
    locationKey: string
    state: VerificationState
    message: string
    token: string
  }>({
    locationKey: location.key,
    state: 'verifying',
    message: 'Verifying your email...',
    token,
  })
  const mountedRef = useRef(false)
  const activeRequestRef = useRef<VerificationRequest | null>(null)
  const attemptedTokensRef = useRef(new Set<string>())
  const currentRouteRef = useRef({ locationKey: location.key, token })
  const [identitySwitchRequired, setIdentitySwitchRequired] = useState(isAuthenticated)
  const [identitySwitchConfirmed, setIdentitySwitchConfirmed] = useState(false)
  const [isSwitchingIdentity, setIsSwitchingIdentity] = useState(false)
  const [identitySwitchError, setIdentitySwitchError] = useState<string | null>(null)

  if (isAuthenticated && !identitySwitchRequired) setIdentitySwitchRequired(true)

  useLayoutEffect(() => {
    currentRouteRef.current = { locationKey: location.key, token }
  }, [location.key, token])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (!hasToken) return
    if (isInitializing || isAuthenticated) return
    if (identitySwitchRequired && !identitySwitchConfirmed) return
    if (attemptedTokensRef.current.has(token)) return
    attemptedTokensRef.current.add(token)

    const request: VerificationRequest = {
      locationKey: location.key,
      token,
    }
    activeRequestRef.current = request
    setVerification({
      locationKey: request.locationKey,
      state: 'verifying',
      message: 'Verifying your email...',
      token: request.token,
    })

    const ownsCurrentPage = () => {
      const currentRoute = currentRouteRef.current
      return mountedRef.current
        && activeRequestRef.current === request
        && currentRoute.locationKey === request.locationKey
        && currentRoute.token === request.token
    }

    verifyEmail({ token })
      .then((res) => {
        if (!ownsCurrentPage()) return
        if (!identitySwitchConfirmed && useAuthStore.getState().authStatus === 'authenticated') {
          setVerification({
            locationKey: request.locationKey,
            state: 'verified-current-session-unchanged',
            message: 'Your email is verified, but your current signed-in session was not changed. Sign out, then sign in with the verified account.',
            token: request.token,
          })
          consumeDeepLinkHandoff(handoffId)
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
          locationKey: request.locationKey,
          state: 'verified',
          message: 'Your email is verified. Taking you to Dupert...',
          token: request.token,
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
        if (!ownsCurrentPage()) return
        setVerification({
          locationKey: request.locationKey,
          state: 'error',
          message:
            parseApiError(err).topMessage ??
            'This verification link is invalid or expired.',
          token: request.token,
        })
        clearDeepLinkHandoff(handoffId)
      })
  }, [handoffId, hasToken, identitySwitchConfirmed, identitySwitchRequired, isAuthenticated, isInitializing, location.key, navigate, queryClient, returnTo, setSession, token])

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

  const keepCurrentSession = () => {
    consumeDeepLinkHandoff(handoffId)
    requestDeepLinkRouteFocus('/trips')
    navigate('/trips', { replace: true })
  }

  const signInWithVerifiedAccount = async () => {
    if (isSwitchingIdentity) return
    setIsSwitchingIdentity(true)
    setIdentitySwitchError(null)
    try {
      await logout()
      navigate('/login', { replace: true })
    } catch {
      setIdentitySwitchError('Could not sign out. Your current session was not changed.')
    } finally {
      setIsSwitchingIdentity(false)
    }
  }

  const currentVerification = verification.locationKey === location.key && verification.token === token
    ? verification
    : {
        locationKey: location.key,
        state: 'verifying' as const,
        message: 'Verifying your email...',
        token,
      }
  const state = hasToken ? currentVerification.state : 'error'
  const message = hasToken
    ? isInitializing
      ? 'Checking your current session...'
      : currentVerification.message
    : 'This verification link is invalid or expired.'
  const verificationFinishedWithCurrentSession = state === 'verified-current-session-unchanged'
  const needsIdentitySwitch = hasToken
    && !isInitializing
    && identitySwitchRequired
    && !identitySwitchConfirmed
    && !verificationFinishedWithCurrentSession

  return (
    <main id="main" className={styles.shell}>
      <div className={`${styles.card} ${styles.resultCard}`}>
        <h1 className={styles.title}>
          {state === 'verified' || verificationFinishedWithCurrentSession ? 'Email verified' : 'Verify email'}
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
        {verificationFinishedWithCurrentSession ? (
          <div className={styles.form}>
            {identitySwitchError ? (
              <div className={styles.banner} role="alert">{identitySwitchError}</div>
            ) : null}
            <button className={styles.submit} type="button" disabled={isSwitchingIdentity} onClick={() => void signInWithVerifiedAccount()}>
              {isSwitchingIdentity ? 'Signing out...' : 'Sign out and sign in with the verified account'}
            </button>
            <button className={styles.textButton} type="button" disabled={isSwitchingIdentity} onClick={keepCurrentSession}>
              Keep current session
            </button>
          </div>
        ) : null}
        {needsIdentitySwitch ? (
          <div className={styles.form}>
            <button className={styles.submit} type="button" disabled={isSwitchingIdentity} onClick={() => void confirmIdentitySwitch()}>
              {isSwitchingIdentity ? 'Signing out...' : 'Sign out and verify this email'}
            </button>
            <button className={styles.textButton} type="button" disabled={isSwitchingIdentity} onClick={keepCurrentSession}>
              Keep current session
            </button>
          </div>
        ) : null}
        {isAuthenticated && !needsIdentitySwitch && state === 'error' ? (
          <button className={styles.textButton} type="button" onClick={keepCurrentSession}>
            Return to trips
          </button>
        ) : null}
        {!isAuthenticated && !needsIdentitySwitch && state === 'error' ? (
          <p className={styles.altLink}>
            <Link to="/login">Back to sign in</Link>
          </p>
        ) : null}
      </div>
    </main>
  )
}

export default EmailVerificationPage
