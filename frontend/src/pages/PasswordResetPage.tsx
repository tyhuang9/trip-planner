import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { Link, useLocation, useParams, useSearchParams } from 'react-router'
import { confirmPasswordReset } from '../api/auth'
import { parseApiError } from '../api/errors'
import { usePageTitle } from '../utils/usePageTitle'
import { useDeepLinkHandoffSnapshot } from '../deep-links/useDeepLinkHandoffSnapshot'
import { consumeDeepLinkHandoff } from '../deep-links/vault'
import styles from './AuthForm.module.css'

export default function PasswordResetPage() {
  usePageTitle('Reset password - Dupert')

  const [searchParams, setSearchParams] = useSearchParams()
  const { key: locationKey } = useLocation()
  const { handoffId } = useParams()
  const handoff = useDeepLinkHandoffSnapshot(handoffId)
  const hasRawQueryToken = searchParams.has('token') || searchParams.has('code')
  const rawQueryToken = searchParams.get('token') ?? searchParams.get('code') ?? ''
  const [directSnapshot, setDirectSnapshot] = useState(() => ({
    locationKey,
    owner: 0,
    rawQueryTokenPresent: hasRawQueryToken,
    token: rawQueryToken,
  }))
  let currentDirectSnapshot = directSnapshot
  if (hasRawQueryToken && (
    !directSnapshot.rawQueryTokenPresent
    || directSnapshot.locationKey !== locationKey
    || directSnapshot.token !== rawQueryToken
  )) {
    currentDirectSnapshot = {
      locationKey,
      owner: directSnapshot.owner + 1,
      rawQueryTokenPresent: true,
      token: rawQueryToken,
    }
    setDirectSnapshot(currentDirectSnapshot)
  } else if (!hasRawQueryToken && directSnapshot.rawQueryTokenPresent) {
    currentDirectSnapshot = { ...directSnapshot, locationKey, rawQueryTokenPresent: false }
    setDirectSnapshot(currentDirectSnapshot)
  } else if (!hasRawQueryToken && directSnapshot.locationKey !== locationKey) {
    currentDirectSnapshot = {
      locationKey,
      owner: directSnapshot.owner + 1,
      rawQueryTokenPresent: false,
      token: '',
    }
    setDirectSnapshot(currentDirectSnapshot)
  }
  const token = handoff?.kind === 'reset-password'
    ? handoff.token
    : handoffId
      ? ''
      : currentDirectSnapshot.token
  const resetOwner = handoffId ?? `direct-${currentDirectSnapshot.owner}`
  const [resetOwnerSnapshot, setResetOwnerSnapshot] = useState(() => ({
    isWarmTransition: false,
    owner: resetOwner,
  }))
  let currentResetOwnerSnapshot = resetOwnerSnapshot
  if (resetOwnerSnapshot.owner !== resetOwner) {
    currentResetOwnerSnapshot = { isWarmTransition: true, owner: resetOwner }
    setResetOwnerSnapshot(currentResetOwnerSnapshot)
  }

  useEffect(() => {
    if (!searchParams.has('token') && !searchParams.has('code')) return
    const nextParams = new URLSearchParams(searchParams)
    nextParams.delete('token')
    nextParams.delete('code')
    setSearchParams(nextParams, { replace: true })
  }, [searchParams, setSearchParams])

  return (
    <PasswordResetForm
      key={resetOwner}
      announceOwnerTransition={currentResetOwnerSnapshot.isWarmTransition}
      handoffId={handoffId}
      token={token}
    />
  )
}

