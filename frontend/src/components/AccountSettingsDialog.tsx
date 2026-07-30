import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { Mail, SlidersHorizontal, Trash2, UserRound, X } from 'lucide-react'
import { parseApiError } from '../api/errors'
import { useAuth } from '../auth/useAuth'
import { useColorMode } from '../theme/useColorMode'
import type { UserSummary } from '../types/auth'
import styles from './AccountSettingsDialog.module.css'

interface AccountSettingsDialogProps {
  onClose: () => void
  onDeleted: () => void
  user: UserSummary
}

const DELETE_DIALOG_FOCUSABLE_SELECTOR =
  'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'

export function AccountSettingsDialog({
  onClose,
  onDeleted,
  user,
}: AccountSettingsDialogProps) {
  const auth = useAuth()
  const { colorMode, setColorMode } = useColorMode()
  const [displayName, setDisplayName] = useState(user.displayName)
  const [marketingEmails, setMarketingEmails] = useState(() =>
    window.localStorage.getItem('dupert.marketingEmails') === 'true',
  )
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [deleteConfirmation, setDeleteConfirmation] = useState('')
  const [deletePassword, setDeletePassword] = useState('')
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [deletePasswordInvalid, setDeletePasswordInvalid] = useState(false)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const deleteAccountOpenerRef = useRef<HTMLButtonElement>(null)
  const deleteDialogRef = useRef<HTMLFormElement>(null)
  const deletePasswordRef = useRef<HTMLInputElement>(null)
  const deletingRef = useRef(deleting)

  useEffect(() => {
    deletingRef.current = deleting
  }, [deleting])

  const initials = (displayName || user.email)
    .split(/\s+|@/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('')

  const canDelete =
    deleteConfirmation === 'delete' &&
    deletePassword.trim().length > 0 &&
    deletePassword.length <= 128

  const closeDeleteDialog = useCallback(() => {
    if (deletingRef.current) return
    setShowDeleteDialog(false)
    setDeleteConfirmation('')
    setDeletePassword('')
    setDeleteError(null)
    setDeletePasswordInvalid(false)
    window.setTimeout(() => deleteAccountOpenerRef.current?.focus(), 0)
  }, [])

  useEffect(() => {
    if (!showDeleteDialog) return

    const focusFrame = window.requestAnimationFrame(() => {
      deleteDialogRef.current
        ?.querySelector<HTMLElement>(DELETE_DIALOG_FOCUSABLE_SELECTOR)
        ?.focus()
    })
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      if (event.key === 'Escape') {
        if (deletingRef.current) return
        event.preventDefault()
        closeDeleteDialog()
        return
      }
      if (event.key !== 'Tab') return

      const dialog = deleteDialogRef.current
      if (dialog === null) return
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(DELETE_DIALOG_FOCUSABLE_SELECTOR),
      )
      if (focusable.length === 0) {
        event.preventDefault()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const activeElement = document.activeElement
      if (event.shiftKey && (activeElement === first || !dialog.contains(activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (activeElement === last || !dialog.contains(activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [closeDeleteDialog, showDeleteDialog])

  const handleSettingsSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setSaving(true)
    setErrorMessage(null)
    try {
      await auth.updateProfile({ displayName })
      window.localStorage.setItem('dupert.marketingEmails', String(marketingEmails))
      onClose()
    } catch (error) {
      setErrorMessage(parseApiError(error).topMessage)
    } finally {
      setSaving(false)
    }
  }

  const handleDeleteAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canDelete || deletingRef.current) return
    deletingRef.current = true
    setDeleting(true)
    setDeleteError(null)
    setDeletePasswordInvalid(false)
    try {
      await auth.deleteAccount({ currentPassword: deletePassword })
      onDeleted()
    } catch (error) {
      const parsedError = parseApiError(error)
      setDeleteError(
        parsedError.topMessage ?? 'Account deletion could not be completed.',
      )
      if (parsedError.code === 'reauthentication_failed') {
        setDeletePasswordInvalid(true)
        setDeletePassword('')
        window.setTimeout(() => deletePasswordRef.current?.focus(), 0)
      }
    } finally {
      deletingRef.current = false
      setDeleting(false)
    }
  }

  return (
    <>
      <div
        className={styles.modalBackdrop}
        role="presentation"
        aria-hidden={showDeleteDialog ? true : undefined}
        inert={showDeleteDialog ? true : undefined}
      >
        <section
          className={styles.accountSettingsModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="account-settings-title"
        >
          <header className={styles.modalHeader}>
            <h2 id="account-settings-title">Account settings</h2>
            <button
              type="button"
              className={styles.iconOnlyButton}
              onClick={onClose}
              aria-label="Close account settings"
            >
              <X size={18} aria-hidden="true" />
            </button>
          </header>
          <form className={styles.accountSettingsForm} onSubmit={handleSettingsSubmit}>
            <div className={styles.accountSettingsBody}>
              {statusMessage ? (
                <p className={styles.modalSuccess} role="status">
                  {statusMessage}
                </p>
              ) : null}
              {errorMessage ? (
                <p className={styles.modalError} role="alert">
                  {errorMessage}
                </p>
              ) : null}

              <section className={styles.accountSection} aria-labelledby="account-profile-title">
                <h3 id="account-profile-title">
                  <UserRound size={16} aria-hidden="true" />
                  Profile
                </h3>
                <div className={styles.profilePictureRow}>
                  <div className={styles.profileAvatar} aria-hidden="true">
                    {initials || 'U'}
                  </div>
                  <div>
                    <p>Profile picture</p>
                    <span>JPG, GIF or PNG. Max size of 800K</span>
                  </div>
                </div>
                <label className={styles.modalLabel}>
                  Display name
                  <input
                    className={styles.modalInput}
                    autoComplete="name"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    required
                  />
                </label>
              </section>

              <section className={styles.accountSection} aria-labelledby="account-email-title">
                <h3 id="account-email-title">
                  <Mail size={16} aria-hidden="true" />
                  Email address
                </h3>
                <label className={styles.modalLabel}>
                  Email address
                  <span className={styles.emailInputWrap}>
                    <input
                      className={styles.modalInput}
                      type="email"
                      autoComplete="email"
                      value={user.email}
                      readOnly
                    />
                    <button
                      type="button"
                      className={styles.inlineTextButton}
                      onClick={() => setStatusMessage('Email updates are not available yet.')}
                    >
                      Update
                    </button>
                  </span>
                </label>
                <p className={styles.fieldHelper}>Used for login and notifications</p>
              </section>

              <section className={styles.accountSection} aria-labelledby="account-preferences-title">
                <h3 id="account-preferences-title">
                  <SlidersHorizontal size={16} aria-hidden="true" />
                  Preferences
                </h3>
                <div className={styles.preferenceRow}>
                  <div>
                    <p>Marketing emails</p>
                    <span>Receive travel tips and destination guides</span>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={marketingEmails}
                    className={[
                      styles.switchControl,
                      marketingEmails ? styles.switchControlOn : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => setMarketingEmails((current) => !current)}
                  >
                    <span />
                  </button>
                </div>
                <div className={styles.preferenceRow}>
                  <div>
                    <p>App color mode</p>
                    <span>Choose your preferred appearance</span>
                  </div>
                  <div className={styles.segmentedControl} role="group" aria-label="App color mode">
                    {(['light', 'dark', 'system'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={colorMode === mode ? styles.segmentedControlActive : ''}
                        onClick={() => setColorMode(mode)}
                        aria-pressed={colorMode === mode}
                      >
                        {mode[0].toUpperCase() + mode.slice(1)}
                      </button>
                    ))}
                  </div>
                </div>
              </section>

              <section className={styles.dangerSection} aria-labelledby="account-danger-title">
                <h3 id="account-danger-title">
                  <Trash2 size={16} aria-hidden="true" />
                  Delete account
                </h3>
                <p>
                  This removes your account. Private trips are deleted, and shared trips are
                  transferred to another registered member.
                </p>
                <button
                  ref={deleteAccountOpenerRef}
                  type="button"
                  className={styles.destructiveAction}
                  onClick={() => {
                    setDeleteConfirmation('')
                    setDeletePassword('')
                    setDeleteError(null)
                    setDeletePasswordInvalid(false)
                    setShowDeleteDialog(true)
                  }}
                >
                  Delete account
                </button>
              </section>
            </div>
            <footer className={styles.accountSettingsFooter}>
              <button type="submit" className={styles.primaryAction} disabled={saving}>
                {saving ? 'Saving...' : 'Save changes'}
              </button>
            </footer>
          </form>
        </section>
      </div>

      {showDeleteDialog ? (
        <div className={styles.confirmBackdrop} role="presentation">
          <form
            ref={deleteDialogRef}
            className={styles.confirmDialog}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-account-title"
            aria-describedby="delete-account-description"
            aria-busy={deleting}
            onSubmit={handleDeleteAccount}
          >
            <div className={styles.confirmBody}>
              <h2 id="delete-account-title">Delete account?</h2>
              <p id="delete-account-description">
                Type the exact lowercase word{' '}
                <strong className={styles.confirmationToken}>delete</strong> and enter
                your current password to permanently remove this account.
              </p>
              <label className={styles.modalLabel}>
                Confirmation
                <input
                  className={styles.modalInput}
                  value={deleteConfirmation}
                  onChange={(event) => {
                    setDeleteConfirmation(event.target.value)
                    setDeleteError(null)
                    setDeletePasswordInvalid(false)
                  }}
                  autoComplete="off"
                  disabled={deleting}
                  autoFocus
                  required
                />
              </label>
              <label className={styles.modalLabel}>
                Current password
                <input
                  ref={deletePasswordRef}
                  className={styles.modalInput}
                  type="password"
                  value={deletePassword}
                  onChange={(event) => {
                    setDeletePassword(event.target.value)
                    setDeleteError(null)
                    setDeletePasswordInvalid(false)
                  }}
                  autoComplete="current-password"
                  maxLength={128}
                  disabled={deleting}
                  required
                  aria-invalid={deletePasswordInvalid ? 'true' : undefined}
                  aria-describedby={deletePasswordInvalid ? 'delete-account-error' : undefined}
                />
              </label>
              {deleteError ? (
                <p
                  id="delete-account-error"
                  className={styles.confirmError}
                  role="alert"
                >
                  {deleteError}
                </p>
              ) : null}
            </div>
            <div className={styles.confirmActions}>
              <button
                type="button"
                className={styles.secondaryAction}
                onClick={closeDeleteDialog}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                type="submit"
                className={styles.destructiveAction}
                disabled={!canDelete}
                aria-disabled={deleting ? 'true' : undefined}
                aria-busy={deleting ? 'true' : undefined}
              >
                {deleting ? 'Deleting...' : 'Delete account'}
              </button>
            </div>
          </form>
          <p
            className={styles.visuallyHidden}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {deleting ? 'Deleting your account. Please wait.' : ''}
          </p>
        </div>
      ) : null}
    </>
  )
}
