import { createPortal } from 'react-dom'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { AlertCircle, LoaderCircle, MapPinned, Route } from 'lucide-react'
import { getDrivingDirections, type AppRoute } from '../api/googleMapsRoute'
import { geocodeDestination, type DestinationCoordinate } from '../api/googleMapsGeocode'
import {
  NativeGoogleMap,
  type NativeMapBounds,
  type NativeMapCoordinate,
  type NativeMapMarker,
  type NativeMapType,
} from '../platform/nativeGoogleMapsBridge'
import { platformRuntime } from '../platform/runtime'
import { markPerformance } from '../performance/timing'
import type { Activity } from '../types/activity'
import {
  createPlaceDetailsTraceId,
  logPlaceDetailsTiming,
  placeDetailsNowMs,
} from '../utils/placeDetailsTiming'
import { timelineDayColor } from '../utils/timelineDayColors'
import type {
  MapPreviewPlace,
  MapSearchPlace,
  MapStyleId,
  TripMapProps,
} from './TripMap'
import styles from './TripMapSurface.native.module.css'

interface CoordinateActivity extends Activity {
  lat: number
  lng: number
}

interface DisplayStop {
  activityId?: number
  id: string
  label: string
  lat: number
  lng: number
  markerColor?: string
  markerLabel: string
  place?: MapSearchPlace
  source: 'destination' | 'preview' | 'search' | 'selected' | 'trip'
  title: string
}

interface RouteGroup {
  activities: CoordinateActivity[]
  dayDate: string
  key: string
}

interface LoadedRoute {
  dayDate: string
  route: AppRoute
}

const DEFAULT_CAMERA = { center: { lat: 39.8283, lng: -98.5795 }, zoom: 2.7 }
const ROUTE_STYLE = {
  strokeColor: '#3F5F53',
  strokeOpacity: 0.78,
  strokeWeight: 4,
} as const

function isFiniteCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function hasCoordinates(activity: Activity): activity is CoordinateActivity {
  return isFiniteCoordinate(activity.lat) && isFiniteCoordinate(activity.lng)
}

function sortActivitiesByTripOrder(activities: CoordinateActivity[]): CoordinateActivity[] {
  return [...activities].sort((left, right) => {
    const dayCompare = (left.dayDate ?? '\uffff').localeCompare(right.dayDate ?? '\uffff')
    return dayCompare !== 0 ? dayCompare : left.orderIndex - right.orderIndex
  })
}

function activityMarkerMetadata(
  activities: CoordinateActivity[],
  mode: NonNullable<TripMapProps['activityMarkerMode']>,
  colors: TripMapProps['activityMarkerColors'],
): Map<number, { color?: string; label: string }> {
  const metadata = new Map<number, { color?: string; label: string }>()
  const dayCounters = new Map<string, number>()
  const fallbackDayIndexes = new Map<string, number>()

  activities.forEach((activity, index) => {
    if (mode !== 'timeline-days') {
      metadata.set(activity.id, { color: colors?.[activity.id], label: String(index + 1) })
      return
    }

    if (activity.dayDate === null) {
      metadata.set(activity.id, { color: colors?.[activity.id], label: '' })
      return
    }

    const count = (dayCounters.get(activity.dayDate) ?? 0) + 1
    dayCounters.set(activity.dayDate, count)
    if (!fallbackDayIndexes.has(activity.dayDate)) {
      fallbackDayIndexes.set(activity.dayDate, fallbackDayIndexes.size)
    }
    metadata.set(activity.id, {
      color: colors?.[activity.id] ?? timelineDayColor(fallbackDayIndexes.get(activity.dayDate) ?? 0),
      label: String(count),
    })
  })

  return metadata
}

function activityToDisplayStop(
  activity: CoordinateActivity,
  index: number,
  source: 'selected' | 'trip',
  marker?: { color?: string; label: string },
): DisplayStop {
  return {
    activityId: activity.id,
    id: `${source}-${activity.id}`,
    label: activity.title,
    lat: activity.lat,
    lng: activity.lng,
    markerColor: marker?.color,
    markerLabel: marker?.label ?? String(index + 1),
    source,
    title: activity.title,
  }
}

function destinationToDisplayStop(destination: DestinationCoordinate): DisplayStop {
  return {
    id: 'destination',
    label: destination.label,
    lat: destination.lat,
    lng: destination.lng,
    markerLabel: 'D',
    source: 'destination',
    title: `Destination: ${destination.label}`,
  }
}

