import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react'
import { createPortal } from 'react-dom'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import styles from './TripDateRangePicker.module.css'

export interface TripDateRangeFields {
  startDate: string
  endDate: string
}

type DateRangePart = 'start' | 'end'
type DatePickerPlacement = 'above' | 'below'

interface CalendarDay {
  dateKey: string | null
  dayNumber: number | null
}

interface TripDateRangePickerProps {
  disabled?: boolean
  endDate: string
  endDateError?: string
  label?: string
  onChange: (fields: Partial<TripDateRangeFields>) => void
  startDate: string
  startDateError?: string
}

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

const MONTH_FORMATTER = new Intl.DateTimeFormat('en-US', {
  month: 'long',
  timeZone: 'UTC',
  year: 'numeric',
})

const FULL_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'long',
  timeZone: 'UTC',
  weekday: 'long',
  year: 'numeric',
})

const COMPACT_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
  weekday: 'short',
})

function parseDateKey(dateKey: string): Date {
  return new Date(`${dateKey}T00:00:00.000Z`)
}

function dateKeyFromUtc(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function todayDateKey(): string {
  return dateKeyFromUtc(new Date())
}

function getMonthKey(dateKey: string): string {
  return dateKey.slice(0, 7)
}

function monthKeyFromDate(date: Date): string {
  return date.toISOString().slice(0, 7)
}

function shiftMonthKey(monthKey: string, months: number): string {
  const [year, month] = monthKey.split('-').map(Number)
  return monthKeyFromDate(new Date(Date.UTC(year, month - 1 + months, 1)))
}

function formatMonth(monthKey: string): string {
  const [year, month] = monthKey.split('-').map(Number)
  return MONTH_FORMATTER.format(new Date(Date.UTC(year, month - 1, 1)))
}

function formatCompactDate(dateKey: string): string {
  return COMPACT_DATE_FORMATTER.format(parseDateKey(dateKey))
}

function formatFullDate(dateKey: string): string {
  return FULL_DATE_FORMATTER.format(parseDateKey(dateKey))
}

function buildCalendarDays(monthKey: string): CalendarDay[] {
  const [year, month] = monthKey.split('-').map(Number)
  const firstDay = new Date(Date.UTC(year, month - 1, 1))
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const cells: CalendarDay[] = []

  for (let index = 0; index < firstDay.getUTCDay(); index += 1) {
    cells.push({ dateKey: null, dayNumber: null })
  }

  for (let day = 1; day <= daysInMonth; day += 1) {
    cells.push({
      dateKey: dateKeyFromUtc(new Date(Date.UTC(year, month - 1, day))),
      dayNumber: day,
    })
  }

  while (cells.length % 7 !== 0) {
    cells.push({ dateKey: null, dayNumber: null })
  }

  return cells
}

function rangePickerInitialMonth(startDate: string, endDate: string): string {
  return getMonthKey(startDate || endDate || todayDateKey())
}

function dateButtonClasses(dateKey: string, startDate: string, endDate: string): string {
  const isStart = dateKey === startDate
  const isEnd = dateKey === endDate
  const isBetween = Boolean(startDate && endDate && dateKey > startDate && dateKey < endDate)
  return [
    styles.calendarDateButton,
    isBetween ? styles.calendarDateInRange : '',
    isStart && isEnd ? styles.calendarDateSingle : '',
    isStart && !isEnd ? styles.calendarDateStart : '',
    isEnd && !isStart ? styles.calendarDateEnd : '',
  ].filter(Boolean).join(' ')
}

export function TripDateRangePicker({
  disabled = false,
  endDate,
  endDateError,
  label = 'Trip dates',
  onChange,
  startDate,
  startDateError,
}: TripDateRangePickerProps) {
  const dateRangeId = useId()
  const datePickerId = useId()
  const startErrorId = useId()
  const endErrorId = useId()
  const [isOpen, setIsOpen] = useState(false)
  const [activePart, setActivePart] = useState<DateRangePart>('start')
  const fieldRef = useRef<HTMLDivElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const [panelStyle, setPanelStyle] = useState<CSSProperties | null>(null)
  const [panelPlacement, setPanelPlacement] = useState<DatePickerPlacement>('below')
  const [visibleMonth, setVisibleMonth] = useState(() =>
    rangePickerInitialMonth(startDate, endDate),
  )
  const [visibleMonthCount, setVisibleMonthCount] = useState(2)
  const errorIds = [
    startDateError ? startErrorId : '',
    endDateError ? endErrorId : '',
  ].filter(Boolean).join(' ') || undefined

  const updatePanelPosition = useCallback(() => {
    if (typeof window === 'undefined') return
    const field = fieldRef.current
    if (!field) return

    const rect = field.getBoundingClientRect()
    const viewportPadding = 12
    const gap = -1
    const maxWidth = Math.max(0, window.innerWidth - viewportPadding * 2)
    const compact = maxWidth < 680 || window.innerHeight < 640
    const preferredWidth = compact ? 380 : 760
    const width = Math.min(Math.max(rect.width, preferredWidth), maxWidth)
    const preferredHeight = compact ? 392 : 384
    const availableBelow = Math.max(0, window.innerHeight - rect.bottom - viewportPadding - gap)
    const availableAbove = Math.max(0, rect.top - viewportPadding - gap)
    const openAbove = availableBelow < preferredHeight && availableAbove > availableBelow
    setVisibleMonthCount(compact ? 1 : 2)
    setPanelPlacement(openAbove ? 'above' : 'below')
    const left = Math.min(
      Math.max(viewportPadding, rect.left),
      Math.max(viewportPadding, window.innerWidth - width - viewportPadding),
    )
    if (openAbove) {
      // Anchor the bottom edge instead of calculating a top from an estimated
      // height. The single-month mobile calendar is slightly taller than that
      // estimate, which otherwise leaves a gap between the panel and trigger.
      setPanelStyle({
        bottom: window.innerHeight - rect.top + gap,
        left,
        position: 'fixed',
        width,
      })
      return
    }

    const preferredTop = rect.bottom + gap
    const maxTop = Math.max(viewportPadding, window.innerHeight - preferredHeight - viewportPadding)
    const top = Math.min(Math.max(viewportPadding, preferredTop), maxTop)

    setPanelStyle({
      left,
      position: 'fixed',
      top,
      width,
    })
  }, [])

  useLayoutEffect(() => {
    if (!isOpen) return
    updatePanelPosition()
  }, [isOpen, updatePanelPosition, visibleMonth])

  useLayoutEffect(() => {
    if (!isOpen) return
    const initialFocus =
      panelRef.current?.querySelector<HTMLButtonElement>('button[aria-pressed="true"]') ??
      panelRef.current?.querySelector<HTMLButtonElement>('button:not([disabled])')
    initialFocus?.focus({ preventScroll: true })
  }, [isOpen])

  const closePicker = useCallback((restoreTriggerFocus: boolean) => {
    setIsOpen(false)
    if (restoreTriggerFocus) {
      window.requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }))
    }
  }, [])

  useEffect(() => {
    if (!isOpen) return undefined

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (fieldRef.current?.contains(target) || panelRef.current?.contains(target)) return
      closePicker(false)
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        closePicker(true)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown, true)
    document.addEventListener('keydown', handleKeyDown)
    window.addEventListener('resize', updatePanelPosition)
    window.addEventListener('scroll', updatePanelPosition, true)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true)
      document.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('resize', updatePanelPosition)
      window.removeEventListener('scroll', updatePanelPosition, true)
    }
  }, [closePicker, isOpen, updatePanelPosition])

  function openPicker(part: DateRangePart = startDate && !endDate ? 'end' : 'start') {
    if (disabled) return
    setVisibleMonth(rangePickerInitialMonth(startDate, endDate))
    setActivePart(part)
    setIsOpen(true)
  }

  function selectDate(dateKey: string) {
    if (activePart === 'start' || !startDate) {
      onChange({
        startDate: dateKey,
        endDate: '',
      })
      setActivePart('end')
      return
    }

    if (dateKey < startDate) {
      onChange({
        startDate: dateKey,
        endDate: startDate,
      })
      setActivePart('start')
      return
    }

    onChange({ endDate: dateKey })
    setActivePart('start')
  }

  function renderMonth(monthKey: string, monthLabel: string) {
    return (
      <section key={monthKey} className={styles.calendarMonth} aria-label={monthLabel}>
        <h3>{formatMonth(monthKey)}</h3>
        <div className={styles.calendarWeekdays} aria-hidden="true">
          {WEEKDAY_LABELS.map((weekday, index) => (
            <span key={`${weekday}-${index}`}>{weekday}</span>
          ))}
        </div>
        <div className={styles.calendarGrid} role="grid" aria-label={`${formatMonth(monthKey)} dates`}>
          {buildCalendarDays(monthKey).map((cell, index) => {
            if (!cell.dateKey) {
              return <span key={`empty-${index}`} className={styles.calendarDateEmpty} />
            }

            const fullDate = formatFullDate(cell.dateKey)
            return (
              <button
                key={cell.dateKey}
                type="button"
                className={dateButtonClasses(cell.dateKey, startDate, endDate)}
                onClick={() => selectDate(cell.dateKey as string)}
                aria-label={`Choose ${fullDate}`}
                aria-pressed={cell.dateKey === startDate || cell.dateKey === endDate}
              >
                <span className={styles.calendarDateNumber}>{cell.dayNumber}</span>
              </button>
            )
          })}
        </div>
      </section>
    )
  }

  const datePickerPanel = isOpen ? (
    <div
      ref={panelRef}
      className={styles.datePickerPanel}
      data-placement={panelPlacement}
      style={panelStyle ?? undefined}
      role="dialog"
      aria-modal="false"
      aria-labelledby={dateRangeId}
      id={datePickerId}
      data-modal-focus-branch="true"
    >
      <div className={styles.datePickerCalendarArea}>
        <button
          type="button"
          className={[styles.dateNavButton, styles.dateNavButtonPrevious].join(' ')}
          onClick={() => setVisibleMonth((current) => shiftMonthKey(current, -1))}
          aria-label="Previous month"
        >
          <ChevronLeft size={18} aria-hidden="true" />
        </button>

        <div className={styles.datePickerMonths} data-month-count={visibleMonthCount}>
          {Array.from({ length: visibleMonthCount }, (_, index) =>
            renderMonth(
              shiftMonthKey(visibleMonth, index),
              index === 0 ? 'Start month' : 'End month',
            ),
          )}
        </div>

        <button
          type="button"
          className={[styles.dateNavButton, styles.dateNavButtonNext].join(' ')}
          onClick={() => setVisibleMonth((current) => shiftMonthKey(current, 1))}
          aria-label="Next month"
        >
          <ChevronRight size={18} aria-hidden="true" />
        </button>
      </div>

      <div className={styles.datePickerFooter}>
        <button
          type="button"
          className={styles.datePickerDone}
          onClick={() => closePicker(true)}
        >
          Done
        </button>
      </div>
    </div>
  ) : null

  return (
    <div className={styles.dateRangeField} ref={fieldRef}>
      <span className={styles.label} id={dateRangeId}>
        {label}
      </span>
      <button
        ref={triggerRef}
        type="button"
        className={styles.dateRangeTrigger}
        onClick={() => openPicker()}
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={isOpen ? datePickerId : undefined}
        aria-labelledby={dateRangeId}
        aria-describedby={errorIds}
        aria-invalid={Boolean(startDateError || endDateError)}
        data-panel-placement={isOpen ? panelPlacement : undefined}
      >
        <CalendarDays size={18} aria-hidden="true" />
        <span className={styles.dateRangeSummary}>
          <span>
            <span>Start date</span>
            <strong>{startDate ? formatCompactDate(startDate) : 'Select date'}</strong>
          </span>
          <span className={styles.dateRangeDivider} aria-hidden="true" />
          <span>
            <span>End date</span>
            <strong>{endDate ? formatCompactDate(endDate) : 'Select date'}</strong>
          </span>
        </span>
      </button>
      {startDateError ? (
        <span className={styles.fieldError} id={startErrorId}>
          {startDateError}
        </span>
      ) : null}
      {endDateError ? (
        <span className={styles.fieldError} id={endErrorId}>
          {endDateError}
        </span>
      ) : null}

      {datePickerPanel && typeof document !== 'undefined'
        ? createPortal(datePickerPanel, document.body)
        : datePickerPanel}
    </div>
  )
}
