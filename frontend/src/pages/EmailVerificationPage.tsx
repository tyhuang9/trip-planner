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
import { clearDeepLinkHandoff, getDeepLinkHandoff, putDeepLinkHandoff } from '../deep-links/vault'
import { requestDeepLinkRouteFocus } from '../deep-links/DeepLinkRouteFocus'
import styles from './AuthForm.module.css'

type VerificationState = 'verifying' | 'verified' | 'error'

export function EmailVerificationPage() {
  usePageTitle('Verify email - Dupert')

  const [searchParams] = useSearchParams()
  const { handoffId } = useParams()
  const [handoff] = useState(() => getDeepLinkHandoff(handoffId))
  const navigate = useNavigate()
  const queryClient = useQueryClient()
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

  useEffect(() => {
    if (!hasToken) return
    if (startedRef.current) return
    startedRef.current = true

    verifyEmail({ token })
      .then((res) => {
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
        clearDeepLinkHandoff(handoffId)
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
  }, [handoffId, hasToken, navigate, queryClient, returnTo, setSession, token])

  const state = hasToken ? verification.state : 'error'
  const message = hasToken
    ? verification.message
    : 'This verification link is invalid or expired.'

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
        <div
          className={
            state === 'error'
              ? styles.banner
              : `${styles.bannerSuccess} ${styles.centeredNotice}`
          }
          role={state === 'error' ? 'alert' : 'status'}
        >
          {message}
        </div>
        <p className={styles.altLink}>
          <Link to="/login">Back to sign in</Link>
        </p>
      </div>
    </main>
  )
}

export default EmailVerificationPage
