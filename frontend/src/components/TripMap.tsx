import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import {
  APILoadingStatus,
  Map,
  Polyline,
  useApiLoadingStatus,
  useMap,
  type MapCameraChangedEvent,
  type MapMouseEvent,
} from '@vis.gl/react-google-maps'
import { AlertCircle, LoaderCircle, MapPin, MapPinned, Route } from 'lucide-react'
import { getDrivingDirections, type LatLng } from '../api/googleMapsRoute'
import { geocodeDestination, type DestinationCoordinate } from '../api/googleMapsGeocode'
import type { Activity } from '../types/activity'
import type { PlaceSelection } from '../types/place'
import {
  googleMapsAccessTroubleshooting,
  googleMapsBrowserApiKey,
  googleMapsMapId,
  googleRoutesFailureMessage,
} from '../utils/googleMapsAccess'
import { markPerformance } from '../performance/timing'
import {
  createPlaceDetailsTraceId,
  logPlaceDetailsTiming,
  placeDetailsNowMs,
} from '../utils/placeDetailsTiming'
import { timelineDayColor } from '../utils/timelineDayColors'
import styles from './TripMap.module.css'

export interface TripMapProps {
  activities: Activity[]
  activityMarkerColors?: Record<number, string>
  activityMarkerMode?: 'default' | 'timeline-days'
  fallbackActivities?: Activity[]
  routeActivities?: Activity[]
  destination: string | null
  showDestinationFallback?: boolean
  mapStyle?: MapStyleId
  previewPlace?: MapPreviewPlace | null
  coordinatePreviewPlace?: MapPreviewPlace | null
  searchResults?: MapSearchPlace[]
  selectedSearchResultId?: string | null
  highlightedSearchResultId?: string | null
  activeActivityId?: number | null
  focusedActivityId?: number | null
  focusedActivityKey?: number
  viewportFitKey?: string
  onActivityActivate?: (activityId: number) => void
  onActiveActivityChange?: (activityId: number | null) => void
  onMapPlaceClick?: (event: MapPlaceClickEvent) => void
  onPreviewPlaceClear?: () => void
  onCoordinatePreviewPlaceClear?: () => void
  onSearchResultHoverChange?: (placeId: string | null) => void
  onSearchResultRemove?: (place: MapSearchPlace) => void
  onSearchResultSelect?: (place: MapSearchPlace) => void
  onViewportContextChange?: (context: MapViewportContext) => void
  routeSummaryClassName?: string
  routeSummaryContainer?: HTMLElement | null
  routeSummaryLabel?: string
}

export type MapStyleId = 'roadmap' | 'terrain' | 'satellite' | 'hybrid'

export interface MapViewportContext {
  center: {
    lng: number
    lat: number
  }
  zoom?: number
  bounds?: {
    east: number
    north: number
    south: number
    west: number
  }
}

export interface MapClickedLocation {
  lat: number
  lng: number
}

export interface MapPlaceClickEvent {
  clickedAtIso: string
  clickedAtMs: number
  location: MapClickedLocation | null
  placeName: string | null
  placeId: string | null
  source: 'native-coordinate' | 'native-poi' | 'web'
  traceId: string
}

export type MapPreviewPlace = Pick<
  PlaceSelection,
  | 'address'
  | 'coordinatesLabel'
  | 'featureType'
  | 'lat'
  | 'lng'
  | 'placeCategory'
  | 'placeName'
  | 'title'
>

export type MapSearchPlace = Pick<
  PlaceSelection,
  | 'address'
  | 'coordinatesLabel'
  | 'featureType'
  | 'lat'
  | 'lng'
  | 'placeId'
  | 'placeCategory'
  | 'placeName'
  | 'photoUrl'
  | 'title'
>

interface CoordinateActivity extends Activity {
  lat: number
  lng: number
}

interface DisplayStop {
  id: string
  label: string
  lat: number
  lng: number
  markerLabel: string
  markerColor?: string
  source: 'selected' | 'trip' | 'destination' | 'preview' | 'search'
  title: string
  activityId?: number
  place?: MapSearchPlace
}

interface ActivityMarkerMetadata {
  color?: string
  label: string
}

interface MapCamera {
  center: {
    lat: number
    lng: number
  }
  zoom: number
}

interface RouteLegDisplay {
  fallbackPosition: LatLng
  id: string
  label: string
  path: LatLng[]
}

interface RouteActivityGroup {
  activities: CoordinateActivity[]
  dayDate: string
  key: string
}

interface LoadedDayRoute {
  activities: CoordinateActivity[]
  dayDate: string
  route: NonNullable<Awaited<ReturnType<typeof getDrivingDirections>>>
}

type RouteQueryData = Awaited<ReturnType<typeof getDrivingDirections>>

interface RouteQueryResultSnapshot {
  data: RouteQueryData | undefined
  error: unknown
  isLoading: boolean
  status: 'pending' | 'error' | 'success'
}

interface CombinedRouteQueryResults {
  isLoading: boolean
  results: RouteQueryResultSnapshot[]
}

interface ActiveRouteLeg {
  id: string
  position: LatLng | null
}

const DEFAULT_CAMERA: MapCamera = {
  center: {
    lat: 39.8283,
    lng: -98.5795,
  },
  zoom: 2.7,
}

const ROUTE_STYLE = {
  strokeColor: '#3F5F53',
  strokeOpacity: 0.78,
  strokeWeight: 4,
} as const

const ACTIVE_ROUTE_STYLE = {
  strokeColor: '#4D7265',
  strokeOpacity: 0.95,
  strokeWeight: 6,
} as const