function previewPlaceToDisplayStop(place: MapPreviewPlace | null | undefined): DisplayStop | null {
  if (!place || !isFiniteCoordinate(place.lat) || !isFiniteCoordinate(place.lng)) return null
  const label = place.placeName || place.title || place.address || 'Search preview'
  return {
    id: `preview-${place.lng},${place.lat}`,
    label,
    lat: place.lat,
    lng: place.lng,
    markerLabel: '',
    source: 'preview',
    title: `Search preview: ${label}`,
  }
}

function searchPlaceToDisplayStop(place: MapSearchPlace, index: number): DisplayStop | null {
  if (!isFiniteCoordinate(place.lat) || !isFiniteCoordinate(place.lng)) return null
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

function groupRouteActivitiesByDay(activities: Activity[]): RouteGroup[] {
  const groups = new Map<string, CoordinateActivity[]>()
  activities.forEach((activity) => {
    if (!hasCoordinates(activity) || activity.dayDate === null) return
    groups.set(activity.dayDate, [...(groups.get(activity.dayDate) ?? []), activity])
  })

  return Array.from(groups, ([dayDate, activitiesForDay]) => {
    const activities = sortActivitiesByTripOrder(activitiesForDay)
    return {
      activities,
      dayDate,
      key: activities.map((activity) => `${activity.lat},${activity.lng}`).join(';'),
    }
  }).filter((group) => group.activities.length >= 2)
}

function initialCamera(stops: DisplayStop[]) {
  if (stops.length === 0) return DEFAULT_CAMERA
  return {
    center: {
      lat: stops.reduce((total, stop) => total + stop.lat, 0) / stops.length,
      lng: stops.reduce((total, stop) => total + stop.lng, 0) / stops.length,
    },
    zoom: stops.length === 1 ? (stops[0].source === 'destination' ? 9 : 12) : 10,
  }
}

function mapBoundsForStops(stops: DisplayStop[]): NativeMapBounds | null {
  if (stops.length < 2) return null
  const lats = stops.map((stop) => stop.lat)
  const lngs = stops.map((stop) => stop.lng)
  const south = Math.min(...lats)
  const north = Math.max(...lats)
  const west = Math.min(...lngs)
  const east = Math.max(...lngs)
  if (south === north && west === east) return null
  return {
    center: { lat: (south + north) / 2, lng: (west + east) / 2 },
    northeast: { lat: north, lng: east },
    southwest: { lat: south, lng: west },
  }
}

function nativeMapType(mapStyle: MapStyleId): NativeMapType {
  switch (mapStyle) {
    case 'hybrid': return 'Hybrid'
    case 'satellite': return 'Satellite'
    case 'terrain': return 'Terrain'
    default: return 'Normal'
  }
}

function colorToTint(color: string | undefined): NativeMapMarker['tintColor'] | undefined {
  const hex = color?.trim().replace('#', '')
  if (!hex || !/^[0-9a-fA-F]{6}$/.test(hex)) return undefined
  return {
    a: 255,
    b: Number.parseInt(hex.slice(4, 6), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    r: Number.parseInt(hex.slice(0, 2), 16),
  }
}

function markerForStop(stop: DisplayStop, isActive: boolean, isHighlighted: boolean): NativeMapMarker {
  const prefix = stop.markerLabel ? `${stop.markerLabel}. ` : ''
  return {
    coordinate: { lat: stop.lat, lng: stop.lng },
    tintColor: colorToTint(stop.markerColor),
    title: `${prefix}${stop.title}`,
    zIndex: isActive ? 5 : isHighlighted ? 4 : stop.source === 'search' ? 3 : 2,
  }
}

function formatTravelTime(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60))
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  return remainder > 0 ? `${hours} hr ${remainder} min` : `${hours} hr`
}

function coordinateFromNativeEvent(event: { latitude: number; longitude: number }): NativeMapCoordinate | null {
  return isFiniteCoordinate(event.latitude) && isFiniteCoordinate(event.longitude)
    ? { lat: event.latitude, lng: event.longitude }
    : null
}

/**
 * Native-only map renderer backed by the iOS and Android Google Maps SDKs.
 * Browser Maps stays in TripMapSurface.web.tsx and is deliberately absent from
 * this target's bundle.
 */
