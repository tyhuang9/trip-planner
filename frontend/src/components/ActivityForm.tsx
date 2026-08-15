import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent,
} from 'react'
import {
  BedDouble,
  CalendarDays,
  ChevronDown,
  Coffee,
  FileText,
  Landmark,
  MapPin,
  Plane,
  Trash2,
  Utensils,
} from 'lucide-react'
import type { ActivityCategory, CreateActivityRequest } from '../types/activity'
import styles from './ActivityForm.module.css'

const categories: ActivityCategory[] = [
  'MEAL',
  'LODGING',
  'TRANSPORT',
  'ACTIVITY',
  'SNACK',
  'OTHER',
]

const categoryLabels: Record<ActivityCategory, string> = {
  ACTIVITY: 'Activity',
  LODGING: 'Hotel',
  MEAL: 'Meal',
  OTHER: 'Other',
  SNACK: 'Snack',
  TRANSPORT: 'Transport',
}

interface ActivityFormProps {
  autoFocusTitle?: boolean
  initialValues?: Partial<CreateActivityRequest>
  onSubmit: (payload: CreateActivityRequest) => Promise<void> | void
  onCancel?: () => void
  onDelete?: () => void
  onChangeDay?: (anchor: HTMLElement) => Promise<void> | void
  autosave?: boolean
  submitting: boolean
  deleteLabel?: string
  onRequestMapLocation?: (payload: CreateActivityRequest) => void
  variant?: 'default' | 'compact'
  submitLabel?: string
}

export interface ActivityFormHandle {
  flushAutosave: () => Promise<boolean>
}

type AutosaveState =
  | { status: 'saved' | 'saving' }
  | { status: 'error'; message: string; retryable: boolean }

function emptyToNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function formStateFromInitialValues(initialValues: Partial<CreateActivityRequest> | undefined) {
  return {
    address: initialValues?.address ?? '',
    category: initialValues?.category ?? 'OTHER',
    endTime: initialValues?.endTime ?? '',
    lat: initialValues?.lat ?? null,
    lng: initialValues?.lng ?? null,
    placeId: initialValues?.placeId ?? null,
    notes: initialValues?.notes ?? '',
    placeName: initialValues?.placeName ?? '',
    startTime: initialValues?.startTime ?? '',
    title: initialValues?.title ?? '',
  } satisfies CreateActivityRequest
}

function ActivityCategoryIcon({ category }: { category: ActivityCategory }) {
  switch (category) {
    case 'ACTIVITY':
      return <Landmark size={20} aria-hidden="true" />
    case 'LODGING':
      return <BedDouble size={20} aria-hidden="true" />
    case 'MEAL':
      return <Utensils size={20} aria-hidden="true" />
    case 'SNACK':
      return <Coffee size={20} aria-hidden="true" />
    case 'TRANSPORT':
      return <Plane size={20} aria-hidden="true" />
    case 'OTHER':
      return <MapPin size={20} aria-hidden="true" />
  }
}