const MAP_ROUTE_STALE_TIME_MS = 60 * 60 * 1000
const MAP_ROUTE_GC_TIME_MS = 60 * 60 * 1000
const MAX_CONCURRENT_ROUTE_REQUESTS = 4
const MIN_ROUTE_REQUEST_START_INTERVAL_MS = 600
// Keep stale timers below the browser/Node timeout ceiling; Query adds 1 ms
// when scheduling stale state, so leave that millisecond of headroom here.
const MAP_GEOCODE_STALE_TIME_MS = 24 * 24 * 60 * 60 * 1000 - 1
const MAP_GEOCODE_GC_TIME_MS = 60 * 60 * 1000

function isFiniteCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function hasCoordinates(activity: Activity): activity is CoordinateActivity {
  return isFiniteCoordinate(activity.lat) && isFiniteCoordinate(activity.lng)
}

class RouteRequestScheduler {
  private activeRequests = 0
  private readonly concurrency: number
  private readonly minimumStartIntervalMs: number
  private nextStartAt = 0
  private readonly waiting: Array<() => void> = []
  private wakeTimer: ReturnType<typeof globalThis.setTimeout> | null = null

  constructor(concurrency: number, minimumStartIntervalMs: number) {
    this.concurrency = concurrency
    this.minimumStartIntervalMs = minimumStartIntervalMs
  }

  async run<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal)
    try {
      return await request()
    } finally {
      this.activeRequests -= 1
      this.scheduleNext()
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new DOMException('The route request was aborted.', 'AbortError'))
    }

    return new Promise((resolve, reject) => {
      const start = () => {
        signal?.removeEventListener('abort', abort)
        if (signal?.aborted) {
          reject(new DOMException('The route request was aborted.', 'AbortError'))
          this.scheduleNext()
          return
        }
        this.activeRequests += 1
        this.nextStartAt = Date.now() + this.minimumStartIntervalMs
        resolve()
        this.scheduleNext()
      }
      const abort = () => {
        const index = this.waiting.indexOf(start)
        if (index >= 0) this.waiting.splice(index, 1)
        reject(new DOMException('The route request was aborted.', 'AbortError'))
        this.scheduleNext()
      }

      signal?.addEventListener('abort', abort, { once: true })
      this.waiting.push(start)
      this.scheduleNext()
    })
  }

  private scheduleNext() {
    if (this.waiting.length === 0) {
      this.clearWakeTimer()
      return
    }
    if (this.activeRequests >= this.concurrency) return

    const waitMs = Math.max(0, this.nextStartAt - Date.now())
    if (waitMs > 0) {
      if (this.wakeTimer === null) {
        this.wakeTimer = globalThis.setTimeout(() => {
          this.wakeTimer = null
          this.scheduleNext()
        }, waitMs)
      }
      return
    }

    const next = this.waiting.shift()
    next?.()
  }

  private clearWakeTimer() {
    if (this.wakeTimer === null) return
    globalThis.clearTimeout(this.wakeTimer)
    this.wakeTimer = null
  }
}

function combineRouteQueryResults(
  results: RouteQueryResultSnapshot[],
): CombinedRouteQueryResults {
  return {
    isLoading: results.some((result) => result.isLoading),
    results: results.map(({ data, error, isLoading, status }) => ({
      data,
      error,
      isLoading,
      status,
    })),
  }
}

function groupRouteActivitiesByDay(activities: Activity[]): RouteActivityGroup[] {
  const groups = new globalThis.Map<string, CoordinateActivity[]>()

  activities.forEach((activity) => {
    if (!hasCoordinates(activity) || activity.dayDate == null) return
    const group = groups.get(activity.dayDate)
    if (group) {
      group.push(activity)
      return
    }
    groups.set(activity.dayDate, [activity])
  })

  return Array.from(groups, ([dayDate, dayActivities]) => {
    const sortedActivities = sortActivitiesByTripOrder(dayActivities)
    return {
      activities: sortedActivities,
      dayDate,
      key: sortedActivities.map((activity) => `${activity.lng},${activity.lat}`).join(';'),
    }
  }).filter((group) => group.activities.length >= 2)
}

function normalizeClickedLocation(
  value: MapMouseEvent['detail']['latLng'],
): MapClickedLocation | null {
  if (!value || !isFiniteCoordinate(value.lat) || !isFiniteCoordinate(value.lng)) {
    return null
  }
  return { lat: value.lat, lng: value.lng }
}

function sortActivitiesByTripOrder(activities: CoordinateActivity[]): CoordinateActivity[] {
  return [...activities].sort((left, right) => {
    const dayCompare = (left.dayDate ?? '\uffff').localeCompare(right.dayDate ?? '\uffff')
    if (dayCompare !== 0) return dayCompare
    return left.orderIndex - right.orderIndex
  })
}

function activityToDisplayStop(
  activity: CoordinateActivity,
  index: number,
  source: 'selected' | 'trip',
  metadata?: ActivityMarkerMetadata,
): DisplayStop {
  return {
    id: `${source}-${activity.id}`,
    label: activity.title,
    lat: activity.lat,
    lng: activity.lng,
    markerLabel: metadata?.label ?? String(index + 1),
    markerColor: metadata?.color,
    source,
    title: activity.title,
    activityId: activity.id,
  }
}

