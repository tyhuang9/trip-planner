import { useEffect, useId, useRef, type RefObject } from 'react'
import styles from './ConfirmDialog.module.css'

interface ConfirmDialogProps {
  title: string
  description: string
  confirmLabel: string
  confirmingLabel?: string
  cancelLabel?: string
  confirming?: boolean
  errorMessage?: string | null
  modalFocusBranch?: boolean
  restoreFocusFallbackRef?: RefObject<HTMLElement | null>
  onCancel: () => void
  onConfirm: () => void
}

export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  confirmingLabel = 'Deleting...',
  cancelLabel = 'Cancel',
  confirming = false,
  errorMessage,
  modalFocusBranch = false,
  restoreFocusFallbackRef,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const titleId = useId()
  const descriptionId = useId()
  const cancelButtonRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const onCancelRef = useRef(onCancel)

  useEffect(() => {
    onCancelRef.current = onCancel
  }, [onCancel])

  useEffect(() => {
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    const restoreFocusFallback = restoreFocusFallbackRef?.current

    const focusTimer = window.setTimeout(() => {
      cancelButtonRef.current?.focus()
    }, 0)

    return () => {
      window.clearTimeout(focusTimer)
      if (previousFocusRef.current?.isConnected) {
        previousFocusRef.current.focus()
      } else {
        restoreFocusFallback?.focus()
      }
    }
  }, [restoreFocusFallbackRef])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Tab' && confirming) {
        event.preventDefault()
        dialogRef.current?.focus()
        return
      }
      if (event.key !== 'Escape') return
      event.preventDefault()
      if (confirming) return
      onCancelRef.current()
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [confirming])

  useEffect(() => {
    if (confirming) {
      dialogRef.current?.focus()
    } else if (document.activeElement === dialogRef.current) {
      cancelButtonRef.current?.focus()
    }
  }, [confirming])

  return (
    <div
      className={styles.backdrop}
      data-modal-focus-branch={modalFocusBranch ? 'true' : undefined}
      onMouseDown={(event) => {
        if (!confirming && event.target === event.currentTarget) {
          onCancel()
        }
      }}
    >
      <section
        ref={dialogRef}
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <div className={styles.body}>
          <h2 id={titleId}>{title}</h2>
          <p id={descriptionId}>{description}</p>
          {errorMessage ? (
            <p className={styles.error} role="alert">
              {errorMessage}
            </p>
          ) : null}
          <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
            {confirming ? `${confirmingLabel} Please wait.` : ''}
          </p>
        </div>
        <div className={styles.actions} aria-busy={confirming ? 'true' : undefined}>
          <button
            ref={cancelButtonRef}
            type="button"
            className={styles.cancelButton}
            onClick={onCancel}
            disabled={confirming}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={styles.destructiveButton}
            onClick={onConfirm}
            disabled={confirming}
          >
            {confirming ? confirmingLabel : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  )
}
