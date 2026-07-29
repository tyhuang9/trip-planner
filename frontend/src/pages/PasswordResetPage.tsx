import { useEffect, useId, useState, type FormEvent } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { confirmPasswordReset } from '../api/auth'
import { parseApiError } from '../api/errors'
import { usePageTitle } from '../utils/usePageTitle'
import { consumeDeepLinkHandoff, getDeepLinkHandoff } from '../deep-links/vault'
import styles from './AuthForm.module.css'

export default function PasswordResetPage() {
  usePageTitle('Reset password - Dupert')

  const [searchParams, setSearchParams] = useSearchParams()
  const { handoffId } = useParams()
  const [token] = useState(() => {
    const handoff = getDeepLinkHandoff(handoffId)
    return handoff?.kind === 'reset-password'
      ? handoff.token
      : searchParams.get('token') ?? searchParams.get('code') ?? ''
  })
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const passwordId = useId()
  const confirmPasswordId = useId()
  const passwordMismatchId = useId()
  const hasResetToken = token.trim().length > 0
  const hasPasswordMismatch = errorMessage === 'New passwords do not match.'

  useEffect(() => {
    if (!searchParams.has('token') && !searchParams.has('code')) return
    const nextParams = new URLSearchParams(searchParams)
    nextParams.delete('token')
    nextParams.delete('code')
    setSearchParams(nextParams, { replace: true })
  }, [searchParams, setSearchParams])

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (isSubmitting) return
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
    setIsSubmitting(true)
    try {
      await confirmPasswordReset({ token, password })
      consumeDeepLinkHandoff(handoffId)
      setSuccessMessage('Password reset complete. You can sign in now.')
      setPassword('')
      setConfirmPassword('')
    } catch (error) {
      setErrorMessage(parseApiError(error).topMessage)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <main id="main" className={styles.shell}>
      <div className={styles.card}>
        <h1 className={styles.title}>Reset password</h1>
        <p className={styles.subtitle}>Choose a new password for your account.</p>

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

        {hasResetToken ? <form className={styles.form} onSubmit={onSubmit} noValidate>
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
          <button className={styles.submit} type="submit" disabled={isSubmitting || !hasResetToken}>
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