export function TripMapSurface({
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
  onSearchResultRemove,
  onSearchResultSelect,
  onViewportContextChange,
  routeSummaryClassName,
  routeSummaryContainer,
  routeSummaryLabel,
}: TripMapProps) {
  const elementRef = useRef<HTMLElement | null>(null)
  const mapRef = useRef<NativeGoogleMap | null>(null)
  const markerIdsRef = useRef<string[]>([])
  const polylineIdsRef = useRef<string[]>([])
  const markerActionsRef = useRef(new Map<string, () => void>())
  const callbacksRef = useRef({ onMapPlaceClick, onViewportContextChange })
  const markerRenderRef = useRef(0)
  const routeRenderRef = useRef(0)
  const lastFitKeyRef = useRef<string | null>(null)
  const nativeMapId = `trip-map-native-${useId()}`

  const [map, setMap] = useState<NativeGoogleMap | null>(null)
  const [mapError, setMapError] = useState<string | null>(null)
  const [destinationCoordinate, setDestinationCoordinate] = useState<DestinationCoordinate | null>(null)
  const [destinationStatus, setDestinationStatus] = useState<'idle' | 'loading' | 'error'>('idle')
  const [loadedRoutes, setLoadedRoutes] = useState<LoadedRoute[]>([])
  const [routeError, setRouteError] = useState<string | null>(null)
  const [routeLoading, setRouteLoading] = useState(false)

  const isNativeRuntime = platformRuntime.actualPlatform === 'ios' || platformRuntime.actualPlatform === 'android'
  const iosApiKey = (import.meta.env.VITE_NATIVE_IOS_MAPS_API_KEY as string | undefined)?.trim() ?? ''
  const needsIosApiKey = platformRuntime.actualPlatform === 'ios' && !iosApiKey
  const selectedMappedActivities = useMemo(
    () => activities
      .filter(hasCoordinates)
      .filter((activity) => activityMarkerMode !== 'timeline-days' || activity.dayDate !== null),
    [activities, activityMarkerMode],
  )
  const fallbackMappedActivities = useMemo(
    () => sortActivitiesByTripOrder(fallbackActivities.filter(hasCoordinates)),
    [fallbackActivities],
  )
  const selectedMarkerMetadata = useMemo(
    () => activityMarkerMetadata(selectedMappedActivities, activityMarkerMode, activityMarkerColors),
    [activityMarkerColors, activityMarkerMode, selectedMappedActivities],
  )
  const destinationKey = showDestinationFallback && selectedMappedActivities.length === 0 && fallbackMappedActivities.length === 0
    ? destination?.trim() ?? ''
    : ''
  const baseStops = useMemo(() => {
    if (selectedMappedActivities.length > 0) {
      return selectedMappedActivities.map((activity, index) => activityToDisplayStop(
        activity,
        index,
        'selected',
        selectedMarkerMetadata.get(activity.id),
      ))
    }
    if (fallbackMappedActivities.length > 0) {
      return fallbackMappedActivities.map((activity, index) => activityToDisplayStop(activity, index, 'trip'))
    }
    return destinationCoordinate ? [destinationToDisplayStop(destinationCoordinate)] : []
  }, [destinationCoordinate, fallbackMappedActivities, selectedMappedActivities, selectedMarkerMetadata])
  const previewStops = useMemo(
    () => [previewPlaceToDisplayStop(previewPlace), previewPlaceToDisplayStop(coordinatePreviewPlace)]
      .filter((stop): stop is DisplayStop => stop !== null),
    [coordinatePreviewPlace, previewPlace],
  )
  const searchStops = useMemo(
    () => searchResults.flatMap((place, index) => {
      const stop = searchPlaceToDisplayStop(place, index)
      return stop ? [stop] : []
    }),
    [searchResults],
  )
  const displayStops = useMemo(() => {
    const stops = [...baseStops, ...searchStops]
    previewStops.forEach((preview) => {
      const saved = stops.some((stop) => stop.source !== 'destination' && Math.abs(stop.lat - preview.lat) < 0.000001 && Math.abs(stop.lng - preview.lng) < 0.000001)
      if (!saved) stops.push(preview)
    })
    return stops
  }, [baseStops, previewStops, searchStops])
  const routeGroups = useMemo(() => groupRouteActivitiesByDay(routeActivities), [routeActivities])
  const routeGroupKey = useMemo(
    () => routeGroups.map((group) => `${group.dayDate}:${group.key}`).join('|'),
    [routeGroups],
  )
  const displayStopsKey = useMemo(
    () => displayStops.map((stop) => `${stop.id}:${stop.lat}:${stop.lng}`).join('|'),
    [displayStops],
  )
  const viewportFitSignature = useMemo(
    () => baseStops.map((stop) => `${stop.id}:${stop.lat.toFixed(6)}:${stop.lng.toFixed(6)}`).sort().join('|'),
    [baseStops],
  )
  const focusedStop = focusedActivityId === null
    ? null
    : baseStops.find((stop) => stop.activityId === focusedActivityId) ?? null

  useEffect(() => {
    callbacksRef.current = { onMapPlaceClick, onViewportContextChange }
  }, [onMapPlaceClick, onViewportContextChange])

  useEffect(() => {
    if (!destinationKey) {
      queueMicrotask(() => {
        setDestinationCoordinate(null)
        setDestinationStatus('idle')
      })
      return
    }
    const controller = new AbortController()
    queueMicrotask(() => setDestinationStatus('loading'))
    void geocodeDestination(destinationKey, controller.signal)
      .then((coordinate) => {
        if (controller.signal.aborted) return
        setDestinationCoordinate(coordinate)
        setDestinationStatus(coordinate ? 'idle' : 'error')
      })
      .catch(() => {
        if (!controller.signal.aborted) setDestinationStatus('error')
      })
    return () => controller.abort()
  }, [destinationKey])

  useEffect(() => {
    if (routeGroups.length === 0) {
      queueMicrotask(() => {
        setLoadedRoutes([])
        setRouteError(null)
        setRouteLoading(false)
      })
      return
    }
    const controller = new AbortController()
    queueMicrotask(() => {
      setRouteLoading(true)
      setRouteError(null)
    })
    void Promise.all(routeGroups.map(async (group) => ({
      dayDate: group.dayDate,
      route: await getDrivingDirections(group.activities, controller.signal),
    })))
      .then((routes) => {
        if (controller.signal.aborted) return
        setLoadedRoutes(routes.flatMap((entry) => entry.route ? [{ dayDate: entry.dayDate, route: entry.route }] : []))
        if (routes.some((entry) => entry.route === null)) {
          setRouteError('Some selected-day routes are unavailable.')
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setLoadedRoutes([])
          setRouteError('Routes could not be calculated. Try again shortly.')
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setRouteLoading(false)
      })
    return () => controller.abort()
  }, [routeGroupKey, routeGroups])

  useEffect(() => {
    if (!isNativeRuntime || needsIosApiKey || !elementRef.current) return
    let disposed = false
    let createdMap: NativeGoogleMap | null = null

    void NativeGoogleMap.create({
      apiKey: iosApiKey,
      config: initialCamera(baseStops),
      element: elementRef.current,
      id: nativeMapId,
      onReady: () => {
        if (!disposed) markPerformance('map-ready')
      },
    }).then(async (nextMap) => {
      createdMap = nextMap
      if (disposed) {
        await nextMap.destroy()
        return
      }
      await Promise.all([
        nextMap.setOnMarkerClickListener(({ markerId }) => markerActionsRef.current.get(markerId)?.()),
        nextMap.setOnMapClickListener(({ latitude, longitude }) => {
          const location = coordinateFromNativeEvent({ latitude, longitude })
          if (!location) return
          const clickedAtMs = placeDetailsNowMs()
          const clickedAtIso = new Date().toISOString()
          const traceId = createPlaceDetailsTraceId()
          logPlaceDetailsTiming('frontend_map_click', {
            clickedAtIso,
            clickedAtMs,
            hasLocation: true,
            hasPlaceId: false,
            placeId: null,
            traceId,
          })
          callbacksRef.current.onMapPlaceClick?.({
            clickedAtIso,
            clickedAtMs,
            location,
            placeId: null,
            traceId,
          })
        }),
        nextMap.setOnCameraIdleListener(({ bounds, latitude, longitude, zoom }) => {
          const center = coordinateFromNativeEvent({ latitude, longitude })
          if (!center) return
          callbacksRef.current.onViewportContextChange?.({
            bounds: {
              east: bounds.northeast.lng,
              north: bounds.northeast.lat,
              south: bounds.southwest.lat,
              west: bounds.southwest.lng,
            },
            center,
            zoom,
          })
        }),
      ])
      if (disposed) {
        await nextMap.destroy()
        return
      }
      mapRef.current = nextMap
      setMap(nextMap)
      setMapError(null)
    }).catch(() => {
      if (!disposed) setMapError('Native Google Maps could not start. Check the iOS or Android Maps SDK key configuration.')
    })

    return () => {
      disposed = true
      setMap(null)
      mapRef.current = null
      void createdMap?.destroy().catch(() => undefined)
    }
  // A native map instance is intentionally created once for this mounted tab.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isNativeRuntime, nativeMapId, needsIosApiKey, iosApiKey])

  useEffect(() => {
    if (platformRuntime.actualPlatform !== 'android' || !map) return
    document.documentElement.classList.add('native-map-active')
    return () => document.documentElement.classList.remove('native-map-active')
  }, [map])

  useEffect(() => {
    if (!map) return
    void map.setMapType(nativeMapType(mapStyle))
  }, [map, mapStyle])

  useEffect(() => {
    if (!map || baseStops.length === 0 || !viewportFitSignature) return
    const fitKey = viewportFitKey ? `${viewportFitKey}:${viewportFitSignature}` : viewportFitSignature
    if (lastFitKeyRef.current === fitKey) return
    lastFitKeyRef.current = fitKey
    const bounds = mapBoundsForStops(baseStops)
    if (bounds) {
      void map.fitBounds(bounds, 64)
      return
    }
    const stop = baseStops[0]
    void map.setCamera({ coordinate: stop, zoom: stop.source === 'destination' ? 9 : 12 })
  }, [baseStops, map, viewportFitKey, viewportFitSignature])

  useEffect(() => {
    if (!map || !focusedStop || focusedActivityKey === 0) return
    void map.setCamera({ animate: true, coordinate: focusedStop })
  }, [focusedActivityKey, focusedStop, map])

  useEffect(() => {
    const selectedSearch = selectedSearchResultId
      ? searchStops.find((stop) => stop.place?.placeId === selectedSearchResultId) ?? null
      : null
    if (!map || !selectedSearch) return
    void map.setCamera({ animate: true, coordinate: selectedSearch })
  }, [map, searchStops, selectedSearchResultId])

  useEffect(() => {
    if (!map || previewStops.length === 0) return
    void map.setCamera({ animate: true, coordinate: previewStops[0] })
  }, [map, previewStops])

  useEffect(() => {
    if (!map) return
    const render = ++markerRenderRef.current
    const priorIds = markerIdsRef.current
    markerIdsRef.current = []
    markerActionsRef.current = new Map()

    void (async () => {
      await map.removeMarkers(priorIds)
      if (render !== markerRenderRef.current || displayStops.length === 0) return
      const markers = displayStops.map((stop) => markerForStop(
        stop,
        stop.activityId === activeActivityId,
        stop.source === 'search' && stop.place?.placeId === highlightedSearchResultId,
      ))
      const markerIds = await map.addMarkers(markers)
      if (render !== markerRenderRef.current) {
        await map.removeMarkers(markerIds)
        return
      }
      const actions = new Map<string, () => void>()
      markerIds.forEach((markerId, index) => {
        const stop = displayStops[index]
        if (!stop) return
        if (stop.activityId !== undefined) {
          actions.set(markerId, () => {
            onActiveActivityChange?.(stop.activityId ?? null)
            onActivityActivate?.(stop.activityId as number)
          })
        } else if (stop.source === 'search' && stop.place) {
          const place = stop.place
          actions.set(markerId, () => {
            if (place.placeId === selectedSearchResultId && onSearchResultRemove) {
              onSearchResultRemove(place)
            } else {
              onSearchResultSelect?.(place)
            }
          })
        } else if (stop.source === 'preview') {
          const isCoordinatePreview = previewStops.some((preview) => preview.id === stop.id)
            && coordinatePreviewPlace?.lat === stop.lat
            && coordinatePreviewPlace?.lng === stop.lng
          actions.set(markerId, () => {
            if (isCoordinatePreview) onCoordinatePreviewPlaceClear?.()
            else onPreviewPlaceClear?.()
          })
        }
      })
      markerIdsRef.current = markerIds
      markerActionsRef.current = actions
    })().catch(() => {
      if (render === markerRenderRef.current) setMapError('Map markers could not be updated.')
    })
  }, [
    activeActivityId,
    coordinatePreviewPlace,
    displayStops,
    displayStopsKey,
    highlightedSearchResultId,
    map,
    onActivityActivate,
    onActiveActivityChange,
    onCoordinatePreviewPlaceClear,
    onPreviewPlaceClear,
    onSearchResultRemove,
    onSearchResultSelect,
    previewStops,
    selectedSearchResultId,
  ])

  useEffect(() => {
    if (!map) return
    const render = ++routeRenderRef.current
    const priorIds = polylineIdsRef.current
    polylineIdsRef.current = []
    const polylines = loadedRoutes.flatMap(({ route }) => {
      const paths = route.legs
        .map((leg) => leg.path)
        .filter((path) => Array.isArray(path) && path.length >= 2)
      return paths.length > 0 ? paths : route.path.length >= 2 ? [route.path] : []
    })

    void (async () => {
      await map.removePolylines(priorIds)
      if (render !== routeRenderRef.current || polylines.length === 0) return
      const ids = await map.addPolylines(polylines.map((path) => ({ path, ...ROUTE_STYLE })))
      if (render !== routeRenderRef.current) {
        await map.removePolylines(ids)
        return
      }
      polylineIdsRef.current = ids
    })().catch(() => {
      if (render === routeRenderRef.current) setRouteError('Route lines could not be drawn.')
    })
  }, [loadedRoutes, map])

  const routeTotals = useMemo(
    () => loadedRoutes.reduce(
      (totals, { route }) => ({ distance: totals.distance + route.distance, duration: totals.duration + route.duration }),
      { distance: 0, duration: 0 },
    ),
    [loadedRoutes],
  )
  const mapNotice = mapError
    ?? (destinationStatus === 'loading' ? 'Finding trip destination…' : null)
    ?? (destinationStatus === 'error' && destinationKey ? 'Trip destination could not be mapped.' : null)
    ?? (routeLoading ? 'Calculating route…' : null)
    ?? routeError
  const routeDaySummary = routeGroups.length > 1
    ? ` across ${loadedRoutes.length} of ${routeGroups.length} days`
    : ''
  const routeSummary = loadedRoutes.length > 0 ? (
    <div className={[styles.routeSummary, routeSummaryClassName].filter(Boolean).join(' ')} aria-live="polite">
      <div className={styles.routeSummaryHeader}>
        <Route size={15} aria-hidden="true" />
        <span>{routeSummaryLabel ?? (routeGroups.length > 1 ? 'Visible-days routes' : 'Selected-day route')}</span>
      </div>
      <strong>{formatTravelTime(routeTotals.duration)} total · {(routeTotals.distance / 1000).toFixed(1)} km{routeDaySummary}</strong>
    </div>
  ) : null

  return (
    <div className={styles.mapShell}>
      <capacitor-google-map
        ref={elementRef}
        aria-label={destination ? `Map for ${destination}` : 'Trip map'}
        className={styles.mapCanvas}
        data-testid="native-google-map"
        role="region"
      />
      {!isNativeRuntime && (
        <div className={styles.fallback} data-testid="native-map-runtime-notice" role="status">
          <MapPinned size={24} aria-hidden="true" />
          <div>
            <strong>Native map preview</strong>
            <span>The Google Maps SDK renders when this build runs in the iOS or Android app.</span>
          </div>
        </div>
      )}
      {needsIosApiKey && (
        <div className={styles.fallback} data-testid="native-map-key-notice" role="status">
          <AlertCircle size={24} aria-hidden="true" />
          <div>
            <strong>Native Maps needs an iOS SDK key</strong>
            <span>Configure VITE_NATIVE_IOS_MAPS_API_KEY for this native build.</span>
          </div>
        </div>
      )}
      {mapNotice && (
        <div className={styles.mapNotice} aria-live="polite">
          {destinationStatus === 'loading' || routeLoading ? <LoaderCircle size={14} aria-hidden="true" /> : <AlertCircle size={14} aria-hidden="true" />}
          {mapNotice}
        </div>
      )}
      {displayStops.length === 0 && destinationStatus !== 'loading' && !needsIosApiKey && (
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