export const ActivityForm = forwardRef<ActivityFormHandle, ActivityFormProps>(function ActivityForm({
  autoFocusTitle = false,
  autosave = false,
  initialValues,
  onSubmit,
  onCancel,
  onChangeDay,
  onDelete,
  submitting,
  deleteLabel = 'Delete',
  onRequestMapLocation,
  variant = 'compact',
  submitLabel = 'Save activity',
}, ref) {
  const titleId = useId()
  const timeId = useId()
  const notesId = useId()
  const categoryMenuId = useId()
  const notesPanelId = useId()
  const titleInputRef = useRef<HTMLInputElement>(null)
  const initialFormState = formStateFromInitialValues(initialValues)
  const [category, setCategory] = useState<ActivityCategory>(initialFormState.category)
  const [title, setTitle] = useState(initialFormState.title)
  const [notes, setNotes] = useState(initialFormState.notes ?? '')
  const [startTime, setStartTime] = useState(initialFormState.startTime ?? '')
  const [endTime, setEndTime] = useState(initialFormState.endTime ?? '')
  const [placeName, setPlaceName] = useState(initialFormState.placeName ?? '')
  const [address, setAddress] = useState(initialFormState.address ?? '')
  const [placeId, setPlaceId] = useState<string | null>(initialFormState.placeId ?? null)
  const [lat, setLat] = useState<number | null>(initialFormState.lat ?? null)
  const [lng, setLng] = useState<number | null>(initialFormState.lng ?? null)
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false)
  const [notesOpen, setNotesOpen] = useState(Boolean(initialValues?.notes))
  const [autosaveState, setAutosaveState] = useState<AutosaveState>({ status: 'saved' })
  const [changeDayPending, setChangeDayPending] = useState(false)

  useLayoutEffect(() => {
    if (!autoFocusTitle) return
    titleInputRef.current?.focus({ preventScroll: true })
  }, [autoFocusTitle])

  const reset = () => {
    setCategory('OTHER')
    setTitle('')
    setNotes('')
    setStartTime('')
    setEndTime('')
    setPlaceName('')
    setAddress('')
    setPlaceId(null)
    setLat(null)
    setLng(null)
    setCategoryMenuOpen(false)
    setNotesOpen(false)
  }

  const currentPayload = useMemo(
    (): CreateActivityRequest => ({
      category,
      title: title.trim(),
      notes: emptyToNull(notes),
      startTime: emptyToNull(startTime),
      endTime: emptyToNull(endTime),
      placeId,
      placeName: emptyToNull(placeName),
      address: emptyToNull(address),
      lat,
      lng,
    }),
    [address, category, endTime, lat, lng, placeId, notes, placeName, startTime, title],
  )
  const currentPayloadSignature = useMemo(
    () => JSON.stringify(currentPayload),
    [currentPayload],
  )
  const lastAutosavedSignatureRef = useRef<string | null>(
    autosave ? currentPayloadSignature : null,
  )
  const latestPayloadRef = useRef(currentPayload)
  const latestPayloadSignatureRef = useRef(currentPayloadSignature)
  const onSubmitRef = useRef(onSubmit)
  const autosaveTimeoutRef = useRef<number | null>(null)
  const inFlightAutosaveRef = useRef<{
    signature: string
    promise: Promise<boolean>
  } | null>(null)

  useEffect(() => {
    latestPayloadRef.current = currentPayload
    latestPayloadSignatureRef.current = currentPayloadSignature
    onSubmitRef.current = onSubmit
  }, [currentPayload, currentPayloadSignature, onSubmit])

  const clearAutosaveTimeout = useCallback(() => {
    if (autosaveTimeoutRef.current === null) return
    window.clearTimeout(autosaveTimeoutRef.current)
    autosaveTimeoutRef.current = null
  }, [])

  const persistAutosave = useCallback(async (
    payload: CreateActivityRequest,
    signature: string,
  ): Promise<boolean> => {
    while (true) {
      if (lastAutosavedSignatureRef.current === signature) return true

      const activeSave = inFlightAutosaveRef.current
      if (!activeSave) break
      if (activeSave.signature === signature) return activeSave.promise
      await activeSave.promise
    }

    setAutosaveState({ status: 'saving' })
    const savePromise = (async () => {
      try {
        await Promise.resolve(onSubmitRef.current(payload))
        lastAutosavedSignatureRef.current = signature
        if (latestPayloadSignatureRef.current === signature) {
          setAutosaveState({ status: 'saved' })
        }
        return true
      } catch {
        if (latestPayloadSignatureRef.current === signature) {
          setAutosaveState({
            status: 'error',
            message: 'Couldn\u2019t save changes.',
            retryable: true,
          })
        }
        return false
      }
    })()
    inFlightAutosaveRef.current = { signature, promise: savePromise }
    void savePromise.then(() => {
      if (inFlightAutosaveRef.current?.promise === savePromise) {
        inFlightAutosaveRef.current = null
      }
    })
    return savePromise
  }, [])

  const flushAutosave = useCallback(async (): Promise<boolean> => {
    if (!autosave) return true
    clearAutosaveTimeout()

    while (true) {
      const payload = latestPayloadRef.current
      const signature = latestPayloadSignatureRef.current
      if (!payload.title.trim()) {
        setAutosaveState({
          status: 'error',
          message: 'Activity name is required.',
          retryable: false,
        })
        return false
      }
      if (lastAutosavedSignatureRef.current === signature) {
        setAutosaveState({ status: 'saved' })
        return true
      }

      const saved = await persistAutosave(payload, signature)
      if (latestPayloadSignatureRef.current !== signature) continue
      return saved
    }
  }, [autosave, clearAutosaveTimeout, persistAutosave])

  useImperativeHandle(ref, () => ({ flushAutosave }), [flushAutosave])

  useEffect(() => {
    if (!autosave) return undefined
    clearAutosaveTimeout()
    if (!currentPayload.title.trim()) {
      const statusTimeoutId = window.setTimeout(() => {
        setAutosaveState({
          status: 'error',
          message: 'Activity name is required.',
          retryable: false,
        })
      }, 0)
      return () => window.clearTimeout(statusTimeoutId)
    }
    if (currentPayloadSignature === lastAutosavedSignatureRef.current) {
      const statusTimeoutId = window.setTimeout(() => {
        setAutosaveState({ status: 'saved' })
      }, 0)
      return () => window.clearTimeout(statusTimeoutId)
    }

    const statusTimeoutId = window.setTimeout(() => {
      setAutosaveState({ status: 'saving' })
    }, 0)
    const timeoutId = window.setTimeout(() => {
      if (autosaveTimeoutRef.current === timeoutId) {
        autosaveTimeoutRef.current = null
      }
      void persistAutosave(currentPayload, currentPayloadSignature)
    }, 700)
    autosaveTimeoutRef.current = timeoutId

    return () => {
      window.clearTimeout(statusTimeoutId)
      if (autosaveTimeoutRef.current === timeoutId) {
        window.clearTimeout(timeoutId)
        autosaveTimeoutRef.current = null
      }
    }
  }, [
    autosave,
    clearAutosaveTimeout,
    currentPayload,
    currentPayloadSignature,
    persistAutosave,
  ])

  const locationPrimary = address.trim() || placeName.trim() || 'Location not set'
  const hasLocation = Boolean(placeName.trim() || address.trim())
  const locationDisplay = hasLocation ? locationPrimary : 'No location selected'

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    if (autosave) {
      void flushAutosave()
      return
    }

    const payload = currentPayload

    void Promise.resolve(onSubmit(payload)).then(() => {
      if (!initialValues) {
        reset()
      }
    }).catch(() => undefined)
  }

  const handleChangeDay = (event: MouseEvent<HTMLButtonElement>) => {
    if (!onChangeDay || changeDayPending) return
    const anchor = event.currentTarget
    setChangeDayPending(true)
    void flushAutosave()
      .then((saved) => saved ? Promise.resolve(onChangeDay(anchor)) : undefined)
      .finally(() => setChangeDayPending(false))
  }

  const actions = (
    <div className={`${styles.actions} ${autosave ? styles.autosaveActions : ''}`}>
      {autosave && (
        <div
          className={`${styles.autosaveStatus} ${autosaveState.status === 'error' ? styles.autosaveError : ''}`}
          role={autosaveState.status === 'error' ? 'alert' : 'status'}
          aria-live="polite"
        >
          <span>
            {autosaveState.status === 'saving' ? 'Saving\u2026' : null}
            {autosaveState.status === 'saved' ? 'Saved' : null}
            {autosaveState.status === 'error' ? autosaveState.message : null}
          </span>
          {autosaveState.status === 'error' && autosaveState.retryable ? (
            <button
              type="button"
              className={styles.retryButton}
              onClick={() => void flushAutosave()}
            >
              Retry
            </button>
          ) : null}
        </div>
      )}
      {onDelete && (
        <button
          type="button"
          className={styles.deleteButton}
          onClick={onDelete}
          disabled={submitting}
        >
          {variant === 'compact' && <Trash2 size={14} aria-hidden="true" />}
          {deleteLabel}
        </button>
      )}
      {autosave && onChangeDay && (
        <button
          type="button"
          className={styles.changeDayButton}
          onClick={handleChangeDay}
          disabled={submitting || changeDayPending}
        >
          <CalendarDays size={16} aria-hidden="true" />
          {changeDayPending ? 'Saving\u2026' : 'Change day'}
        </button>
      )}
      {!autosave && onCancel && (
        <button type="button" className={styles.cancelButton} onClick={onCancel}>
          Cancel
        </button>
      )}
      {!autosave && (
        <button type="submit" className={styles.submitButton} disabled={submitting}>
          {submitting ? 'Saving…' : submitLabel}
        </button>
      )}
    </div>
  )

  if (variant === 'compact') {
    return (
      <form className={`${styles.form} ${styles.compactForm}`} onSubmit={handleSubmit}>
        <div className={styles.compactStack}>
          <div className={styles.compactTitleRow}>
            <div className={styles.categoryPicker}>
              <button
                type="button"
                className={styles.compactIcon}
                data-category={category}
                aria-label={`Category: ${categoryLabels[category]}`}
                aria-controls={categoryMenuId}
                aria-expanded={categoryMenuOpen}
                onClick={() => setCategoryMenuOpen((current) => !current)}
              >
                <ActivityCategoryIcon category={category} />
                <ChevronDown size={12} aria-hidden="true" />
              </button>
              {categoryMenuOpen && (
                <div id={categoryMenuId} className={styles.categoryMenu} role="menu">
                  {categories.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={styles.categoryMenuItem}
                      data-selected={category === value ? 'true' : undefined}
                      role="menuitemradio"
                      aria-checked={category === value}
                      onClick={() => {
                        setCategory(value)
                        setCategoryMenuOpen(false)
                      }}
                    >
                      <span className={styles.categoryMenuIcon} data-category={value}>
                        <ActivityCategoryIcon category={value} />
                      </span>
                      {categoryLabels[value]}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <label className={styles.label} htmlFor={titleId}>
              <span className="sr-only">Activity name</span>
              <input
                ref={titleInputRef}
                id={titleId}
                className={`${styles.input} ${styles.compactInput}`}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Name"
                required
              />
            </label>
          </div>

          <label className={styles.label} htmlFor={timeId}>
            <span className="sr-only">Time</span>
            <span className={styles.timeControl}>
              <input
                id={timeId}
                className={`${styles.input} ${styles.compactInput}`}
                type="time"
                value={startTime}
                onChange={(event) => setStartTime(event.target.value)}
              />
            </span>
          </label>
        </div>

        <section className={styles.locationEditor} aria-label="Location">
          <div className={styles.locationText}>
            <p className={styles.locationPrimary}>{locationDisplay}</p>
          </div>
          <div className={styles.locationAction}>
            {onRequestMapLocation && (
              <button
                type="button"
                className={styles.locationMapButton}
                onClick={() => onRequestMapLocation(currentPayload)}
                disabled={submitting}
              >
                {hasLocation ? 'Change on Map' : 'Add on Map'}
              </button>
            )}
          </div>
        </section>

        <div className={styles.notesDisclosure}>
          <button
            type="button"
            className={styles.notesToggle}
            aria-controls={notesPanelId}
            aria-expanded={notesOpen}
            onClick={() => setNotesOpen((current) => !current)}
          >
            <span>
              <FileText size={15} aria-hidden="true" />
              Notes & Details
            </span>
            <ChevronDown size={16} aria-hidden="true" />
          </button>
          {notesOpen && (
            <label id={notesPanelId} className={styles.notesPanel} htmlFor={notesId}>
              <span className="sr-only">Notes</span>
              <textarea
                id={notesId}
                className={`${styles.textarea} ${styles.compactTextarea}`}
                value={notes}
                onChange={(event) => setNotes(event.target.value)}
                placeholder="Reservation details, tickets, confirmation numbers..."
              />
            </label>
          )}
        </div>

        {actions}
      </form>
    )
  }

  return (
    <form className={styles.form} onSubmit={handleSubmit}>
      <div className={styles.fieldGrid}>
        <label className={styles.label}>
          Category
          <select
            className={styles.select}
            value={category}
            onChange={(event) => setCategory(event.target.value as ActivityCategory)}
          >
            {categories.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>

        <label className={styles.label}>
          Title
          <input
            ref={titleInputRef}
            className={styles.input}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Museum visit, lunch, hotel check-in..."
            required
          />
        </label>
      </div>

      <label className={styles.label}>
        Notes
        <textarea
          className={styles.textarea}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          placeholder="Reservation details, tickets, confirmation numbers..."
        />
      </label>

      <div className={styles.fieldGrid}>
        <label className={styles.label}>
          Place
          <input
            className={styles.input}
            value={placeName}
            onChange={(event) => setPlaceName(event.target.value)}
            placeholder="Restaurant, museum, hotel..."
          />
        </label>

        <label className={styles.label}>
          Address
          <input
            className={styles.input}
            value={address}
            onChange={(event) => setAddress(event.target.value)}
            placeholder="Street address or neighborhood..."
          />
        </label>
      </div>

      <div className={styles.fieldGrid}>
        <label className={styles.label}>
          Start time
          <input
            className={styles.input}
            type="time"
            value={startTime}
            onChange={(event) => setStartTime(event.target.value)}
          />
        </label>

        <label className={styles.label}>
          End time
          <input
            className={styles.input}
            type="time"
            value={endTime}
            onChange={(event) => setEndTime(event.target.value)}
          />
        </label>
      </div>

      {actions}
    </form>
  )
})