function activityMarkerMetadata(
  activities: CoordinateActivity[],
  mode: 'default' | 'timeline-days',
  colors: Record<number, string> | undefined,
): Map<number, ActivityMarkerMetadata> {
  const metadata = new globalThis.Map<number, ActivityMarkerMetadata>()
  const dayCounters = new globalThis.Map<string, number>()
  const fallbackDayIndexes = new globalThis.Map<string, number>()

  activities.forEach((activity, index) => {
    if (mode !== 'timeline-days') {
      metadata.set(activity.id, { label: String(index + 1), color: colors?.[activity.id] })
      return
    }

    if (activity.dayDate == null) {
      metadata.set(activity.id, { label: '', color: colors?.[activity.id] })
      return
    }

    const count = (dayCounters.get(activity.dayDate) ?? 0) + 1
    dayCounters.set(activity.dayDate, count)

    if (!fallbackDayIndexes.has(activity.dayDate)) {
      fallbackDayIndexes.set(activity.dayDate, fallbackDayIndexes.size)
    }

    metadata.set(activity.id, {
      label: String(count),
      color: colors?.[activity.id] ?? timelineDayColor(fallbackDayIndexes.get(activity.dayDate) ?? 0),
    })
  })

  return metadata
}

function destinationToDisplayStop(destinationCoordinate: DestinationCoordinate): DisplayStop {
  return {
    id: 'destination',
    label: destinationCoordinate.label,
    lat: destinationCoordinate.lat,
    lng: destinationCoordinate.lng,
    markerLabel: 'D',
    source: 'destination',
    title: `Destination: ${destinationCoordinate.label}`,
  }
}

function previewPlaceToDisplayStop(previewPlace: MapPreviewPlace | null | undefined): DisplayStop | null {
  if (
    !previewPlace ||
    !isFiniteCoordinate(previewPlace.lat) ||
    !isFiniteCoordinate(previewPlace.lng)
  ) {
    return null
  }

  const label =
    previewPlace.placeName ||
    previewPlace.title ||
    previewPlace.address ||
    'Search preview'
  return {
    id: `preview-${previewPlace.lng},${previewPlace.lat}`,
    label,
    lat: previewPlace.lat,
    lng: previewPlace.lng,
    markerLabel: '',
    source: 'preview',
    title: `Search preview: ${label}`,
  }
}

function searchPlaceToDisplayStop(place: MapSearchPlace, index: number): DisplayStop | null {
  if (!isFiniteCoordinate(place.lat) || !isFiniteCoordinate(place.lng)) {
    return null
  }

  const label = place.placeName || place.title || place.address || 'Search result'
  return {
    id: `search-${place.placeId ?? index}-${place.lng},${place.lat}`,
    label,
    lat: place.lat,
    lng: place.lng,
    markerLabel: '',
    place,
    source: 'search',
    title: label,
  }
}

function initialCamera(stops: DisplayStop[]): MapCamera {
  if (stops.length === 0) {
    return DEFAULT_CAMERA
  }
  const lat = stops.reduce((sum, stop) => sum + stop.lat, 0) / stops.length
  const lng = stops.reduce((sum, stop) => sum + stop.lng, 0) / stops.length
  return {
    center: { lat, lng },
    zoom: stops.length === 1 ? (stops[0].source === 'destination' ? 9 : 12) : 10,
  }
}

function mapBoundsContainPoint(
  bounds: MapViewportContext['bounds'] | null | undefined,
  point: { lat: number; lng: number },
): boolean {
  if (!bounds) return false
  const insideLatitude = point.lat >= bounds.south && point.lat <= bounds.north
  const insideLongitude =
    bounds.west <= bounds.east
      ? point.lng >= bounds.west && point.lng <= bounds.east
      : point.lng >= bounds.west || point.lng <= bounds.east
  return insideLatitude && insideLongitude
}

function formatTravelTime(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder > 0 ? `${hours} hr ${remainder} min` : `${hours} hr`
}

function routeEventPosition(event: google.maps.MapMouseEvent): LatLng | null {
  const latLng = event.latLng
  if (!latLng) return null
  const lat = typeof latLng.lat === 'function' ? latLng.lat() : latLng.lat
  const lng = typeof latLng.lng === 'function' ? latLng.lng() : latLng.lng
  return isFiniteCoordinate(lat) && isFiniteCoordinate(lng) ? { lat, lng } : null
}

function midpointOfPoints(first: LatLng, second: LatLng): LatLng {
  return {
    lat: (first.lat + second.lat) / 2,
    lng: (first.lng + second.lng) / 2,
  }
}

function midpointOfPath(path: LatLng[]): LatLng | null {
  if (path.length === 0) return null
  const middleIndex = Math.floor(path.length / 2)
  if (path.length % 2 === 1) return path[middleIndex]
  return midpointOfPoints(path[middleIndex - 1], path[middleIndex])
}

const MARKER_PRESS_DEDUPLICATION_MS = 350
const MARKER_TRAILING_CLICK_SUPPRESSION_MS = 750

