import {
  useCallback,
  useRef,
  useState,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
} from 'react'
import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from '@dnd-kit/core'
import {
  BedDouble,
  Coffee,
  GripVertical,
  Landmark,
  MapPin,
  Plane,
  Utensils,
  X,
} from 'lucide-react'
import { ActivityForm, type ActivityFormHandle } from './ActivityForm'
import { ConfirmDialog } from './ConfirmDialog'
import type { Activity, CreateActivityRequest } from '../types/activity'
import styles from './ActivityCard.module.css'

interface ActivityCardProps {
  activity: Activity
  busy?: boolean
  dragDisabled?: boolean
  dragActivatorRef?: (node: HTMLElement | null) => void
  dragAttributes?: DraggableAttributes
  dragListeners?: DraggableSyntheticListeners
  domId?: string
  expanded?: boolean
  mobileDragHandle?: boolean
  presentation?: boolean
  readOnly?: boolean
  active?: boolean
  onActiveChange?: (activityId: number | null) => void
  onDelete: (activityId: number) => void
  onRequestMapLocation?: (activity: Activity, payload: CreateActivityRequest) => void
  onMoveToDay?: (activity: Activity, anchor: HTMLElement) => void
  onScheduleForSelectedDay?: (activity: Activity, anchor: HTMLElement) => void
  onSubmitEdit: (activity: Activity, payload: CreateActivityRequest) => Promise<void> | void
  onToggleExpand: (activity: Activity) => void
}

function formatClockTime(value: string): string {
  const [hourPart, minutePart = '00'] = value.split(':')
  const hour = Number(hourPart)
  const minute = Number(minutePart)
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    return value
  }
  const period = hour >= 12 ? 'PM' : 'AM'
  const hour12 = hour % 12 || 12
  return `${hour12}:${String(minute).padStart(2, '0')} ${period}`
}

function getTimeDisplay(activity: Activity): { dateTime?: string; label: string } | null {
  if (activity.startTime && activity.endTime) {
    return {
      dateTime: activity.startTime,
      label: `${formatClockTime(activity.startTime)}-${formatClockTime(activity.endTime)}`,
    }
  }
  if (activity.startTime) {
    return { dateTime: activity.startTime, label: formatClockTime(activity.startTime) }
  }
  if (activity.endTime) return { label: `Ends ${formatClockTime(activity.endTime)}` }
  return null
}

function getCategoryLabel(category: Activity['category']): string {
  switch (category) {
    case 'ACTIVITY':
      return 'Plan'
    case 'LODGING':
      return 'Stay'
    case 'MEAL':
      return 'Meal'
    case 'SNACK':
      return 'Snack'
    case 'TRANSPORT':
      return 'Move'
    case 'OTHER':
      return 'Other'
  }
}

function isInteractiveTarget(target: EventTarget | null, currentTarget: HTMLElement): boolean {
  if (!(target instanceof Element)) return false
  const interactiveTarget = target.closest(
    'a, button, form, input, label, select, textarea, [role="button"], [role="link"]',
  )
  if (interactiveTarget === currentTarget) return false
  return Boolean(interactiveTarget && currentTarget.contains(interactiveTarget))
}

function ActivityCategoryIcon({ category }: { category: Activity['category'] }) {
  switch (category) {
    case 'ACTIVITY':
      return <Landmark className={styles.categoryIcon} size={18} aria-hidden="true" />
    case 'LODGING':
      return <BedDouble className={styles.categoryIcon} size={18} aria-hidden="true" />
    case 'MEAL':
      return <Utensils className={styles.categoryIcon} size={18} aria-hidden="true" />
    case 'SNACK':
      return <Coffee className={styles.categoryIcon} size={18} aria-hidden="true" />
    case 'TRANSPORT':
      return <Plane className={styles.categoryIcon} size={18} aria-hidden="true" />
    case 'OTHER':
      return <MapPin className={styles.categoryIcon} size={18} aria-hidden="true" />
  }
}

function editInitialValues(activity: Activity): CreateActivityRequest {
  return {
    category: activity.category,
    title: activity.title,
    notes: activity.notes,
    startTime: activity.startTime,
    endTime: activity.endTime,
    placeId: activity.placeId,
    placeName: activity.placeName,
    address: activity.address,
    lat: activity.lat,
    lng: activity.lng,
  }
}

