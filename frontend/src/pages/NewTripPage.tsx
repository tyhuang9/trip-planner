import { useId, useMemo, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { parseApiError, type ParsedApiError } from '../api/errors'
import { GooglePlaceAutocomplete } from '../components/GooglePlaceAutocomplete'
import { TripDateRangePicker } from '../components/TripDateRangePicker'
import type { GooglePlaceSelection } from '../components/googlePlaces'
import { useCreateTrip } from '../hooks/useTrips'
import { usePageTitle } from '../utils/usePageTitle'
import styles from './TripsPage.module.css'

interface FormState {
  name: string
  destination: string
  imageUrl: string
  startDate: string
  endDate: string
}

const EMPTY_FORM: FormState = {
  name: '',
  destination: '',
  imageUrl: '',
  startDate: '',
  endDate: '',
}

const DESTINATION_SEARCH_OPTIONS = {
  language: 'en',
}

function validateForm(form: FormState): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!form.name.trim()) {
    errors.name = 'Trip name is required.'
  }
  if (!form.startDate) {
    errors.startDate = 'Start date is required.'
  }
  if (!form.endDate) {
    errors.endDate = 'End date is required.'
  }
  if (form.startDate && form.endDate && form.startDate > form.endDate) {
    errors.endDate = 'End date must be on or after start date.'
  }
  if (form.imageUrl.trim() && !isHttpsUrl(form.imageUrl)) {
    errors.imageUrl = 'Cover image must be an HTTPS URL.'
  }
  return errors
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value.trim()).protocol === 'https:'
  } catch {
    return false
  }
}

function imageUrlFromPlace(place: GooglePlaceSelection): string | null {
  return place.photoUrl && isHttpsUrl(place.photoUrl) ? place.photoUrl : null
}

export function NewTripPage() {
  usePageTitle('New trip – Dupert')

  const navigate = useNavigate()
  const createTrip = useCreateTrip()
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [apiError, setApiError] = useState<ParsedApiError | null>(null)
  const [destinationSearchError, setDestinationSearchError] = useState<string | null>(null)

  const nameId = useId()
  const destinationId = useId()

  const isSubmitting = createTrip.isPending
  const banner = apiError?.topMessage
  const mergedFieldErrors = useMemo(
    () => ({ ...fieldErrors, ...apiError?.fieldErrors }),
    [apiError?.fieldErrors, fieldErrors],
  )

  function setField(field: keyof FormState, value: string) {
    setForm((current) => ({ ...current, [field]: value }))
    setFieldErrors((current) => {
      const next = { ...current }
      delete next[field]
      return next
    })
    setApiError(null)
  }

  function setFields(fields: Partial<FormState>) {
    setForm((current) => ({ ...current, ...fields }))
    setFieldErrors((current) => {
      const next = { ...current }
      for (const field of Object.keys(fields) as Array<keyof FormState>) {
        delete next[field]
      }
      return next
    })
    setApiError(null)
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const nextErrors = validateForm(form)
    setFieldErrors(nextErrors)
    setApiError(null)
    if (Object.keys(nextErrors).length > 0) {
      return
    }

    try {
      const trip = await createTrip.mutateAsync({
        name: form.name.trim(),
        destination: form.destination.trim() || null,
        imageUrl: form.imageUrl.trim() || null,
        startDate: form.startDate,
        endDate: form.endDate,
      })
      navigate(`/trips/${trip.publicId}`)
    } catch (err) {
      setApiError(parseApiError(err))
    }
  }

  return (
    <main id="main" className={styles.shell}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>New trip</p>
          <h1 className={styles.heading}>Create trip</h1>
        </div>
      </header>

      <form className={styles.form} onSubmit={onSubmit} noValidate>
        {banner ? (
          <div
            className={
              apiError?.severity === 'warning'
                ? styles.bannerWarning
                : styles.banner
            }
            role="alert"
          >
            {banner}
          </div>
        ) : null}

        <div className={styles.field}>
          <label className={styles.label} htmlFor={nameId}>
            Trip name
          </label>
          <input
            id={nameId}
            className={styles.input}
            value={form.name}
            onChange={(event) => setField('name', event.target.value)}
            maxLength={200}
            disabled={isSubmitting}
            aria-invalid={Boolean(mergedFieldErrors.name)}
            aria-describedby={
              mergedFieldErrors.name ? `${nameId}-error` : undefined
            }
          />
          {mergedFieldErrors.name ? (
            <span className={styles.fieldError} id={`${nameId}-error`}>
              {mergedFieldErrors.name}
            </span>
          ) : null}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={destinationId}>
            Destination
          </label>
          <GooglePlaceAutocomplete
            id={destinationId}
            className={styles.destinationSearchBox}
            inputClassName={styles.input}
            inputLabel="Destination"
            value={form.destination}
            onValueChange={(nextValue) => {
              setField('destination', nextValue)
              if (!nextValue) setDestinationSearchError(null)
            }}
            onPlaceSelect={(place) => {
              const destination = place.text
              if (!destination) return
              const imageUrl = imageUrlFromPlace(place)
              setDestinationSearchError(null)
              setFields({
                destination,
                ...(imageUrl ? { imageUrl } : {}),
              })
            }}
            onSearchError={setDestinationSearchError}
            placeholder="Search a city, address, or region"
            maxLength={200}
            disabled={isSubmitting}
            searchFailedMessage="Google Places search failed."
            options={DESTINATION_SEARCH_OPTIONS}
          />
          {destinationSearchError ? (
            <span className={styles.fieldError} role="alert">
              {destinationSearchError}
            </span>
          ) : null}
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor={`${destinationId}-image`}>
            Cover image URL
          </label>
          <input
            id={`${destinationId}-image`}
            className={styles.input}
            type="url"
            inputMode="url"
            value={form.imageUrl}
            onChange={(event) => setField('imageUrl', event.target.value)}
            maxLength={2048}
            disabled={isSubmitting}
            placeholder="https://example.com/photo.jpg"
            aria-invalid={Boolean(mergedFieldErrors.imageUrl)}
            aria-describedby={
              mergedFieldErrors.imageUrl ? `${destinationId}-image-error` : undefined
            }
          />
          {mergedFieldErrors.imageUrl ? (
            <span className={styles.fieldError} id={`${destinationId}-image-error`}>
              {mergedFieldErrors.imageUrl}
            </span>
          ) : null}
        </div>

        <TripDateRangePicker
          disabled={isSubmitting}
          endDate={form.endDate}
          endDateError={mergedFieldErrors.endDate}
          onChange={setFields}
          startDate={form.startDate}
          startDateError={mergedFieldErrors.startDate}
        />

        <div className={styles.formActions}>
          <button
            type="submit"
            className={styles.primaryButton}
            disabled={isSubmitting}
          >
            {isSubmitting ? 'Creating...' : 'Create trip'}
          </button>
          <Link to="/trips" className={styles.secondaryLink}>
            Cancel
          </Link>
        </div>
      </form>
    </main>
  )
}

export default NewTripPage