function GoogleOverlayMarker({
  anchor = 'center',
  children,
  onClick,
  position,
  zIndex,
}: {
  anchor?: 'bottom' | 'center'
  children: ReactNode
  onClick?: () => void
  position: { lat: number; lng: number }
  zIndex?: number
}) {
  const map = useMap('trip-map')
  const onClickRef = useRef(onClick)
  const lastPressActivationAtRef = useRef(0)
  const container = useMemo(() => {
    const element = document.createElement('div')
    element.style.position = 'absolute'
    element.style.transform =
      anchor === 'bottom' ? 'translate(-50%, -100%)' : 'translate(-50%, -50%)'
    element.style.zIndex = String(zIndex ?? 1)
    return element
  }, [anchor, zIndex])

  useEffect(() => {
    onClickRef.current = onClick
  }, [onClick])

  useEffect(() => {
    const activateMarker = (event: Event) => {
      if (!onClickRef.current) return
      const now = Date.now()
      event.preventDefault()
      event.stopPropagation()
      if (now - lastPressActivationAtRef.current < MARKER_PRESS_DEDUPLICATION_MS) {
        return
      }
      lastPressActivationAtRef.current = now
      onClickRef.current()
    }
    const handleClick = (event: MouseEvent) => {
      if (!onClickRef.current) return
      event.preventDefault()
      event.stopPropagation()
      if (
        Date.now() - lastPressActivationAtRef.current <
        MARKER_TRAILING_CLICK_SUPPRESSION_MS
      ) {
        return
      }
      onClickRef.current()
    }

    container.addEventListener('pointerdown', activateMarker)
    container.addEventListener('mousedown', activateMarker)
    container.addEventListener('touchstart', activateMarker)
    container.addEventListener('click', handleClick)

    return () => {
      container.removeEventListener('pointerdown', activateMarker)
      container.removeEventListener('mousedown', activateMarker)
      container.removeEventListener('touchstart', activateMarker)
      container.removeEventListener('click', handleClick)
    }
  }, [container])

  useEffect(() => {
    if (!map) return undefined

    const overlay = new google.maps.OverlayView()
    overlay.onAdd = () => {
      overlay.getPanes()?.overlayMouseTarget.appendChild(container)
      google.maps.OverlayView.preventMapHitsAndGesturesFrom?.(container)
    }
    overlay.draw = () => {
      const projection = overlay.getProjection()
      if (!projection) return
      const point = projection.fromLatLngToDivPixel(position)
      if (!point) return
      container.style.left = `${point.x}px`
      container.style.top = `${point.y}px`
    }
    overlay.onRemove = () => {
      container.remove()
    }
    overlay.setMap(map)

    return () => {
      overlay.setMap(null)
    }
  }, [container, map, position])

  return createPortal(children, container)
}

function TripMapFallback() {
  return (
    <div className={styles.fallback} role="status">
      <span className={styles.fallbackIcon} aria-hidden="true">
        <MapPinned size={24} />
      </span>
      <div>
        <h3>Map unavailable</h3>
        <p>Google Maps API key is not configured for this environment.</p>
        <p className={styles.fallbackHint}>
          Add mapped places now; they will render here when the key is available.
        </p>
      </div>
    </div>
  )
}

export function TripMap(props: TripMapProps) {
  if (!googleMapsBrowserApiKey()) {
    return <TripMapFallback />
  }

  return <TripMapContent {...props} />
}