function editFormKey(activity: Activity): string {
  return [
    'activity-edit',
    activity.id,
    activity.placeId ?? '',
    activity.placeName ?? '',
    activity.address ?? '',
    activity.lat ?? '',
    activity.lng ?? '',
  ].join(':')
}

export function ActivityCard({
  activity,
  active = false,
  busy = false,
  dragDisabled = false,
  dragActivatorRef,
  dragAttributes,
  dragListeners,
  domId,
  expanded = false,
  mobileDragHandle = false,
  presentation = false,
  readOnly = false,
  onActiveChange,
  onDelete,
  onRequestMapLocation,
  onMoveToDay,
  onScheduleForSelectedDay,
  onSubmitEdit,
  onToggleExpand,
}: ActivityCardProps) {
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [closePending, setClosePending] = useState(false)
  const activityFormRef = useRef<ActivityFormHandle>(null)
  const cardRef = useRef<HTMLElement | null>(null)
  const timeDisplay = getTimeDisplay(activity)
  const categoryLabel = getCategoryLabel(activity.category)
  const canDrag = !presentation && !readOnly && !busy && !dragDisabled && !expanded
  const usesMobileDragHandle = canDrag && mobileDragHandle
  const cardClassName = [
    styles.card,
    canDrag ? styles.cardDraggable : '',
    active ? styles.cardActive : '',
    expanded ? styles.cardExpanded : '',
    !expanded ? styles.cardCollapsed : '',
  ].filter(Boolean).join(' ')
  const handleDelete = () => {
    setDeleteDialogOpen(true)
  }
  const handleCloseEditor = async (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation()
    if (closePending) return
    setClosePending(true)
    try {
      const saved = await activityFormRef.current?.flushAutosave() ?? true
      if (saved) {
        onToggleExpand(activity)
        window.requestAnimationFrame(() => cardRef.current?.focus({ preventScroll: true }))
      }
    } finally {
      setClosePending(false)
    }
  }
  const setCardRef = useCallback((node: HTMLElement | null) => {
    cardRef.current = node
    if (canDrag && !usesMobileDragHandle) {
      dragActivatorRef?.(node)
    }
  }, [canDrag, dragActivatorRef, usesMobileDragHandle])
  const handleBlurCapture = (event: FocusEvent<HTMLElement>) => {
    if (presentation) return
    const nextTarget = event.relatedTarget
    if (!nextTarget || !event.currentTarget.contains(nextTarget as Node)) {
      onActiveChange?.(null)
    }
  }
  const toggleCard = () => {
    if (presentation) return
    onActiveChange?.(activity.id)
    onToggleExpand(activity)
  }
  const handleClick = (event: MouseEvent<HTMLElement>) => {
    if (isInteractiveTarget(event.target, event.currentTarget)) return
    toggleCard()
  }
  const handlePointerDown = (event: PointerEvent<HTMLElement>) => {
    if (!canDrag || isInteractiveTarget(event.target, event.currentTarget)) return
    dragListeners?.onPointerDown?.(event)
  }
  const quickAction = activity.dayDate === null && onScheduleForSelectedDay
    ? {
        label: 'Schedule',
        onClick: (anchor: HTMLElement) => onScheduleForSelectedDay(activity, anchor),
      }
    : null
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (
      event.defaultPrevented ||
      isInteractiveTarget(event.target, event.currentTarget) ||
      (event.key !== 'Enter' && event.key !== ' ')
    ) {
      return
    }
    if (canDrag) {
      dragListeners?.onKeyDown?.(event)
      if (event.defaultPrevented) return
    }
    event.preventDefault()
    toggleCard()
  }

  return (
    <article
      ref={setCardRef}
      id={domId ?? `activity-${activity.id}`}
      className={cardClassName}
      {...(canDrag && !usesMobileDragHandle ? dragAttributes : undefined)}
      tabIndex={presentation ? -1 : 0}
      aria-hidden={presentation ? true : undefined}
      onClick={presentation ? undefined : handleClick}
      onKeyDown={presentation ? undefined : handleKeyDown}
      onPointerDown={presentation || usesMobileDragHandle ? undefined : handlePointerDown}
      onMouseEnter={presentation ? undefined : () => onActiveChange?.(activity.id)}
      onFocusCapture={presentation ? undefined : () => onActiveChange?.(activity.id)}
      onBlurCapture={presentation ? undefined : handleBlurCapture}
      aria-expanded={expanded}
      aria-label={`${expanded ? 'Collapse' : 'Expand'} ${activity.title}`}
      data-active={active ? 'true' : undefined}
    >
      {(!expanded || readOnly || mobileDragHandle) && (
        <div className={styles.summary}>
          <div className={styles.categoryBlock} data-category={activity.category}>
            <ActivityCategoryIcon category={activity.category} />
            <span className={styles.categoryText}>{categoryLabel}</span>
          </div>

          <div className={styles.content}>
            <div className={styles.summaryHeader}>
              <h3 className={styles.title}>{activity.title}</h3>
              {timeDisplay?.dateTime ? (
                <time className={styles.time} dateTime={timeDisplay.dateTime}>
                  {timeDisplay.label}
                </time>
              ) : timeDisplay ? (
                <span className={styles.time}>{timeDisplay.label}</span>
              ) : null}
            </div>
            {!readOnly && quickAction && (
              <div className={styles.cardQuickActions}>
                <button
                  type="button"
                  className={styles.cardQuickAction}
                  onClick={(event) => {
                    event.stopPropagation()
                    quickAction.onClick(event.currentTarget)
                  }}
                >
                  {quickAction.label}
                </button>
              </div>
            )}
          </div>
          {usesMobileDragHandle ? (
            <div className={styles.mobileCardActions}>
              <button
                ref={dragActivatorRef}
                type="button"
                className={styles.dragHandle}
                {...dragAttributes}
                aria-label={`Reorder ${activity.title}`}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  event.stopPropagation()
                  dragListeners?.onKeyDown?.(event)
                }}
                onPointerDown={(event) => {
                  event.stopPropagation()
                  dragListeners?.onPointerDown?.(event)
                }}
              >
                <GripVertical size={18} aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </div>
      )}

      {expanded && !readOnly && (
        <div className={styles.editorPanel} onClick={(event) => event.stopPropagation()}>
          {mobileDragHandle ? (
            <div className={styles.mobileEditorHeader}>
              <p>Edit activity</p>
              <button
                type="button"
                className={styles.mobileEditorClose}
                aria-label="Close activity editor"
                disabled={closePending}
                onClick={(event) => void handleCloseEditor(event)}
              >
                <X size={20} aria-hidden="true" />
              </button>
            </div>
          ) : null}
          <ActivityForm
            ref={activityFormRef}
            key={editFormKey(activity)}
            initialValues={editInitialValues(activity)}
            onSubmit={(payload) => onSubmitEdit(activity, payload)}
            onDelete={handleDelete}
            onChangeDay={
              mobileDragHandle && onMoveToDay && activity.dayDate !== null
                ? (anchor) => onMoveToDay(activity, anchor)
                : undefined
            }
            onRequestMapLocation={
              onRequestMapLocation
                ? (payload) => onRequestMapLocation(activity, payload)
                : undefined
            }
            submitting={busy}
            autosave
            variant="compact"
            deleteLabel="Delete"
          />
        </div>
      )}

      {deleteDialogOpen && (
        <ConfirmDialog
          title="Delete activity?"
          description={`Delete "${activity.title}"? This cannot be undone.`}
          confirmLabel="Delete activity"
          onCancel={() => setDeleteDialogOpen(false)}
          onConfirm={() => {
            setDeleteDialogOpen(false)
            onDelete(activity.id)
          }}
        />
      )}

      {expanded && readOnly && activity.notes && (
        <p className={styles.readOnlyNotes}>{activity.notes}</p>
      )}

      {expanded && readOnly && (
        <p className={styles.attribution}>
          Updated by {activity.updatedByUserDisplayName || 'guest'}
        </p>
      )}
    </article>
  )
}
