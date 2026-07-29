import { useState } from 'react'
import { Link, useParams } from 'react-router'
import { parseApiError } from '../api/errors'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { useRemoveTripMember, useTripMembers } from '../hooks/useShareLinks'
import { useTripStream } from '../hooks/useTripStream'
import { useTrip } from '../hooks/useTrips'
import type { TripMember } from '../types/share'
import { usePageTitle } from '../utils/usePageTitle'
import styles from './SharePages.module.css'

export default function MembersPage() {
  const { publicId } = useParams()
  const tripQuery = useTrip(publicId)
  const membersQuery = useTripMembers(publicId)
  const removeMemberMutation = useRemoveTripMember()
  const [memberPendingRemoval, setMemberPendingRemoval] =
    useState<TripMember | null>(null)
  useTripStream(publicId)

  usePageTitle(
    tripQuery.data
      ? `Members for ${tripQuery.data.name} – Dupert`
      : 'Members – Dupert',
  )
  const parsedError = tripQuery.error ? parseApiError(tripQuery.error) : null
  const removalError = removeMemberMutation.error
    ? parseApiError(removeMemberMutation.error).topMessage
    : null

  function requestMemberRemoval(member: TripMember) {
    removeMemberMutation.reset()
    setMemberPendingRemoval(member)
  }

  async function confirmMemberRemoval() {
    if (!publicId || !memberPendingRemoval) return
    try {
      await removeMemberMutation.mutateAsync({
        publicId,
        userId: memberPendingRemoval.userId,
      })
      setMemberPendingRemoval(null)
    } catch {
      // The mutation retains the API error so the confirmation dialog can
      // surface it and let the owner retry without losing context.
    }
  }

  return (
    <main id="main" className={styles.shell}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.heading}>Members</h1>
          <p className={styles.subheading}>
            {tripQuery.data?.name ?? publicId ?? 'Trip'}
          </p>
        </div>
        {publicId && (
          <Link to={`/trips/${encodeURIComponent(publicId)}`} className={styles.secondaryLink}>
            Back to trip
          </Link>
        )}
      </header>

      {parsedError?.topMessage && (
        <p className={styles.banner} role="alert">
          {parsedError.topMessage}
        </p>
      )}

      <section className={styles.section}>
        <h2 className={styles.sectionTitle}>Members</h2>
        {membersQuery.isLoading ? (
          <div className={styles.state} aria-live="polite">
            <p>Loading members...</p>
          </div>
        ) : membersQuery.isError ? (
          <div className={styles.errorState} role="alert">
            <p>{parseApiError(membersQuery.error).topMessage}</p>
            <button
              type="button"
              className={styles.secondaryButton}
              onClick={() => void membersQuery.refetch()}
            >
              Retry members
            </button>
          </div>
        ) : membersQuery.data && membersQuery.data.length > 0 ? (
          <ul className={styles.list}>
            {membersQuery.data.map((member) => (
              <li key={member.userId} className={styles.listItem}>
                <div>
                  <p className={styles.itemTitle}>{member.displayName}</p>
                  <p className={styles.itemMeta}>{member.email}</p>
                </div>
                <div className={styles.memberActions}>
                  <p className={styles.roleBadge}>{member.role.toLowerCase()}</p>
                  {tripQuery.data?.role === 'OWNER' && member.role !== 'OWNER' ? (
                    <button
                      type="button"
                      className={styles.dangerButton}
                      aria-label={`Remove ${member.displayName}`}
                      onClick={() => requestMemberRemoval(member)}
                    >
                      Remove
                    </button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div className={styles.state}>
            <p>No members found.</p>
          </div>
        )}
      </section>

      {memberPendingRemoval ? (
        <ConfirmDialog
          title="Remove member?"
          description={`Remove ${memberPendingRemoval.displayName} from this trip? They will no longer have access.`}
          confirmLabel="Remove member"
          confirmingLabel="Removing..."
          confirming={removeMemberMutation.isPending}
          errorMessage={removalError}
          onCancel={() => {
            removeMemberMutation.reset()
            setMemberPendingRemoval(null)
          }}
          onConfirm={() => void confirmMemberRemoval()}
        />
      ) : null}
    </main>
  )
}
