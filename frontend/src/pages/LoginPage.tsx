import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { AuthBootstrapShell } from '../auth/AuthBootstrapShell'
import { useIsAuthenticated } from '../auth/authStore'
import { apiErrorCode, parseApiError, type ParsedApiError } from '../api/errors'
import { listTrips } from '../api/trips'
import { tripKeys } from '../hooks/useTrips'
import { safeReturnPath } from '../auth/safeReturnPath'
import { usePageTitle } from '../utils/usePageTitle'
import styles from './AuthForm.module.css'

type LoginMode = 'signIn' | 'passwordReset'

export function LoginPage() {
  usePageTitle('Sign in – Dupert')

  const auth = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [searchParams] = useSearchParams()
  const { isInitializing } = auth
  const isAuthenticated = useIsAuthenticated()
  const rawReturn = searchParams.get('return')
  const returnTo = safeReturnPath(rawReturn)
  const verificationReturnPath = rawReturn ? returnTo : undefined
  const registerHref = `/register?return=${encodeURIComponent(rawReturn ?? '')}`

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errorInfo, setErrorInfo] = useState<ParsedApiError | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [mode, setMode] = useState<LoginMode>(() => searchParams.get('mode') === 'password-reset' ? 'passwordReset' : 'signIn')
  const [resetEmail, setResetEmail] = useState('')
  const [resetMessage, setResetMessage] = useState<string | null>(null)
  const [resetError, setResetError] = useState<string | null>(null)
  const [isResetSubmitting, setIsResetSubmitting] = useState(false)
  const [unverifiedEmail, setUnverifiedEmail] = useState<string | null>(null)
  const [resendMessage, setResendMessage] = useState<string | null>(null)
  const [resendError, setResendError] = useState<string | null>(null)
  const [isResendingVerification, setIsResendingVerification] = useState(false)

  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const shouldFocusEmailOnReturnRef = useRef(false)

  const emailId = useId()
  const passwordId = useId()
  const resetEmailId = useId()
  const emailErrorId = `${emailId}-error`
  const passwordErrorId = `${passwordId}-error`

  useEffect(() => {
    if (mode !== 'signIn' || !shouldFocusEmailOnReturnRef.current) return
    shouldFocusEmailOnReturnRef.current = false
    emailRef.current?.focus()
  }, [mode])

  // Withhold the redirect while the silent-refresh probe is in-flight,
  // otherwise a user with a valid refresh cookie sees a brief flash of
  // the login form before being bounced to /trips.
  if (isInitializing) return <AuthBootstrapShell />
  if (isAuthenticated) {
    return <Navigate to={returnTo} replace />
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSubmitting) return
    setIsSubmitting(true)
    setErrorInfo(null)
    setFieldErrors({})
    setUnverifiedEmail(null)
    setResendMessage(null)
    setResendError(null)
    try {
      await auth.login({ email, password })
      void queryClient.prefetchQuery({
        queryKey: tripKeys.lists(),
        queryFn: listTrips,
      })
      navigate(returnTo, { replace: true })
    } catch (err) {
      const parsed = parseApiError(err)
      setErrorInfo(parsed)
      setFieldErrors(parsed.fieldErrors)
      if (apiErrorCode(err) === 'email_unverified') {
        setUnverifiedEmail(email)
      }
      setIsSubmitting(false)
      // Move focus to the first field that the server flagged so an SR
      // user lands on the offending input immediately.
      if (parsed.fieldErrors.email) {
        emailRef.current?.focus()
      } else if (parsed.fieldErrors.password) {
        passwordRef.current?.focus()
      }
    }
  }

  async function onResetSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isResetSubmitting) return
    setIsResetSubmitting(true)
    setResetError(null)
    setResetMessage(null)
    try {
      await auth.requestPasswordReset({ email: resetEmail })
      setResetMessage('If that account exists, a reset email is on the way.')
    } catch (err) {
      setResetError(parseApiError(err).topMessage)
    } finally {
      setIsResetSubmitting(false)
    }
  }

  async function onResendVerification() {
    if (!unverifiedEmail || isResendingVerification) return
    setIsResendingVerification(true)
    setResendMessage(null)
    setResendError(null)
    try {
      await auth.resendEmailVerification({
        email: unverifiedEmail,
        returnPath: verificationReturnPath,
      })
      setResendMessage(
        'If that account is still waiting, a verification email is on the way.',
      )
    } catch (err) {
      setResendError(parseApiError(err).topMessage)
    } finally {
      setIsResendingVerification(false)
    }
  }

  function returnToSignIn() {
    shouldFocusEmailOnReturnRef.current = true
    setMode('signIn')
    setResetError(null)
    setResetMessage(null)
  }

  const topMessage = errorInfo?.topMessage ?? null
  const isWarning = errorInfo?.severity === 'warning'
  const bannerClass = isWarning ? styles.bannerWarning : styles.banner
  const bannerIcon = '!'
  const isPasswordResetMode = mode === 'passwordReset'

  return (
    <main id="main" className={styles.shell}>
      <div className={styles.card}>
        <h1 className={styles.title}>
          {isPasswordResetMode ? 'Reset password' : 'Sign in'}
        </h1>
        <p className={styles.subtitle}>
          {isPasswordResetMode
            ? 'Enter your email and we will send a reset link.'
            : 'Welcome back to Dupert.'}
        </p>

        {!isPasswordResetMode && topMessage ? (
          <div className={bannerClass} role="alert">
            <span className={styles.bannerIcon} aria-hidden="true">
              {bannerIcon}
            </span>
            <span>{topMessage}</span>
          </div>
        ) : null}
        {!isPasswordResetMode && resendMessage ? (
          <div className={styles.bannerSuccess} role="status">
            {resendMessage}
          </div>
        ) : null}
        {!isPasswordResetMode && resendError ? (
          <div className={styles.banner} role="alert">
            <span className={styles.bannerIcon} aria-hidden="true">
              {bannerIcon}
            </span>
            <span>{resendError}</span>
          </div>
        ) : null}
        {isPasswordResetMode && resetMessage ? (
          <div className={styles.bannerSuccess} role="status">
            {resetMessage}
          </div>
        ) : null}
        {isPasswordResetMode && resetError ? (
          <div className={styles.banner} role="alert">
            <span className={styles.bannerIcon} aria-hidden="true">
              {bannerIcon}
            </span>
            <span>{resetError}</span>
          </div>
        ) : null}

        {isPasswordResetMode ? (
          <form
            key="password-reset"
            className={styles.form}
            onSubmit={onResetSubmit}
            noValidate
          >
            <label className={styles.field}>
              <span className={styles.label}>Email</span>
              <input
                id={resetEmailId}
                className={styles.input}
                type="email"
                autoComplete="email"
                required
                value={resetEmail}
                onChange={(event) => setResetEmail(event.target.value)}
                disabled={isResetSubmitting}
              />
            </label>
            <button
              className={styles.submit}
              type="submit"
              disabled={isResetSubmitting || !resetEmail.trim()}
            >
              {isResetSubmitting ? 'Sending…' : 'Send reset email'}
            </button>
            <button
              type="button"
              className={styles.textButton}
              onClick={returnToSignIn}
            >
              Back to sign in
            </button>
          </form>
        ) : (
          <form
            key="sign-in"
            className={styles.form}
            onSubmit={onSubmit}
            noValidate
          >
            <div className={styles.field}>
              <label className={styles.label} htmlFor={emailId}>
                Email
              </label>
              <input
                id={emailId}
                ref={emailRef}
                className={styles.input}
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isSubmitting}
                aria-invalid={fieldErrors.email ? true : undefined}
                aria-describedby={emailErrorId}
              />
              <span
                id={emailErrorId}
                className={styles.fieldError}
                aria-live="polite"
                aria-atomic="true"
              >
                {fieldErrors.email ?? ''}
              </span>
            </div>

            <div className={styles.field}>
              <label className={styles.label} htmlFor={passwordId}>
                Password
              </label>
              <input
                id={passwordId}
                ref={passwordRef}
                className={styles.input}
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isSubmitting}
                aria-invalid={fieldErrors.password ? true : undefined}
                aria-describedby={passwordErrorId}
              />
              <span
                id={passwordErrorId}
                className={styles.fieldError}
                aria-live="polite"
                aria-atomic="true"
              >
                {fieldErrors.password ?? ''}
              </span>
            </div>

            <button
              className={styles.submit}
              type="submit"
              disabled={isSubmitting}
            >
              {isSubmitting && (
                <span className={styles.spinner} aria-hidden="true" />
              )}
              {isSubmitting ? 'Signing in…' : 'Sign in'}
            </button>
            {unverifiedEmail ? (
              <button
                type="button"
                className={styles.textButton}
                onClick={onResendVerification}
                disabled={isResendingVerification}
              >
                {isResendingVerification
                  ? 'Sending…'
                  : 'Resend verification email'}
              </button>
            ) : null}
            <button
              type="button"
              className={styles.textButton}
              onClick={() => {
                setMode('passwordReset')
                setResetEmail(email)
                setErrorInfo(null)
                setFieldErrors({})
                setUnverifiedEmail(null)
                setResendMessage(null)
                setResendError(null)
                setResetError(null)
                setResetMessage(null)
              }}
            >
              Forgot password?
            </button>
          </form>
        )}

        {!isPasswordResetMode ? (
          <p className={styles.altLink}>
            Don&apos;t have an account? <Link to={registerHref}>Create account</Link>
          </p>
        ) : null}
      </div>
    </main>
  )
}

export default LoginPage
