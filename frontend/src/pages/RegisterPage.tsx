import { useId, useMemo, useRef, useState, type FormEvent } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { AuthBootstrapShell } from '../auth/AuthBootstrapShell'
import { useIsAuthenticated } from '../auth/authStore'
import { parseApiError, type ParsedApiError } from '../api/errors'
import { safeReturnPath } from '../auth/safeReturnPath'
import { usePageTitle } from '../utils/usePageTitle'
import type { RegisterResponse } from '../types/auth'
import styles from './AuthForm.module.css'

/** Mirrors the spec's "basic something@something.something" expectation. */
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const PASSWORD_HINT = 'At least 12 characters with a letter and a digit.'

interface ClientErrors {
  email?: string
  password?: string
  displayName?: string
}

function validate(input: {
  email: string
  password: string
  displayName: string
}): ClientErrors {
  const errors: ClientErrors = {}

  const email = input.email.trim()
  if (!email) {
    errors.email = 'Email is required.'
  } else if (!EMAIL_REGEX.test(email)) {
    errors.email = 'Enter a valid email address.'
  }

  const password = input.password
  const hasLetter = /[A-Za-z]/.test(password)
  const hasDigit = /\d/.test(password)
  if (password.length < 12) {
    errors.password = 'Password must be at least 12 characters.'
  } else if (password.length > 128) {
    errors.password = 'Password must be 128 characters or fewer.'
  } else if (!hasLetter || !hasDigit) {
    errors.password = 'Password must include a letter and a digit.'
  }

  const displayName = input.displayName.trim()
  if (!displayName) {
    errors.displayName = 'Display name is required.'
  } else if (displayName.length > 50) {
    errors.displayName = 'Display name must be 50 characters or fewer.'
  }

  return errors
}

