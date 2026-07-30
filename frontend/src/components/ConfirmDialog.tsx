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

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onCancelRef.current()
    }

    document.addEventListener('keydown', handleKeyDown)

    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('keydown', handleKeyDown)
      if (previousFocusRef.current?.isConnected) {
        previousFocusRef.current.focus()
      } else {
        restoreFocusFallback?.focus()
      }
    }
  }, [restoreFocusFallbackRef])

  return (
    <div
      className={styles.backdrop}
      data-modal-focus-branch={modalFocusBranch ? 'true' : undefined}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onCancel()
        }
      }}
    >
      <section
        className={styles.dialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <div className={styles.body}>
          <h2 id={titleId}>{title}</h2>
          <p id={descriptionId}>{description}</p>
          {errorMessage ? (
            <p className={styles.error} role="alert">
              {errorMessage}
            </p>
          ) : null}
        </div>
        <div className={styles.actions}>
          <button
            ref={cancelButtonRef}
            type="button"
            className={styles.cancelButton}
            onClick={onCancel}
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