function TripMapContent({
  activities,
  activityMarkerColors,
  activityMarkerMode = 'default',
  fallbackActivities = [],
  routeActivities = activities,
  activeActivityId = null,
  focusedActivityId = null,
  focusedActivityKey = 0,
  viewportFitKey,
  destination,
  showDestinationFallback = true,
  mapStyle = 'roadmap',
  previewPlace = null,
  coordinatePreviewPlace = null,
  searchResults = [],
  selectedSearchResultId = null,
  highlightedSearchResultId = selectedSearchResultId,
  onActivityActivate,
  onActiveActivityChange,
  onMapPlaceClick,
  onPreviewPlaceClear,
  onCoordinatePreviewPlaceClear,
  onSearchResultHoverChange,
  onSearchResultRemove,
  onSearchResultSelect,
  onViewportContextChange,
  routeSummaryClassName,
  routeSummaryContainer,
  routeSummaryLabel,
}: TripMapProps) {
  const mapId = googleMapsMapId()
  const map = useMap('trip-map')
  const apiLoadingStatus = useApiLoadingStatus()
  const [activeRouteLeg, setActiveRouteLeg] = useState<ActiveRouteLeg | null>(null)
  const lastViewportFitKeyRef = useRef<string | null>(null)
  const selectedMappedActivities = useMemo(
    () =>
      activities
        .filter(hasCoordinates)
        .filter((activity) => activityMarkerMode !== 'timeline-days' || activity.dayDate != null),
    [activities, activityMarkerMode],
  )
  const routeActivityGroups = useMemo(
    () => groupRouteActivitiesByDay(routeActivities),
    [routeActivities],
  )
  const routeRequestScheduler = useMemo(
    () => new RouteRequestScheduler(
      MAX_CONCURRENT_ROUTE_REQUESTS,
      MIN_ROUTE_REQUEST_START_INTERVAL_MS,
    ),
    [],
  )
  const fallbackMappedActivities = useMemo(
    () => sortActivitiesByTripOrder(fallbackActivities.filter(hasCoordinates)),
    [fallbackActivities],
  )
  const selectedMarkerMetadata = useMemo(
    () =>
      activityMarkerMetadata(
        selectedMappedActivities,
        activityMarkerMode,
        activityMarkerColors,
      ),
    [activityMarkerColors, activityMarkerMode, selectedMappedActivities],
  )
  const destinationKey =
    showDestinationFallback &&
    selectedMappedActivities.length === 0 &&
    fallbackMappedActivities.length === 0
      ? destination?.trim() ?? ''
      : ''
  const destinationQuery = useQuery({
    queryKey: ['maps', 'geocode', destinationKey],
    queryFn: ({ signal }) => geocodeDestination(destinationKey, signal),
    enabled: Boolean(destinationKey),
    staleTime: MAP_GEOCODE_STALE_TIME_MS,
    gcTime: MAP_GEOCODE_GC_TIME_MS,
    retry: false,
  })
  const destinationCoordinate = destinationQuery.data ?? null
  const previewDisplayStop = useMemo(
    () => previewPlaceToDisplayStop(previewPlace),
    [previewPlace],
  )
  const coordinatePreviewDisplayStop = useMemo(
    () => previewPlaceToDisplayStop(coordinatePreviewPlace),
    [coordinatePreviewPlace],
  )
  const searchDisplayStops = useMemo(
    () =>
      searchResults.flatMap((place, index) => {
        const stop = searchPlaceToDisplayStop(place, index)
        return stop ? [stop] : []
      }),
    [searchResults],
  )
  const selectedSearchDisplayStop = useMemo(
    () =>
      selectedSearchResultId
        ? searchDisplayStops.find((stop) => stop.place?.placeId === selectedSearchResultId) ?? null
        : null,
    [searchDisplayStops, selectedSearchResultId],
  )
  const destinationError = destinationQuery.isError
    ? 'request-failed'
    : destinationQuery.isSuccess && destinationCoordinate === null
      ? 'not-found'
      : null
  const destinationLoading = Boolean(destinationKey) && destinationQuery.isLoading
  const baseDisplayStops = useMemo(() => {
    if (selectedMappedActivities.length > 0) {
      return selectedMappedActivities.map((activity, index) =>
        activityToDisplayStop(
          activity,
          index,
          'selected',
          selectedMarkerMetadata.get(activity.id),
        ),
      )
    }
    if (fallbackMappedActivities.length > 0) {
      return fallbackMappedActivities.map((activity, index) =>
        activityToDisplayStop(activity, index, 'trip'),
      )
    }
    return destinationCoordinate ? [destinationToDisplayStop(destinationCoordinate)] : []
  }, [destinationCoordinate, fallbackMappedActivities, selectedMappedActivities, selectedMarkerMetadata])
  const focusedActivityDisplayStop = useMemo(
    () =>
      focusedActivityId === null
        ? null
        : baseDisplayStops.find((stop) => stop.activityId === focusedActivityId) ?? null,
    [baseDisplayStops, focusedActivityId],
  )
  const displayStops = useMemo(() => {
    const mergedStops = searchDisplayStops.length > 0
      ? [...baseDisplayStops, ...searchDisplayStops]
      : baseDisplayStops
    const previewStops = [previewDisplayStop, coordinatePreviewDisplayStop]
      .filter((stop): stop is DisplayStop => stop !== null)
    if (previewStops.length === 0) return mergedStops

    return previewStops.reduce((stops, previewStop) => {
      const previewAlreadySaved = stops.some(
        (stop) =>
          stop.source !== 'destination' &&
          Math.abs(stop.lat - previewStop.lat) < 0.000001 &&
          Math.abs(stop.lng - previewStop.lng) < 0.000001,
      )
      return previewAlreadySaved ? stops : [...stops, previewStop]
    }, mergedStops)
  }, [baseDisplayStops, coordinatePreviewDisplayStop, previewDisplayStop, searchDisplayStops])
  const camera = useMemo(
    () => initialCamera(baseDisplayStops.length > 0 ? baseDisplayStops : displayStops),
    [baseDisplayStops, displayStops],
  )
  const routeQueryOptions = useMemo(
    () => routeActivityGroups.map((group) => ({
      queryKey: ['maps', 'driving-route', group.dayDate, group.key] as const,
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        routeRequestScheduler.run(
          () => getDrivingDirections(group.activities, signal),
          signal,
        ),
      staleTime: MAP_ROUTE_STALE_TIME_MS,
      gcTime: MAP_ROUTE_GC_TIME_MS,
      retry: false,
    })),
    [routeActivityGroups, routeRequestScheduler],
  )
  const routeQueryState = useQueries({
    queries: routeQueryOptions,
    combine: combineRouteQueryResults,
  })
  const loadedDayRoutes = useMemo(
    () => routeQueryState.results.flatMap<LoadedDayRoute>((query, index) => {
      const group = routeActivityGroups[index]
      return query.data && group
        ? [{ activities: group.activities, dayDate: group.dayDate, route: query.data }]
        : []
    }),
    [routeActivityGroups, routeQueryState.results],
  )
  const routeFailureState = useMemo(
    () => routeQueryState.results.reduce<{
      firstError: unknown
      hasError: boolean
      unavailableCount: number
    }>((state, query) => {
      if (query.status === 'error') {
        return {
          firstError: state.firstError ?? query.error,
          hasError: true,
          unavailableCount: state.unavailableCount + 1,
        }
      }
      if (query.status === 'success' && query.data === null) {
        return {
          ...state,
          unavailableCount: state.unavailableCount + 1,
        }
      }
      return state
    }, { firstError: null, hasError: false, unavailableCount: 0 }),
    [routeQueryState.results],
  )
  const routeError = routeFailureState.hasError
    ? googleRoutesFailureMessage(routeFailureState.firstError)
    : routeFailureState.unavailableCount > 0
      ? `Route unavailable for ${routeFailureState.unavailableCount} ${routeFailureState.unavailableCount === 1 ? 'day' : 'days'}.`
    : null
  const routeLoading = routeQueryState.isLoading
  const mapLoadFailed =
    apiLoadingStatus === APILoadingStatus.FAILED ||
    apiLoadingStatus === APILoadingStatus.AUTH_FAILURE
  const mapNotice = useMemo(() => {
    if (mapLoadFailed) {
      return `Google Maps could not load. ${googleMapsAccessTroubleshooting()}`
    }
    if (selectedMappedActivities.length === 0 && destinationLoading) {
      return 'Finding trip destination...'
    }
    if (
      selectedMappedActivities.length === 0 &&
      destinationKey &&
      destinationError === 'request-failed'
    ) {
      return `Google Maps could not load trip location. ${googleMapsAccessTroubleshooting()}`
    }
    if (
      selectedMappedActivities.length === 0 &&
      destinationKey &&
      destinationError === 'not-found'
    ) {
      return 'Destination could not be mapped. Add a place to start the map.'
    }
    if (routeLoading) return 'Calculating route...'
    if (routeError) return routeError
    return null
  }, [
    destinationError,
    destinationKey,
    destinationLoading,
    mapLoadFailed,
    routeError,
    routeLoading,
    selectedMappedActivities.length,
  ])
  const routePresentation = useMemo(
    () => {
      const routeLegs: RouteLegDisplay[] = []
      const fallbackRoutePaths: Array<{ dayDate: string; path: LatLng[] }> = []
      let distance = 0
      let duration = 0

      loadedDayRoutes.forEach(({ activities: dayActivities, dayDate, route }) => {
        distance += route.distance
        duration += route.duration
        const hasLegPath = route.legs?.some(
          (leg) => Array.isArray(leg?.path) && leg.path.length >= 2,
        ) ?? false
        const legsWithPaths = (route.legs ?? []).flatMap((leg, index) => {
          if (!leg) return []
          const from = dayActivities[index]
          const to = dayActivities[index + 1]
          const legPath = Array.isArray(leg.path) ? leg.path : []
          if (!from || !to || legPath.length < 2) return []
          const fallbackPosition = midpointOfPath(legPath) ?? midpointOfPoints(from, to)
          return [{
            fallbackPosition,
            id: `${dayDate}:${from.id}-${to.id}`,
            label: formatTravelTime(leg.duration),
            path: legPath,
          }]
        })
        routeLegs.push(...legsWithPaths)

        if (!hasLegPath && Array.isArray(route.path) && route.path.length > 0) {
          fallbackRoutePaths.push({ dayDate, path: route.path })
        }
      })

      return {
        fallbackRoutePaths,
        routeLegs,
        routeTotals: { distance, duration },
      }
    },
    [loadedDayRoutes],
  )
  const { fallbackRoutePaths, routeLegs, routeTotals } = routePresentation
  const activeRouteLegMarker = activeRouteLeg
    ? routeLegs.find((leg) => leg.id === activeRouteLeg.id) ?? null
    : null
  const activeRouteLegPosition =
    activeRouteLegMarker ? activeRouteLeg?.position ?? activeRouteLegMarker.fallbackPosition : null
  const baseDisplayKey = useMemo(
    () => baseDisplayStops.map((stop) => `${stop.source}:${stop.lng},${stop.lat}`).join(';'),
    [baseDisplayStops],
  )
  const viewportFitSignature = useMemo(
    () =>
      baseDisplayStops
        .map((stop) => `${stop.source}:${stop.lat.toFixed(6)},${stop.lng.toFixed(6)}`)
        .sort()
        .join(';'),
    [baseDisplayStops],
  )
  const effectiveViewportFitKey = viewportFitKey
    ? `${viewportFitKey}:${viewportFitSignature}`
    : viewportFitSignature
  const previewDisplayKey = previewDisplayStop
    ? `${previewDisplayStop.source}:${previewDisplayStop.lng},${previewDisplayStop.lat}`
    : ''
  const selectedSearchDisplayKey = selectedSearchDisplayStop
    ? `${selectedSearchDisplayStop.source}:${selectedSearchDisplayStop.lng},${selectedSearchDisplayStop.lat}`
    : ''
  const isCoordinatePreviewDisplayStop = useCallback(
    (stop: DisplayStop) =>
      Boolean(
        coordinatePreviewDisplayStop &&
        Math.abs(stop.lat - coordinatePreviewDisplayStop.lat) < 0.000001 &&
        Math.abs(stop.lng - coordinatePreviewDisplayStop.lng) < 0.000001,
      ),
    [coordinatePreviewDisplayStop],
  )
  const previewStopClearHandler = useCallback(
    (stop: DisplayStop) =>
      isCoordinatePreviewDisplayStop(stop)
        ? onCoordinatePreviewPlaceClear
        : onPreviewPlaceClear,
    [isCoordinatePreviewDisplayStop, onCoordinatePreviewPlaceClear, onPreviewPlaceClear],
  )
  const reportViewportContext = useCallback(() => {
    if (!onViewportContextChange) return
    if (!map) return
    const center = map.getCenter()
    if (!center) return
    const bounds = typeof map.getBounds === 'function' ? map.getBounds()?.toJSON() : undefined
    onViewportContextChange({
      center: { lng: center.lng(), lat: center.lat() },
      zoom: map.getZoom(),
      bounds,
    })
  }, [map, onViewportContextChange])
  const mapReadyReportedRef = useRef(false)

  const handleMapClick = useCallback((event: MapMouseEvent) => {
    const clickedAtMs = placeDetailsNowMs()
    const clickedAtIso = new Date().toISOString()
    const traceId = createPlaceDetailsTraceId()
    const placeId = event.detail.placeId?.trim() || null
    const location = normalizeClickedLocation(event.detail.latLng)
    if (!placeId && !location) return
    event.stop()
    logPlaceDetailsTiming('frontend_map_click', {
      clickedAtIso,
      clickedAtMs,
      hasLocation: location !== null,
      hasPlaceId: placeId !== null,
      placeId,
      traceId,
    })
    onMapPlaceClick?.({
      clickedAtIso,
      clickedAtMs,
      location,
      placeId,
      placeName: null,
      source: 'web',
      traceId,
    })
  }, [onMapPlaceClick])

  useEffect(() => {
    if (!map || baseDisplayStops.length === 0 || !baseDisplayKey) return
    if (lastViewportFitKeyRef.current === effectiveViewportFitKey) return
    lastViewportFitKeyRef.current = effectiveViewportFitKey

    if (baseDisplayStops.length === 1) {
      const [stop] = baseDisplayStops
      map.moveCamera({
        center: { lat: stop.lat, lng: stop.lng },
        zoom: stop.source === 'destination' ? 9 : 12,
      })
      window.requestAnimationFrame(reportViewportContext)
      return
    }

    const lngs = baseDisplayStops.map((stop) => stop.lng)
    const lats = baseDisplayStops.map((stop) => stop.lat)
    const minLng = Math.min(...lngs)
    const maxLng = Math.max(...lngs)
    const minLat = Math.min(...lats)
    const maxLat = Math.max(...lats)

    if (minLng === maxLng && minLat === maxLat) {
      map.moveCamera({
        center: { lat: minLat, lng: minLng },
        zoom: 12,
      })
      window.requestAnimationFrame(reportViewportContext)
      return
    }

    map.fitBounds(
      {
        east: maxLng,
        north: maxLat,
        south: minLat,
        west: minLng,
      },
      64,
    )
    window.requestAnimationFrame(reportViewportContext)
  }, [baseDisplayKey, baseDisplayStops, effectiveViewportFitKey, map, reportViewportContext])

  useEffect(() => {
    if (!map || !selectedSearchDisplayStop || !selectedSearchDisplayKey) return

    map.moveCamera({
      center: {
        lat: selectedSearchDisplayStop.lat,
        lng: selectedSearchDisplayStop.lng,
      },
    })
    window.requestAnimationFrame(reportViewportContext)
  }, [map, reportViewportContext, selectedSearchDisplayKey, selectedSearchDisplayStop])

  useEffect(() => {
    if (!map || !previewDisplayStop || !previewDisplayKey) return

    const bounds = typeof map.getBounds === 'function' ? map.getBounds()?.toJSON() : undefined
    if (mapBoundsContainPoint(bounds, previewDisplayStop)) return

    map.moveCamera({
      center: {
        lat: previewDisplayStop.lat,
        lng: previewDisplayStop.lng,
      },
    })
    window.requestAnimationFrame(reportViewportContext)
  }, [map, previewDisplayKey, previewDisplayStop, reportViewportContext])

  useEffect(() => {
    if (!map || !focusedActivityDisplayStop || focusedActivityKey === 0) return

    map.moveCamera({
      center: {
        lat: focusedActivityDisplayStop.lat,
        lng: focusedActivityDisplayStop.lng,
      },
    })
    window.requestAnimationFrame(reportViewportContext)
  }, [focusedActivityDisplayStop, focusedActivityKey, map, reportViewportContext])

  const routeDaySummary = routeActivityGroups.length > 1
    ? loadedDayRoutes.length === routeActivityGroups.length
      ? ` across ${loadedDayRoutes.length} days`
      : ` across ${loadedDayRoutes.length} of ${routeActivityGroups.length} days`
    : ''
  const effectiveRouteSummaryLabel = routeSummaryLabel ?? (
    routeActivityGroups.length > 1 ? 'Visible-days routes' : 'Selected-day route'
  )
  const routeSummary = loadedDayRoutes.length > 0 ? (
    <div className={[styles.routeSummary, routeSummaryClassName].filter(Boolean).join(' ')} aria-live="polite">
      <div className={styles.routeSummaryHeader}>
        <Route size={15} aria-hidden="true" />
        <span>{effectiveRouteSummaryLabel}</span>
      </div>
      <strong>
        {formatTravelTime(routeTotals.duration)} total · {(routeTotals.distance / 1000).toFixed(1)} km
        {routeDaySummary}
      </strong>
    </div>
  ) : null

  return (
    <div className={styles.mapShell}>
      <div
        id="trip-map-focus-target"
        className={styles.mapCanvas}
        role="region"
        tabIndex={-1}
        aria-label={destination ? `Map for ${destination}` : 'Trip map'}
      >
        <Map
          id="trip-map"
          defaultCenter={camera.center}
          defaultZoom={camera.zoom}
          mapId={mapId}
          mapTypeId={mapStyle}
          clickableIcons={Boolean(onMapPlaceClick)}
          disableDefaultUI
          fullscreenControl={false}
          mapTypeControl={false}
          streetViewControl={false}
          zoomControl={false}
          gestureHandling="greedy"
          onTilesLoaded={() => {
            reportViewportContext()
            if (!mapReadyReportedRef.current) {
              mapReadyReportedRef.current = true
              markPerformance('map-ready')
            }
          }}
          onCameraChanged={(event: MapCameraChangedEvent) => {
            onViewportContextChange?.({
              center: {
                lat: event.detail.center.lat,
                lng: event.detail.center.lng,
              },
              zoom: event.detail.zoom,
              bounds: event.detail.bounds,
            })
          }}
          onClick={handleMapClick}
          reuseMaps
          style={{ width: '100%', height: '100%' }}
        >
          {routeLegs.length > 0 ? routeLegs.map((leg) => {
            const isActive = activeRouteLeg?.id === leg.id
            const routeStyle = isActive ? ACTIVE_ROUTE_STYLE : ROUTE_STYLE
            return (
              <Polyline
                clickable
                key={leg.id}
                path={leg.path}
                strokeColor={routeStyle.strokeColor}
                strokeOpacity={routeStyle.strokeOpacity}
                strokeWeight={routeStyle.strokeWeight}
                zIndex={isActive ? 2 : 1}
                onClick={(event) =>
                  setActiveRouteLeg({ id: leg.id, position: routeEventPosition(event) })
                }
                onMouseOver={(event) =>
                  setActiveRouteLeg({ id: leg.id, position: routeEventPosition(event) })
                }
                onMouseOut={() =>
                  setActiveRouteLeg((current) => current?.id === leg.id ? null : current)
                }
              />
            )
          }) : null}
          {fallbackRoutePaths.map((route) => (
            <Polyline
              key={`fallback-${route.dayDate}`}
              path={route.path}
              strokeColor={ROUTE_STYLE.strokeColor}
              strokeOpacity={ROUTE_STYLE.strokeOpacity}
              strokeWeight={ROUTE_STYLE.strokeWeight}
            />
          ))}
          {displayStops.map((stop) => (
            <GoogleOverlayMarker
              anchor="bottom"
              key={stop.id}
              onClick={
                stop.source === 'search' && stop.place
                  ? stop.place.placeId === selectedSearchResultId && onSearchResultRemove
                    ? () => onSearchResultRemove(stop.place as MapSearchPlace)
                    : () => onSearchResultSelect?.(stop.place as MapSearchPlace)
                  : stop.source === 'preview'
                    ? previewStopClearHandler(stop)
                  : stop.activityId !== undefined
                    ? () => onActivityActivate?.(stop.activityId as number)
                    : undefined
              }
              position={{ lat: stop.lat, lng: stop.lng }}
              zIndex={
                activeActivityId === stop.activityId
                  ? 5
                  : stop.source === 'preview' ||
                      (stop.source === 'search' &&
                        stop.place?.placeId === highlightedSearchResultId)
                  ? 4
                  : stop.source === 'search'
                    ? 3
                    : 2
              }
            >
              {stop.source === 'destination' ? (
                <span
                  className={[styles.marker, styles.destinationMarker].join(' ')}
                  role="img"
                  aria-label={stop.title}
                  title={stop.title}
                >
                  <span className={styles.markerGlyph}>
                    <MapPin size={17} aria-hidden="true" />
                  </span>
                </span>
              ) : stop.source === 'preview' && previewStopClearHandler(stop) ? (
                <button
                  type="button"
                  className={[styles.marker, styles.previewMarker].join(' ')}
                  aria-label={`Remove map marker for ${stop.label}`}
                  title={stop.title}
                >
                  <span className={styles.markerGlyph}>
                    <MapPin size={17} aria-hidden="true" />
                  </span>
                </button>
              ) : stop.source === 'preview' ? (
                <span
                  className={[styles.marker, styles.previewMarker].join(' ')}
                  role="img"
                  aria-label={stop.title}
                  title={stop.title}
                >
                  <span className={styles.markerGlyph}>
                    <MapPin size={17} aria-hidden="true" />
                  </span>
                </span>
              ) : stop.source === 'search' && stop.place ? (
                <button
                  type="button"
                  className={[
                    styles.marker,
                    styles.searchMarker,
                    stop.place.placeId === highlightedSearchResultId
                      ? styles.searchMarkerActive
                      : '',
                  ].filter(Boolean).join(' ')}
                  aria-label={
                    stop.place.placeId === selectedSearchResultId && onSearchResultRemove
                      ? `Remove map marker for ${stop.title}`
                      : `Show place details for ${stop.title}`
                  }
                  title={stop.title}
                  onMouseEnter={() =>
                    onSearchResultHoverChange?.(stop.place?.placeId ?? stop.id)
                  }
                  onMouseLeave={() => onSearchResultHoverChange?.(null)}
                  onFocus={() =>
                    onSearchResultHoverChange?.(stop.place?.placeId ?? stop.id)
                  }
                  onBlur={() => onSearchResultHoverChange?.(null)}
                >
                  <span className={styles.markerGlyph}>
                    <MapPin size={17} aria-hidden="true" />
                  </span>
                </button>
              ) : (
                <button
                  type="button"
                  className={[
                    styles.marker,
                    activeActivityId === stop.activityId ? styles.markerActive : '',
                  ].filter(Boolean).join(' ')}
                  style={
                    stop.markerColor
                      ? ({ '--marker-accent': stop.markerColor } as CSSProperties)
                      : undefined
                  }
                  aria-label={
                    stop.markerLabel
                      ? `Show place details for stop ${stop.markerLabel}: ${stop.title}`
                      : `Show place details for ${stop.title}`
                  }
                  title={stop.title}
                  onMouseEnter={() => onActiveActivityChange?.(stop.activityId ?? null)}
                  onMouseLeave={() => onActiveActivityChange?.(null)}
                  onFocus={() => onActiveActivityChange?.(stop.activityId ?? null)}
                  onBlur={() => onActiveActivityChange?.(null)}
                >
                  <span className={styles.markerGlyph}>
                    {stop.markerLabel || <MapPin size={17} aria-hidden="true" />}
                  </span>
                </button>
              )}
            </GoogleOverlayMarker>
          ))}
          {activeRouteLegMarker && activeRouteLegPosition && (
            <GoogleOverlayMarker
              key={activeRouteLegMarker.id}
              position={activeRouteLegPosition}
            >
              <span className={styles.durationMarker}>{activeRouteLegMarker.label}</span>
            </GoogleOverlayMarker>
          )}
        </Map>
      </div>
      {mapNotice && (
        <div className={styles.mapNotice} aria-live="polite">
          {routeLoading || destinationLoading ? (
            <LoaderCircle size={14} aria-hidden="true" />
          ) : (
            <AlertCircle size={14} aria-hidden="true" />
          )}
          {mapNotice}
        </div>
      )}
      {displayStops.length === 0 && !destinationLoading && (
        <div className={styles.emptyMapCard}>
          <MapPinned size={20} aria-hidden="true" />
          <div>
            <strong>Map is ready</strong>
            <span>Add a place with coordinates to pin this trip.</span>
          </div>
        </div>
      )}
      {routeSummaryContainer === undefined
        ? routeSummary
        : routeSummary && routeSummaryContainer
          ? createPortal(routeSummary, routeSummaryContainer)
          : null}
    </div>
  )
}