function PasswordResetForm({
  announceOwnerTransition,
  handoffId,
  token,
}: {
  announceOwnerTransition: boolean
  handoffId: string | undefined
  token: string
}) {
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const [shouldAnnounceOwnerTransition] = useState(announceOwnerTransition)
  const activeRequest = useRef<object | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const submitButtonRef = useRef<HTMLButtonElement>(null)
  const passwordId = useId()
  const confirmPasswordId = useId()
  const passwordMismatchId = useId()
  const hasResetToken = token.trim().length > 0
  const hasPasswordMismatch = errorMessage === 'New passwords do not match.'

  useEffect(() => {
    let announcementTimer: number | undefined
    if (shouldAnnounceOwnerTransition) {
      headingRef.current?.focus()
      if (hasResetToken) {
        announcementTimer = window.setTimeout(() => {
          setAnnouncement('A new password reset link was opened. Enter your new password.')
        }, 0)
      }
    }
    return () => {
      window.clearTimeout(announcementTimer)
      activeRequest.current = null
    }
  }, [hasResetToken, shouldAnnounceOwnerTransition])

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSubmitting || activeRequest.current) return
    setAnnouncement('')
    setErrorMessage(null)
    setSuccessMessage(null)
    if (!hasResetToken) {
      setErrorMessage('This reset link is missing or invalid. Request a new password reset link.')
      return
    }
    if (password !== confirmPassword) {
      setErrorMessage('New passwords do not match.')
      return
    }
    const request = {}
    activeRequest.current = request
    submitButtonRef.current?.focus()
    setAnnouncement('Resetting password. Please wait.')
    setIsSubmitting(true)
    try {
      await confirmPasswordReset({ token, password })
      if (activeRequest.current !== request) return
      consumeDeepLinkHandoff(handoffId)
      setAnnouncement('')
      setSuccessMessage('Password reset complete. You can sign in now.')
      setPassword('')
      setConfirmPassword('')
    } catch (error) {
      if (activeRequest.current !== request) return
      setAnnouncement('')
      setErrorMessage(parseApiError(error).topMessage)
    } finally {
      if (activeRequest.current === request) {
        activeRequest.current = null
        setIsSubmitting(false)
      }
    }
  }

  return (
    <main id="main" className={styles.shell}>
      <div className={styles.card}>
        <h1 ref={headingRef} className={styles.title} tabIndex={-1}>Reset password</h1>
        <p className={styles.subtitle}>Choose a new password for your account.</p>
        <p
          className="sr-only"
          role="status"
          aria-label="Password reset status"
          aria-live="polite"
          aria-atomic="true"
        >
          {announcement}
        </p>

        {successMessage && (
          <div className={styles.bannerSuccess} role="status">
            {successMessage}
          </div>
        )}
        {!hasResetToken && !successMessage && (
          <div className={styles.banner} role="alert">
            <span className={styles.bannerIcon} aria-hidden="true">
              !
            </span>
            <span>This reset link is missing or invalid. Request a new password reset link.</span>
          </div>
        )}
        {errorMessage && (
          <div id={hasPasswordMismatch ? passwordMismatchId : undefined} className={styles.banner} role="alert">
            <span className={styles.bannerIcon} aria-hidden="true">
              !
            </span>
            <span>{errorMessage}</span>
          </div>
        )}

        {hasResetToken ? <form className={styles.form} aria-label="Password reset" aria-busy={isSubmitting} onSubmit={onSubmit} noValidate>
          <label className={styles.field} htmlFor={passwordId}>
            <span className={styles.label}>New password</span>
            <input
              id={passwordId}
              className={styles.input}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              disabled={isSubmitting}
              aria-invalid={hasPasswordMismatch}
              aria-describedby={hasPasswordMismatch ? passwordMismatchId : undefined}
            />
          </label>
          <label className={styles.field} htmlFor={confirmPasswordId}>
            <span className={styles.label}>Confirm password</span>
            <input
              id={confirmPasswordId}
              className={styles.input}
              type="password"
              autoComplete="new-password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
              disabled={isSubmitting}
              aria-invalid={hasPasswordMismatch}
              aria-describedby={hasPasswordMismatch ? passwordMismatchId : undefined}
            />
          </label>
          <button ref={submitButtonRef} className={styles.submit} type="submit" aria-disabled={isSubmitting}>
            {isSubmitting ? 'Resetting...' : 'Reset password'}
          </button>
        </form> : (
          <p className={styles.altLink}>
            <Link to="/login?mode=password-reset">Request a new password reset link</Link>
          </p>
        )}

        <p className={styles.altLink}>
          <Link to="/login">Back to sign in</Link>
        </p>
      </div>
    </main>
  )
}