export function RegisterPage() {
  usePageTitle('Create account – Dupert')

  const auth = useAuth()
  const [searchParams] = useSearchParams()
  const { isInitializing } = auth
  const isAuthenticated = useIsAuthenticated()
  const rawReturn = searchParams.get('return')
  const returnTo = safeReturnPath(rawReturn)
  const verificationReturnPath = rawReturn ? returnTo : undefined
  const loginHref = `/login?return=${encodeURIComponent(rawReturn ?? '')}`

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [touched, setTouched] = useState<{
    email: boolean
    password: boolean
    displayName: boolean
  }>({ email: false, password: false, displayName: false })
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [errorInfo, setErrorInfo] = useState<ParsedApiError | null>(null)
  const [registrationResult, setRegistrationResult] =
    useState<RegisterResponse | null>(null)
  const [resendMessage, setResendMessage] = useState<string | null>(null)
  const [resendError, setResendError] = useState<string | null>(null)
  const [isResendingVerification, setIsResendingVerification] = useState(false)
  // Server-supplied field errors take precedence over client ones for the
  // fields they cover; merged at render time.
  const [serverFieldErrors, setServerFieldErrors] = useState<
    Record<string, string>
  >({})

  const emailRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const displayNameRef = useRef<HTMLInputElement>(null)

  const clientErrors = useMemo(
    () => validate({ email, password, displayName }),
    [email, password, displayName],
  )

  const visibleErrors: Record<string, string> = useMemo(() => {
    const merged: Record<string, string> = {}
    // Show client errors only after the field has been blurred OR a submit
    // has been attempted — keeps the form quiet while the user is still typing.
    if (touched.email || submitAttempted) {
      if (clientErrors.email) merged.email = clientErrors.email
    }
    if (touched.password || submitAttempted) {
      if (clientErrors.password) merged.password = clientErrors.password
    }
    if (touched.displayName || submitAttempted) {
      if (clientErrors.displayName) merged.displayName = clientErrors.displayName
    }
    // Server errors override / fill in.
    return { ...merged, ...serverFieldErrors }
  }, [touched, submitAttempted, clientErrors, serverFieldErrors])

  const emailId = useId()
  const passwordId = useId()
  const displayNameId = useId()
  const passwordHintId = `${passwordId}-hint`
  const emailErrorId = `${emailId}-error`
  const passwordErrorId = `${passwordId}-error`
  const displayNameErrorId = `${displayNameId}-error`

  if (isInitializing) return <AuthBootstrapShell />
  if (isAuthenticated) {
    return <Navigate to={returnTo} replace />
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSubmitting) return
    setSubmitAttempted(true)
    setErrorInfo(null)
    setServerFieldErrors({})
    setRegistrationResult(null)
    setResendMessage(null)
    setResendError(null)

    // Client validation: still let the user submit even if the form looks
    // invalid client-side — the spec says "let the server confirm". We just
    // surface the errors visually and short-circuit the network call when
    // the obvious fixes are still pending, to keep traffic down.
    if (
      clientErrors.email ||
      clientErrors.password ||
      clientErrors.displayName
    ) {
      // Move focus to the first field with a client-side error, in
      // visual top-to-bottom order.
      if (clientErrors.email) {
        emailRef.current?.focus()
      } else if (clientErrors.password) {
        passwordRef.current?.focus()
      } else if (clientErrors.displayName) {
        displayNameRef.current?.focus()
      }
      return
    }

    setIsSubmitting(true)
    try {
      const result = await auth.register({
        email,
        password,
        displayName,
        returnPath: verificationReturnPath,
      })
      setRegistrationResult(result)
      setResendMessage(null)
      setResendError(null)
      setIsSubmitting(false)
    } catch (err) {
      const parsed = parseApiError(err)
      setErrorInfo(parsed)
      setServerFieldErrors(parsed.fieldErrors)
      setIsSubmitting(false)
      // Move focus to the first server-flagged field for SR users.
      if (parsed.fieldErrors.email) {
        emailRef.current?.focus()
      } else if (parsed.fieldErrors.password) {
        passwordRef.current?.focus()
      } else if (parsed.fieldErrors.displayName) {
        displayNameRef.current?.focus()
      }
    }
  }

  const topMessage = errorInfo?.topMessage ?? null
  const isWarning = errorInfo?.severity === 'warning'
  const bannerClass = isWarning ? styles.bannerWarning : styles.banner
  const bannerIcon = '!'

  async function onResendVerification() {
    if (!registrationResult || isResendingVerification) return
    setIsResendingVerification(true)
    setResendMessage(null)
    setResendError(null)
    try {
      await auth.resendEmailVerification({
        email: registrationResult.email,
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

  if (registrationResult) {
    const verificationRequired = registrationResult.status === 'verification_required'
    return (
      <main id="main" className={styles.shell}>
        <div className={`${styles.card} ${styles.resultCard}`}>
          <h1 className={styles.title}>
            {verificationRequired ? 'Check your email' : 'Account created'}
          </h1>
          <p className={styles.subtitle}>
            {verificationRequired
              ? 'Verify your email before signing in to Dupert.'
              : 'Your local account is ready.'}
          </p>
          <div
            className={`${styles.bannerSuccess} ${styles.centeredNotice}`}
            role="status"
          >
            {verificationRequired
              ? `We sent a verification link to ${registrationResult.email}.`
              : `${registrationResult.email} can now sign in.`}
          </div>
          {verificationRequired && resendMessage ? (
            <div
              className={`${styles.bannerSuccess} ${styles.centeredNotice}`}
              role="status"
            >
              {resendMessage}
            </div>
          ) : null}
          {verificationRequired && resendError ? (
            <div className={styles.banner} role="alert">
              <span className={styles.bannerIcon} aria-hidden="true">
                {bannerIcon}
              </span>
              <span>{resendError}</span>
            </div>
          ) : null}
          {verificationRequired ? (
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
          <p className={styles.altLink}>
            <Link to={loginHref}>Back to sign in</Link>
          </p>
        </div>
      </main>
    )
  }

  return (
    <main id="main" className={styles.shell}>
      <div className={styles.card}>
        <h1 className={styles.title}>Create account</h1>
        <p className={styles.subtitle}>Plan trips together with Dupert.</p>

        {topMessage ? (
          <div className={bannerClass} role="alert">
            <span className={styles.bannerIcon} aria-hidden="true">
              {bannerIcon}
            </span>
            <span>{topMessage}</span>
          </div>
        ) : null}

        <form className={styles.form} onSubmit={onSubmit} noValidate>
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
              onBlur={() => setTouched((t) => ({ ...t, email: true }))}
              disabled={isSubmitting}
              aria-invalid={visibleErrors.email ? true : undefined}
              aria-describedby={emailErrorId}
            />
            <span
              id={emailErrorId}
              className={styles.fieldError}
              aria-live="polite"
              aria-atomic="true"
            >
              {visibleErrors.email ?? ''}
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
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, password: true }))}
              disabled={isSubmitting}
              aria-invalid={visibleErrors.password ? true : undefined}
              aria-describedby={
                visibleErrors.password
                  ? `${passwordHintId} ${passwordErrorId}`
                  : passwordHintId
              }
            />
            <span id={passwordHintId} className={styles.hint}>
              {PASSWORD_HINT}
            </span>
            <span
              id={passwordErrorId}
              className={styles.fieldError}
              aria-live="polite"
              aria-atomic="true"
            >
              {visibleErrors.password ?? ''}
            </span>
          </div>

          <div className={styles.field}>
            <label className={styles.label} htmlFor={displayNameId}>
              Display name
            </label>
            <input
              id={displayNameId}
              ref={displayNameRef}
              className={styles.input}
              type="text"
              autoComplete="name"
              required
              maxLength={50}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              onBlur={() => setTouched((t) => ({ ...t, displayName: true }))}
              disabled={isSubmitting}
              aria-invalid={visibleErrors.displayName ? true : undefined}
              aria-describedby={displayNameErrorId}
            />
            <span
              id={displayNameErrorId}
              className={styles.fieldError}
              aria-live="polite"
              aria-atomic="true"
            >
              {visibleErrors.displayName ?? ''}
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
            {isSubmitting ? 'Creating account...' : 'Create account'}
          </button>
        </form>

        <p className={styles.altLink}>
          Already have an account? <Link to={loginHref}>Sign in</Link>
        </p>
      </div>
    </main>
  )
}

export default RegisterPage
