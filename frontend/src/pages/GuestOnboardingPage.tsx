import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { parseApiError } from '../api/errors'
import { useAcceptGuestShareLink } from '../hooks/useShareLinks'
import { usePageTitle } from '../utils/usePageTitle'
import { clearDeepLinkHandoff, getDeepLinkHandoff } from '../deep-links/vault'
import styles from './SharePages.module.css'

export default function GuestOnboardingPage() {
  usePageTitle('Guest access – Dupert')

  const { token: routeToken, handoffId } = useParams()
  const handoff = getDeepLinkHandoff(handoffId)
  const token = handoff?.kind === 'share' || handoff?.kind === 'share-guest'
    ? handoff.token
    : routeToken
  const navigate = useNavigate()
  const acceptMutation = useAcceptGuestShareLink()
  const [displayName, setDisplayName] = useState('')

  const parsedError = acceptMutation.error
    ? parseApiError(acceptMutation.error)
    : null

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!token) return
    const accepted = await acceptMutation.mutateAsync({
      token,
      body: { displayName },
    })
    clearDeepLinkHandoff(handoffId)
    navigate(`/trips/${encodeURIComponent(accepted.publicId)}`, { replace: true })
  }

  return (
    <main id="main" className={styles.narrowShell}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.heading}>Guest access</h1>
          <p className={styles.subheading}>Choose the name shown on this trip.</p>
        </div>
      </header>

      <form className={styles.section} onSubmit={handleSubmit}>
        {parsedError?.topMessage && (
          <p className={styles.banner} role="alert">
            {parsedError.topMessage}
          </p>
        )}
        <label className={styles.field}>
          <span className={styles.label}>Display name</span>
          <input
            className={styles.input}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            aria-invalid={Boolean(parsedError?.fieldErrors.displayName)}
            maxLength={200}
            autoComplete="name"
            required
          />
          {parsedError?.fieldErrors.displayName && (
            <span className={styles.fieldError}>
              {parsedError.fieldErrors.displayName}
            </span>
          )}
        </label>
        <div className={styles.actions}>
          <button
            type="submit"
            className={styles.primaryButton}
            disabled={acceptMutation.isPending || !token}
          >
            {acceptMutation.isPending ? 'Joining...' : 'Join as guest'}
          </button>
          <Link to={handoffId ? `/link/${handoffId}` : `/share/${encodeURIComponent(token ?? '')}`} className={styles.secondaryLink}>
            Back
          </Link>
        </div>
      </form>
    </main>
  )
}
