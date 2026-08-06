import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MockAdapter from 'axios-mock-adapter'
import {
  useEffect,
  useRef,
  type CSSProperties,
  type PropsWithChildren,
  type ReactNode,
} from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { apiClient } from '../api/client'
import { useAuthStore } from '../auth/authStore'
import type { Activity } from '../types/activity'
import type { ShareLink } from '../types/share'
import type { Trip } from '../types/trip'
import {
  activityDragId,
  sidebarDayDropId,
  sidebarIdeasDropId,
} from '../utils/activityDrag'
import { TripWorkspacePage } from './TripWorkspacePage'

const placeSearchMockState = vi.hoisted(() => ({
  searchOptions: null as null | {
    locationBias?: unknown
    proximity?: { lng: number; lat: number }
  },
}))

const googlePlacesMockState = vi.hoisted(() => ({
  fetchGooglePlaceById: vi.fn(),
  fetchGooglePlaceNearLocation: vi.fn(),
  fetchGooglePlaceTextSearch: vi.fn(),
  googlePlaceCategoryTypeForQuery: vi.fn(),
  imageUrlFromGooglePhotoName: vi.fn(),
}))

type DndTestCollision = { id: string }
type DndTestCollisionArgs = {
  active: { id: string }
  pointerCoordinates: { x: number; y: number } | null
}

const dndMockState = vi.hoisted(() => ({
  closestCenterCollisions: [] as DndTestCollision[],
  collisionDetection: null as null | ((args: DndTestCollisionArgs) => DndTestCollision[]),
  dragOverlayStyle: undefined as CSSProperties | undefined,
  onDragEnd: null as null | ((event: {
    active: { id: string }
    over: { id: string } | null
  }) => void),
  onDragMove: null as null | ((event: {
    active: { id: string }
    delta: { x: number; y: number }
  }) => void),
  onDragOver: null as null | ((event: {
    active: { id: string }
    over: { id: string } | null
  }) => void),
  onDragStart: null as null | ((event: {
    active: { id: string }
    activatorEvent: Event
  }) => void),
  pointerCollisions: [] as DndTestCollision[],
  sortableTransform: null as null | {
    x: number
    y: number
    scaleX: number
    scaleY: number
  },
  sortableTransition: undefined as string | undefined,
}))

vi.mock('@dnd-kit/core', () => ({
  DndContext: ({
    children,
    collisionDetection,
    onDragEnd,
    onDragMove,
    onDragOver,
    onDragStart,
  }: {
    children: ReactNode
    collisionDetection?: (args: DndTestCollisionArgs) => DndTestCollision[]
    onDragEnd?: (event: {
      active: { id: string }
      over: { id: string } | null
    }) => void
    onDragMove?: (event: {
      active: { id: string }
      delta: { x: number; y: number }
    }) => void
    onDragOver?: (event: {
      active: { id: string }
      over: { id: string } | null
    }) => void
    onDragStart?: (event: {
      active: { id: string }
      activatorEvent: Event
    }) => void
  }) => {
    dndMockState.collisionDetection = collisionDetection ?? null
    dndMockState.onDragEnd = onDragEnd ?? null
    dndMockState.onDragMove = onDragMove ?? null
    dndMockState.onDragOver = onDragOver ?? null
    dndMockState.onDragStart = onDragStart ?? null
    return <>{children}</>
  },
  DragOverlay: ({ children, style }: { children: ReactNode; style?: CSSProperties }) => {
    dndMockState.dragOverlayStyle = style
    return <div data-testid="drag-overlay">{children}</div>
  },
  KeyboardSensor: vi.fn(),
  PointerSensor: vi.fn(),
  closestCenter: vi.fn(() => dndMockState.closestCenterCollisions),
  pointerWithin: vi.fn(() => dndMockState.pointerCollisions),
  useDroppable: vi.fn(() => ({
    isOver: false,
    setNodeRef: vi.fn(),
  })),
  useSensor: vi.fn((sensor, options) => ({ sensor, options })),
  useSensors: vi.fn((...sensors) => sensors),
}))

vi.mock('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: ReactNode }) => <>{children}</>,
  arrayMove: <T,>(array: T[], from: number, to: number): T[] => {
    const next = [...array]
    const startIndex = from < 0 ? next.length + from : from
    if (startIndex < 0 || startIndex >= next.length) return next
    const [item] = next.splice(startIndex, 1)
    const endIndex = to < 0 ? next.length + to : to
    next.splice(endIndex, 0, item)
    return next
  },
  sortableKeyboardCoordinates: vi.fn(),
  useSortable: vi.fn(() => ({
    attributes: {},
    isDragging: false,
    listeners: {
      onKeyDown: vi.fn(),
      onPointerDown: vi.fn(),
    },
    setActivatorNodeRef: vi.fn(),
    setNodeRef: vi.fn(),
    transform: dndMockState.sortableTransform,
    transition: dndMockState.sortableTransition,
  })),
  verticalListSortingStrategy: {},
}))

vi.mock('../components/TripMap', () => ({
  TripMap: ({
    activeActivityId,
    activities,
    coordinatePreviewPlace,
    fallbackActivities,
    focusedActivityId,
    mapStyle,
    onActivityActivate,
    onActiveActivityChange,
    onCoordinatePreviewPlaceClear,
    onMapPlaceClick,
    onPreviewPlaceClear,
    onSearchResultRemove,
    onSearchResultSelect,
    onViewportContextChange,
    previewPlace,
    routeActivities = activities,
    searchResults = [],
    selectedSearchResultId,
    showDestinationFallback = true,
    viewportFitKey,
  }: {
    activeActivityId?: number | null
    activities: Array<{ id: number; title: string }>
    coordinatePreviewPlace?: { placeName?: string | null; title?: string | null } | null
    fallbackActivities: Array<{ id: number; title: string }>
    focusedActivityId?: number | null
    mapStyle?: string
    onActivityActivate?: (activityId: number) => void
    onActiveActivityChange?: (activityId: number | null) => void
    onCoordinatePreviewPlaceClear?: () => void
    onMapPlaceClick?: (event: {
      clickedAtIso: string
      clickedAtMs: number
      location: { lat: number; lng: number } | null
      placeName: string | null
      placeId: string | null
      source: 'native-coordinate' | 'native-poi' | 'web'
      traceId: string
    }) => void
    onPreviewPlaceClear?: () => void
    onSearchResultRemove?: (place: Record<string, unknown>) => void
    onSearchResultSelect?: (place: Record<string, unknown>) => void
    onViewportContextChange?: (context: {
      bounds?: { north: number; south: number; east: number; west: number }
      center: { lng: number; lat: number }
      zoom?: number
    }) => void
    previewPlace?: { placeName?: string | null; title?: string | null } | null
    routeActivities?: Array<{ id: number; title: string }>
    searchResults?: Array<Record<string, unknown>>
    selectedSearchResultId?: string | null
    showDestinationFallback?: boolean
    viewportFitKey?: string
  }) => (
    <div id="trip-map-focus-target" data-testid="trip-map" tabIndex={-1}>
      <div data-testid="active-map-activity">{activeActivityId ?? 'none'}</div>
      <div data-testid="focused-map-activity">{focusedActivityId ?? 'none'}</div>
      <div data-testid="map-viewport-fit-key" data-viewport-fit-key={viewportFitKey ?? 'none'} />
      <div data-testid="map-style">{mapStyle}</div>
      <div data-testid="preview-map-place">
        {previewPlace?.placeName ?? previewPlace?.title ?? 'none'}
      </div>
      <div data-testid="coordinate-preview-map-place">
        {coordinatePreviewPlace?.placeName ?? coordinatePreviewPlace?.title ?? 'none'}
      </div>
      <button
        type="button"
        onClick={() => onActiveActivityChange?.(activities[0]?.id ?? null)}
      >
        Mock hover marker
      </button>
      <button
        type="button"
        onClick={() => {
          const activityId = activities[0]?.id
          if (activityId !== undefined) onActivityActivate?.(activityId)
        }}
      >
        Mock activate marker
      </button>
      <button
        type="button"
        onClick={() => {
          const activityId = activities[1]?.id
          if (activityId !== undefined) onActivityActivate?.(activityId)
        }}
      >
        Mock activate second marker
      </button>
      <button
        type="button"
        onClick={() => onViewportContextChange?.({
          bounds: { north: 35.7, south: 35.6, east: 139.8, west: 139.7 },
          center: { lng: 139.7454, lat: 35.6586 },
          zoom: 12,
        })}
      >
        Mock viewport center
      </button>
      <button
        type="button"
        onClick={() => onViewportContextChange?.({
          bounds: { north: 36.2, south: 36.1, east: 140.3, west: 140.2 },
          center: { lng: 140.25, lat: 36.15 },
          zoom: 11,
        })}
      >
        Mock move map viewport
      </button>
      <button
        type="button"
        onClick={() => onMapPlaceClick?.({
          clickedAtIso: '2026-06-30T12:00:00.000Z',
          clickedAtMs: 100,
          location: { lat: 35.7, lng: 139.8 },
          placeName: null,
          placeId: 'google.poi-clicked',
          source: 'web',
          traceId: 'test-map-place-click',
        })}
      >
        Mock map place click
      </button>
      <button
        type="button"
        onClick={() => onMapPlaceClick?.({
          clickedAtIso: '2026-06-30T12:00:01.000Z',
          clickedAtMs: 200,
          location: { lat: 35.7, lng: 139.8 },
          placeName: null,
          placeId: null,
          source: 'web',
          traceId: 'test-map-location-click',
        })}
      >
        Mock map location click
      </button>
      <button
        type="button"
        onClick={() => onMapPlaceClick?.({
          clickedAtIso: '2026-06-30T12:00:02.000Z',
          clickedAtMs: 300,
          location: { lat: 35.7, lng: 139.8 },
          placeName: 'Clicked Place',
          placeId: 'google.poi-clicked',
          source: 'native-poi',
          traceId: 'test-native-poi-click',
        })}
      >
        Mock native POI click
      </button>
      <button
        type="button"
        onClick={() => onMapPlaceClick?.({
          clickedAtIso: '2026-06-30T12:00:03.000Z',
          clickedAtMs: 400,
          location: { lat: 35.7001, lng: 139.8001 },
          placeName: null,
          placeId: null,
          source: 'native-coordinate',
          traceId: 'test-native-coordinate-click',
        })}
      >
        Mock native coordinate click
      </button>
      <button
        type="button"
        onClick={() => onMapPlaceClick?.({
          clickedAtIso: '2026-06-30T12:00:04.000Z',
          clickedAtMs: 500,
          location: { lat: 35.7002, lng: 139.8002 },
          placeName: 'Invalid native POI',
          placeId: '   ',
          source: 'native-poi',
          traceId: 'test-invalid-native-poi-click',
        })}
      >
        Mock invalid native POI click
      </button>
      <button
        type="button"
        onClick={() => {
          const place = searchResults[0]
          if (place) onSearchResultSelect?.(place)
        }}
      >
        Mock select search result
      </button>
      <button
        type="button"
        onClick={() => {
          const place =
            searchResults.find((result) => result.placeId === selectedSearchResultId) ??
            searchResults[0]
          if (place) onSearchResultRemove?.(place)
        }}
      >
        Mock remove search marker
      </button>
      <button type="button" onClick={() => onPreviewPlaceClear?.()}>
        Mock clear preview marker
      </button>
      <button type="button" onClick={() => onCoordinatePreviewPlaceClear?.()}>
        Mock clear coordinate marker
      </button>
      <div data-testid="selected-search-result">{selectedSearchResultId ?? 'none'}</div>
      <div data-testid="selected-map-activities">
        {activities.map((activity) => (
          <span key={activity.id}>{activity.title}</span>
        ))}
      </div>
      <div data-testid="fallback-map-activities">
        {fallbackActivities.map((activity) => (
          <span key={activity.id}>{activity.title}</span>
        ))}
      </div>
      <div data-testid="route-map-activities">
        {routeActivities.map((activity) => (
          <span key={activity.id}>{activity.title}</span>
        ))}
      </div>
      <div data-testid="destination-fallback">{String(showDestinationFallback)}</div>
      <div data-testid="search-map-results">
        {searchResults.map((place) => (
          <span key={String(place.placeId)}>{String(place.placeName ?? place.title)}</span>
        ))}
      </div>
    </div>
  ),
}))

vi.mock('../components/PlaceSearch', () => ({
  googlePlaceToPlaceSelection: (place: Record<string, unknown>) => ({
    businessStatus: place.businessStatus,
    category: 'ACTIVITY',
    currentOpeningHours: place.currentOpeningHours,
    title: place.displayName ?? place.formattedAddress ?? 'Selected place',
    placeId: place.id,
    placeName: place.displayName,
    address: place.formattedAddress,
    coordinatesLabel:
      typeof place.lat === 'number' && typeof place.lng === 'number'
        ? `${place.lat.toFixed(5)}, ${place.lng.toFixed(5)}`
        : null,
    featureType: place.primaryType,
    lat: place.lat,
    lng: place.lng,
    googleMapsUri: place.googleMapsUri,
    photoName: place.photoName,
    photoUrl: place.photoUrl,
    placeCategory: place.primaryTypeDisplayName ?? place.primaryType,
    rating: place.rating,
    regularOpeningHours: place.regularOpeningHours,
    reviews: place.reviews,
    userRatingCount: place.userRatingCount,
    websiteUri: place.websiteUri,
  }),
  PlaceSearch: ({
    contextLabel,
    focusKey,
    onPlaceSelect,
    onPlacePreview,
    onSearchSubmit,
    onSearchValueChange,
    searchValue,
    searchOptions,
  }: {
    contextLabel?: string
    focusKey?: number
    onPlaceSelect: (place: Record<string, unknown>) => void
    onPlacePreview?: (place: Record<string, unknown> | null) => void
    onSearchSubmit?: (query: string) => Promise<void> | void
    onSearchValueChange?: (value: string) => void
    searchValue?: string
    searchOptions?: {
      locationBias?: unknown
      proximity?: { lng: number; lat: number }
    }
  }) => {
    const inputRef = useRef<HTMLInputElement | null>(null)
    useEffect(() => {
      if (focusKey !== undefined) inputRef.current?.focus()
    }, [focusKey])
    placeSearchMockState.searchOptions = searchOptions ?? null
    const place = {
      category: 'ACTIVITY',
      title: 'Tokyo Tower',
      placeId: 'google.tokyo-tower',
      placeName: 'Tokyo Tower',
      address: '4 Chome-2-8 Shibakoen, Minato City, Tokyo',
      lat: 35.6586,
      lng: 139.7454,
      photoUrl: 'https://example.com/tokyo-tower.webp',
    }
    return (
      <div>
        {contextLabel && <div>{contextLabel}</div>}
        <input
          ref={inputRef}
          aria-label="Map place search"
          value={searchValue ?? ''}
          readOnly
        />
        <div data-testid="place-search-value">{searchValue ?? ''}</div>
        <div data-testid="place-search-proximity">
          {searchOptions?.proximity
            ? `${searchOptions.proximity.lng},${searchOptions.proximity.lat}`
            : 'none'}
        </div>
        <button
          type="button"
          onClick={() => {
            onPlacePreview?.(place)
            onPlaceSelect(place)
          }}
        >
          Mock place search
        </button>
        <button
          type="button"
          onClick={() => {
            onSearchValueChange?.('ramen')
          }}
        >
          Mock type ramen search
        </button>
        <button
          type="button"
          onClick={() => {
            void Promise.resolve(onSearchSubmit?.(searchValue || 'ramen')).catch(() => undefined)
          }}
        >
          Mock submit place search
        </button>
        <button
          type="button"
          onClick={() => {
            void Promise.resolve(onSearchSubmit?.('restaurants')).catch(() => undefined)
          }}
        >
          Mock submit restaurants search
        </button>
      </div>
    )
  },
}))

vi.mock('../components/googlePlaces', () => ({
  fetchGooglePlaceById: googlePlacesMockState.fetchGooglePlaceById,
  fetchGooglePlaceNearLocation: googlePlacesMockState.fetchGooglePlaceNearLocation,
  fetchGooglePlaceTextSearch: googlePlacesMockState.fetchGooglePlaceTextSearch,
  googlePlaceCategoryTypeForQuery: googlePlacesMockState.googlePlaceCategoryTypeForQuery,
  imageUrlFromGooglePhotoName: googlePlacesMockState.imageUrlFromGooglePhotoName,
}))

let apiMock: MockAdapter
let queryClient: QueryClient

const SAMPLE_TRIP: Trip = {
  publicId: 'abc234def567',
  name: 'Tokyo 2026',
  destination: 'Tokyo, Japan',
  startDate: '2026-05-01',
  endDate: '2026-05-05',
  imageUrl: null,
  createdAt: '2026-05-22T16:00:00Z',
  role: 'OWNER',
  version: 0,
}

const SAMPLE_ACTIVITY: Activity = {
  id: 10,
  dayDate: '2026-05-01',
  category: 'MEAL',
  startTime: '09:00',
  endTime: null,
  title: 'Tsukiji sushi',
  notes: 'Counter seat',
  placeId: null,
  placeName: null,
  address: null,
  lat: null,
  lng: null,
  orderIndex: 0,
  createdByUserDisplayName: 'Alice',
  updatedByUserDisplayName: 'Alice',
  createdAt: '2026-05-22T16:00:00Z',
  updatedAt: '2026-05-22T16:00:00Z',
  version: 0,
}

const ACTIVE_SHARE_LINK: ShareLink = {
  id: 7,
  name: 'Tokyo editor invite',
  role: 'EDITOR',
  allowAnonymous: true,
  createdAt: '2026-05-22T16:00:00Z',
  expiresAt: null,
  revokedAt: null,
}

function Providers({ children }: PropsWithChildren) {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  )
}

type ActivityApiFixture = Activity | Omit<Activity, 'dayDate'>

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function withoutDayDate(activity: Activity): Omit<Activity, 'dayDate'> {
  const response = { ...activity }
  delete (response as Partial<Activity>).dayDate
  return response
}

function expectGoogleMapsPlaceLink(
  link: HTMLElement,
  { placeId, query }: { placeId: string; query: string },
) {
  const url = new URL(link.getAttribute('href') ?? '')
  expect(url.origin).toBe('https://www.google.com')
  expect(url.pathname).toBe('/maps/search/')
  expect(url.searchParams.get('api')).toBe('1')
  expect(url.searchParams.get('query')).toBe(query)
  expect(url.searchParams.get('query_place_id')).toBe(placeId)
}

function mockWorkspace(
  activities: ActivityApiFixture[] = [],
  trip: Trip = SAMPLE_TRIP,
) {
  apiMock.onGet('/trips/abc234def567').reply(200, trip)
  apiMock.onGet('/trips/abc234def567/activities').reply(200, activities)
}

function authenticateUser() {
  useAuthStore.getState().setSession({
    accessToken: 'jwt-access-token',
    expiresInSeconds: 900,
    user: {
      id: 200,
      email: 'bob@example.com',
      displayName: 'Bob',
      emailVerified: true,
    },
  })
}

function renderWorkspace(path: string) {
  function LocationProbe() {
    const location = useLocation()
    return (
      <div data-testid="current-location" data-location-key={location.key}>
        {location.pathname}{location.search}
      </div>
    )
  }

  return render(
    <Providers>
      <MemoryRouter initialEntries={[path]}>
        <LocationProbe />
        <Routes>
          <Route path="/trips/:publicId" element={<TripWorkspacePage />} />
          <Route path="/trips/:publicId/d/:day" element={<TripWorkspacePage />} />
          <Route path="/trips/:publicId/members" element={<TripWorkspacePage />} />
        </Routes>
      </MemoryRouter>
    </Providers>,
  )
}

function mockViewport(isMobile: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>()
  const matchMedia = vi.fn((query: string) => ({
    addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener)
    },
    addListener: (listener: (event: MediaQueryListEvent) => void) => {
      listeners.add(listener)
    },
    dispatchEvent: (event: Event) => {
      listeners.forEach((listener) => listener(event as MediaQueryListEvent))
      return true
    },
    matches: isMobile,
    media: query,
    onchange: null,
    removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener)
    },
    removeListener: (listener: (event: MediaQueryListEvent) => void) => {
      listeners.delete(listener)
    },
  }) as MediaQueryList)

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: matchMedia,
    writable: true,
  })
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: isMobile ? 390 : 1024,
    writable: true,
  })
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    value: isMobile ? 844 : 768,
    writable: true,
  })
}

function triggerDragEnd(activeId: string, overId: string | null) {
  if (!dndMockState.onDragEnd) {
    throw new Error('DndContext onDragEnd handler was not registered')
  }

  act(() => {
    dndMockState.onDragEnd?.({
      active: { id: activeId },
      over: overId === null ? null : { id: overId },
    })
  })
}

function triggerDragStart(activeId: string, clientX = 0, clientY = 0) {
  if (!dndMockState.onDragStart) {
    throw new Error('DndContext onDragStart handler was not registered')
  }

  act(() => {
    dndMockState.onDragStart?.({
      active: { id: activeId },
      activatorEvent: new MouseEvent('pointerdown', { clientX, clientY }),
    })
  })
}

function triggerDragMove(activeId: string, delta: { x: number; y: number }) {
  if (!dndMockState.onDragMove) {
    throw new Error('DndContext onDragMove handler was not registered')
  }

  act(() => {
    dndMockState.onDragMove?.({
      active: { id: activeId },
      delta,
    })
  })
}

function triggerDragOver(activeId: string, overId: string | null) {
  if (!dndMockState.onDragOver) {
    throw new Error('DndContext onDragOver handler was not registered')
  }

  act(() => {
    dndMockState.onDragOver?.({
      active: { id: activeId },
      over: overId === null ? null : { id: overId },
    })
  })
}

function runCollisionDetection(
  activeId: string,
  pointerCoordinates: { x: number; y: number } | null,
): DndTestCollision[] {
  if (!dndMockState.collisionDetection) {
    throw new Error('DndContext collision detection was not registered')
  }
  return dndMockState.collisionDetection({
    active: { id: activeId },
    pointerCoordinates,
  })
}

function domRect({
  bottom,
  left,
  right,
  top,
}: {
  bottom: number
  left: number
  right: number
  top: number
}): DOMRect {
  return {
    bottom,
    height: bottom - top,
    left,
    right,
    top,
    width: right - left,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

beforeEach(() => {
  vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'gmaps.test')
  mockViewport(false)
  Object.defineProperty(document, 'elementFromPoint', {
    configurable: true,
    value: vi.fn(() => null),
  })
  apiMock = new MockAdapter(apiClient)
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollBy', {
    configurable: true,
    value: vi.fn(),
  })
  placeSearchMockState.searchOptions = null
  googlePlacesMockState.fetchGooglePlaceById.mockReset()
  googlePlacesMockState.fetchGooglePlaceById.mockResolvedValue({
    businessStatus: 'OPERATIONAL',
    currentOpeningHours: null,
    displayName: 'Clicked Place',
    formattedAddress: 'Clicked address',
    googleMapsUri: 'https://maps.google.com/?cid=clicked',
    id: 'google.poi-clicked',
    lat: 35.7,
    lng: 139.8,
    photoUrl: null,
    primaryType: 'tourist_attraction',
    primaryTypeDisplayName: 'Tourist attraction',
    rating: null,
    regularOpeningHours: null,
    reviews: [],
    text: 'Clicked Place, Clicked address',
    types: ['tourist_attraction'],
    userRatingCount: null,
    websiteUri: null,
  })
  googlePlacesMockState.fetchGooglePlaceTextSearch.mockReset()
  googlePlacesMockState.fetchGooglePlaceTextSearch.mockResolvedValue({
    nextPageToken: null,
    places: [],
  })
  googlePlacesMockState.fetchGooglePlaceNearLocation.mockReset()
  googlePlacesMockState.fetchGooglePlaceNearLocation.mockResolvedValue({
    businessStatus: 'OPERATIONAL',
    currentOpeningHours: null,
    displayName: 'Nearby Cafe',
    formattedAddress: 'Nearby address',
    googleMapsUri: 'https://maps.google.com/?cid=nearby',
    id: 'google.nearby-cafe',
    lat: 35.7002,
    lng: 139.8002,
    photoUrl: null,
    primaryType: 'cafe',
    primaryTypeDisplayName: 'Cafe',
    rating: 4.7,
    regularOpeningHours: null,
    reviews: [],
    text: 'Nearby Cafe, Nearby address',
    types: ['cafe'],
    userRatingCount: 42,
    websiteUri: null,
  })
  googlePlacesMockState.googlePlaceCategoryTypeForQuery.mockReset()
  googlePlacesMockState.googlePlaceCategoryTypeForQuery.mockImplementation((query: string) => {
    const normalized = query.trim().toLowerCase()
    return normalized === 'restaurants' ? 'restaurant' : null
  })
  googlePlacesMockState.imageUrlFromGooglePhotoName.mockReset()
  googlePlacesMockState.imageUrlFromGooglePhotoName.mockResolvedValue(null)
  dndMockState.closestCenterCollisions = []
  dndMockState.collisionDetection = null
  dndMockState.dragOverlayStyle = undefined
  dndMockState.onDragEnd = null
  dndMockState.onDragMove = null
  dndMockState.onDragOver = null
  dndMockState.onDragStart = null
  dndMockState.pointerCollisions = []
  dndMockState.sortableTransform = null
  dndMockState.sortableTransition = undefined
})

afterEach(() => {
  cleanup()
  apiMock.restore()
  queryClient.clear()
  useAuthStore.getState().clearSession()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('<TripWorkspacePage>', () => {
  it('resets stale document scrolling when a mobile workspace opens', () => {
    mockViewport(true)
    mockWorkspace()
    const originalScrollY = Object.getOwnPropertyDescriptor(window, 'scrollY')
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined)
    Object.defineProperty(window, 'scrollY', {
      configurable: true,
      value: 64,
    })

    try {
      renderWorkspace('/trips/abc234def567/d/2026-05-03')
      expect(scrollTo).toHaveBeenCalledWith(0, 0)
    } finally {
      scrollTo.mockRestore()
      if (originalScrollY) {
        Object.defineProperty(window, 'scrollY', originalScrollY)
      } else {
        Reflect.deleteProperty(window, 'scrollY')
      }
    }
  })

  it('uses the mobile bottom bar and mounts the map only for the Map tab', async () => {
    mockViewport(true)
    mockWorkspace()

    renderWorkspace('/trips/abc234def567/d/2026-05-03')

    await screen.findByRole('heading', { level: 1, name: /tokyo 2026/i })
    expect(screen.queryByRole('button', { name: /^pin sidebar$/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId('trip-map')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^plan$/i })).toHaveAttribute('aria-current', 'page')

    await userEvent.click(screen.getByRole('button', { name: /^map$/i }))
    expect(await screen.findByTestId('trip-map')).toBeInTheDocument()
    expect(screen.getAllByTestId('trip-map')).toHaveLength(1)
    expect(screen.getByRole('textbox', { name: /map place search/i })).not.toHaveFocus()

    await userEvent.click(screen.getByRole('button', { name: /^timeline$/i }))
    expect(screen.queryByTestId('trip-map')).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /^timeline$/i })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /full trip timeline/i })).not.toBeInTheDocument()

    const menuButton = screen.getByRole('button', { name: /open trip menu/i })
    await userEvent.click(menuButton)
    expect(screen.getByRole('dialog', { name: /tokyo 2026/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /share trip/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /trip settings/i })).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /tokyo 2026/i })).not.toBeInTheDocument()
      expect(menuButton).toHaveFocus()
    })
  })

  it('opens the Map tab without carrying an activity place card into it', async () => {
    mockViewport(true)
    mockWorkspace([{
      ...SAMPLE_ACTIVITY,
      placeId: 'google.tsukiji',
      placeName: 'Tsukiji sushi',
      address: 'Tsukiji, Chuo City, Tokyo',
      lat: 35.6654,
      lng: 139.7707,
    }])

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    const activityCard = await screen.findByRole('article', { name: /expand tsukiji sushi/i })
    await userEvent.click(activityCard)
    await waitFor(() => {
      expect(googlePlacesMockState.fetchGooglePlaceById).toHaveBeenCalledWith({
        includePhoto: true,
        placeId: 'google.tsukiji',
      })
    })

    await userEvent.click(screen.getByRole('button', { name: /^map$/i }))

    expect(await screen.findByTestId('trip-map')).toBeInTheDocument()
    expect(screen.queryByLabelText(/selected map place/i)).not.toBeInTheDocument()
  })

  it('uses a bounded mobile day navigator and a floating activity action', async () => {
    mockViewport(true)
    mockWorkspace()

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    const dayHeading = await screen.findByRole('heading', {
      level: 2,
      name: /friday, may 1/i,
    })
    expect(screen.queryByRole('heading', { level: 2, name: /^day plan$/i })).not.toBeInTheDocument()
    const dayNavigator = dayHeading.parentElement as HTMLElement

    const dayPicker = within(dayHeading).getByRole('button', {
      name: /choose trip day: friday, may 1/i,
    })
    expect(dayPicker).toHaveTextContent('Friday, May 1')
    expect(within(dayNavigator).getByRole('button', { name: /previous day/i })).toBeDisabled()
    const nextDay = within(dayNavigator).getByRole('button', { name: /next day/i })
    expect(nextDay).toBeEnabled()

    const addActivity = screen.getByLabelText(/^add activity$/i, { selector: 'button' })
    expect(addActivity).not.toHaveTextContent('Add Activity')
    expect(addActivity).toHaveAttribute('title', 'Add Activity')
    expect(addActivity.querySelector('svg')).toBeInTheDocument()
    addActivity.focus()
    await userEvent.keyboard('{Enter}')
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: /activity name/i })).toHaveFocus()
    })
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }))

    await userEvent.click(nextDay)
    await waitFor(() => {
      expect(screen.getByTestId('current-location')).toHaveTextContent('/trips/abc234def567/d/2026-05-02')
    })
    const nextHeading = screen.getByRole('heading', { level: 2, name: /saturday, may 2/i })
    expect(within(nextHeading.parentElement as HTMLElement).getByRole('button', {
      name: /previous day/i,
    })).toBeEnabled()

    const nextDayPicker = within(nextHeading).getByRole('button', {
      name: /choose trip day: saturday, may 2/i,
    })
    const nextDayPickerRect = vi.spyOn(nextDayPicker, 'getBoundingClientRect').mockReturnValue(domRect({
      bottom: 164,
      left: 60,
      right: 330,
      top: 120,
    }))
    await userEvent.click(nextDayPicker)
    const dayPickerDialog = screen.getByRole('dialog', { name: /choose a trip day/i })
    expect(dayPickerDialog).toHaveAttribute('data-placement', 'below')
    expect(dayPickerDialog).toHaveStyle({
      left: '15px',
      maxHeight: '660px',
      top: '172px',
      width: '360px',
    })
    expect(screen.getByRole('button', { name: /close day picker/i })).toHaveFocus()

    nextDayPickerRect.mockReturnValue(domRect({
      bottom: 744,
      left: 220,
      right: 360,
      top: 700,
    }))
    fireEvent(window, new Event('resize'))
    await waitFor(() => {
      expect(dayPickerDialog).toHaveAttribute('data-placement', 'above')
      expect(dayPickerDialog).toHaveStyle({
        bottom: '152px',
        left: '18px',
        maxHeight: '672px',
        width: '360px',
      })
    })

    nextDayPickerRect.mockReturnValue(domRect({
      bottom: 164,
      left: 60,
      right: 330,
      top: 120,
    }))
    fireEvent.scroll(window)
    await waitFor(() => {
      expect(dayPickerDialog).toHaveAttribute('data-placement', 'below')
      expect(dayPickerDialog).toHaveStyle({
        left: '15px',
        maxHeight: '660px',
        top: '172px',
        width: '360px',
      })
    })

    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /choose a trip day/i })).not.toBeInTheDocument()
      expect(nextDayPicker).toHaveFocus()
    })

    await userEvent.click(nextDayPicker)
    await userEvent.click(screen.getByTitle('2026-05-03 (0 activities)'))
    await waitFor(() => {
      expect(screen.getByTestId('current-location')).toHaveTextContent('/trips/abc234def567/d/2026-05-03')
      expect(screen.getByRole('button', { name: /choose trip day: sunday, may 3/i })).toBeInTheDocument()
    })
  })

  it('disables next-day navigation at the end of the trip', async () => {
    mockViewport(true)
    mockWorkspace()

    renderWorkspace('/trips/abc234def567/d/2026-05-05')

    const dayHeading = await screen.findByRole('heading', {
      level: 2,
      name: /tuesday, may 5/i,
    })
    const dayNavigator = dayHeading.parentElement as HTMLElement
    expect(within(dayNavigator).getByRole('button', { name: /previous day/i })).toBeEnabled()
    expect(within(dayNavigator).getByRole('button', { name: /next day/i })).toBeDisabled()
  })

  it('keeps matching add actions in Plan and Ideas, and hides them while composing', async () => {
    mockViewport(true)
    mockWorkspace()

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    const addActivity = await screen.findByLabelText(/^add activity$/i, { selector: 'button' })
    await userEvent.click(addActivity)
    await screen.findByRole('textbox', { name: /activity name/i })
    expect(screen.queryByLabelText(/^add activity$/i, { selector: 'button' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    const restoredAddActivity = await screen.findByLabelText(/^add activity$/i, {
      selector: 'button',
    })
    await waitFor(() => expect(restoredAddActivity).toHaveFocus())

    await userEvent.click(screen.getByRole('button', { name: /^map$/i }))
    await screen.findByTestId('trip-map')
    expect(screen.queryByLabelText(/^add activity$/i, { selector: 'button' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^timeline$/i }))
    expect(await screen.findByRole('heading', { name: /^timeline$/i })).toBeInTheDocument()
    expect(screen.queryByLabelText(/^add activity$/i, { selector: 'button' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^ideas$/i }))
    const addIdea = await screen.findByLabelText(/^add idea$/i, { selector: 'button' })
    expect(screen.getAllByText(/^0 ideas$/i)).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: /^add idea$/i })).toHaveLength(1)
    expect(addIdea).toHaveAttribute('title', 'Add Idea')
    expect(addIdea.querySelector('svg')).toBeInTheDocument()
    await userEvent.click(addIdea)
    await screen.findByRole('textbox', { name: /activity name/i })
    expect(screen.queryByLabelText(/^add idea$/i, { selector: 'button' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    const restoredAddIdea = await screen.findByLabelText(/^add idea$/i, { selector: 'button' })
    await waitFor(() => expect(restoredAddIdea).toHaveFocus())
  })

  it('uses the compact mobile timeline summary and guides empty trips into Plan', async () => {
    mockViewport(true)
    mockWorkspace()

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await userEvent.click(await screen.findByRole('button', { name: /^timeline$/i }))

    expect(screen.getByRole('heading', { level: 2, name: /^timeline$/i })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /full trip timeline/i })).not.toBeInTheDocument()
    expect(screen.getByText(/^0 activities · 0 days$/i)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /no activities yet/i })).toBeInTheDocument()
    expect(screen.getByText(/plan an activity or save an idea/i)).toBeInTheDocument()
    expect(screen.getByText(/^0 days planned$/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^add activity$/i }))
    expect(screen.getByRole('button', { name: /^plan$/i })).toHaveAttribute('aria-current', 'page')
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: /activity name/i })).toHaveFocus()
    })
  })

  it('keeps empty mobile timeline guidance read-only for viewers', async () => {
    mockViewport(true)
    mockWorkspace([], { ...SAMPLE_TRIP, role: 'VIEWER' })

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await userEvent.click(await screen.findByRole('button', { name: /^timeline$/i }))
    expect(screen.getByRole('heading', { name: /no activities yet/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^add activity$/i })).not.toBeInTheDocument()
  })

  it('keeps the desktop day heading and compact add action', async () => {
    mockWorkspace()

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    expect(await screen.findByRole('heading', { level: 2, name: /friday, may 1/i })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 2, name: /^day plan$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /choose trip day/i })).not.toBeInTheDocument()

    const addActivity = screen.getAllByRole('button', { name: /^add activity$/i })[0]
    expect(addActivity).not.toHaveTextContent('Add Activity')
    expect(addActivity.querySelector('svg')).toBeInTheDocument()
  })

  it('keeps share-link management in Share trip, not its member list', async () => {
    mockViewport(true)
    mockWorkspace()
    apiMock.onGet('/trips/abc234def567/share-links').reply(200, [ACTIVE_SHARE_LINK])

    renderWorkspace('/trips/abc234def567/d/2026-05-03')

    await screen.findByRole('heading', { level: 1, name: /tokyo 2026/i })
    await userEvent.click(screen.getByRole('button', { name: /open trip menu/i }))
    await userEvent.click(screen.getByRole('button', { name: /^share trip$/i }))

    const shareDialog = await screen.findByRole('dialog', { name: /^share trip$/i })
    expect(within(shareDialog).getByRole('heading', { name: /^create link$/i })).toBeInTheDocument()
    expect(within(shareDialog).getByRole('button', { name: /^rename$/i })).toBeInTheDocument()
    expect(within(shareDialog).getByRole('button', { name: /copy url/i })).toBeInTheDocument()
    expect(within(shareDialog).getByRole('button', { name: /^revoke$/i })).toBeInTheDocument()
    expect(within(shareDialog).queryByRole('heading', { name: /^members$/i })).not.toBeInTheDocument()
    expect(apiMock.history.get.map(({ url }) => url)).not.toContain('/trips/abc234def567/members')
  })

  it('renders the authenticated Members deep link as a contained workspace overlay', async () => {
    authenticateUser()
    mockWorkspace()
    apiMock.onGet('/trips/abc234def567/members').reply(200, [
      {
        userId: 42,
        email: 'alice@example.com',
        displayName: 'Alice',
        role: 'OWNER',
      },
      {
        userId: 84,
        email: 'bob@example.com',
        displayName: 'Bob',
        role: 'EDITOR',
      },
    ])

    renderWorkspace('/trips/abc234def567/members')

    expect(await screen.findByRole('heading', { level: 1, name: /tokyo 2026/i })).toBeInTheDocument()
    const membersDialog = await screen.findByRole('dialog', { name: /^members$/i })
    expect(within(membersDialog).getByText('Alice')).toBeInTheDocument()
    expect(within(membersDialog).getByRole('button', { name: 'Remove Bob' })).toBeInTheDocument()
    expect(within(membersDialog).queryByRole('button', { name: 'Remove Alice' })).not.toBeInTheDocument()
    expect(apiMock.history.get.map(({ url }) => url)).not.toContain('/trips/abc234def567/share-links')

    await userEvent.click(within(membersDialog).getByRole('button', { name: /close members/i }))
    await waitFor(() => {
      expect(screen.getByTestId('current-location')).toHaveTextContent('/trips/abc234def567')
      expect(screen.queryByRole('dialog', { name: /^members$/i })).not.toBeInTheDocument()
    })
  })

  it('keeps the members retry state inside the workspace overlay', async () => {
    authenticateUser()
    mockWorkspace()
    apiMock.onGet('/trips/abc234def567/members').reply(500, { error: 'internal_error' })

    renderWorkspace('/trips/abc234def567/members')

    const membersDialog = await screen.findByRole('dialog', { name: /^members$/i })
    expect(await within(membersDialog).findByRole('button', { name: /retry members/i })).toBeInTheDocument()
    expect(within(membersDialog).queryByText('No members found.')).not.toBeInTheDocument()
  })

  it('returns to the originating trip day when Members opens from the mobile menu', async () => {
    authenticateUser()
    mockViewport(true)
    mockWorkspace()
    apiMock.onGet('/trips/abc234def567/members').reply(200, [
      {
        userId: 42,
        email: 'alice@example.com',
        displayName: 'Alice',
        role: 'OWNER',
      },
    ])

    renderWorkspace('/trips/abc234def567/d/2026-05-01')
    const originatingLocationKey = screen.getByTestId('current-location').dataset.locationKey

    await userEvent.click(await screen.findByRole('button', { name: /open trip menu/i }))
    await userEvent.click(screen.getByRole('button', { name: /^members$/i }))
    const membersDialog = await screen.findByRole('dialog', { name: /^members$/i })
    await userEvent.click(within(membersDialog).getByRole('button', { name: /close members/i }))

    await waitFor(() => {
      expect(screen.getByTestId('current-location')).toHaveTextContent('/trips/abc234def567/d/2026-05-01')
      expect(screen.getByTestId('current-location')).toHaveAttribute(
        'data-location-key',
        originatingLocationKey,
      )
      expect(screen.queryByRole('dialog', { name: /^members$/i })).not.toBeInTheDocument()
    })
  })

  it('removes a member and restores focus inside the members overlay', async () => {
    authenticateUser()
    mockWorkspace()
    const removalResponse = createDeferred<[number]>()
    const owner = {
      userId: 42,
      email: 'alice@example.com',
      displayName: 'Alice',
      role: 'OWNER',
    }
    const member = {
      userId: 84,
      email: 'bob@example.com',
      displayName: 'Bob',
      role: 'EDITOR',
    }
    apiMock.onGet('/trips/abc234def567/members').replyOnce(200, [owner, member])
    apiMock.onGet('/trips/abc234def567/members').reply(200, [owner])
    apiMock.onDelete('/trips/abc234def567/members/84').reply(() => removalResponse.promise)

    renderWorkspace('/trips/abc234def567/members')

    const membersDialog = await screen.findByRole('dialog', { name: /^members$/i })
    const closeMembers = within(membersDialog).getByRole('button', { name: /close members/i })
    await userEvent.click(await within(membersDialog).findByRole('button', { name: 'Remove Bob' }))
    const confirmation = await screen.findByRole('alertdialog', { name: 'Remove member?' })
    await userEvent.click(within(confirmation).getByRole('button', { name: 'Remove member' }))

    expect(within(confirmation).getByRole('button', { name: 'Removing...' })).toBeDisabled()
    act(() => removalResponse.resolve([204]))

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog', { name: 'Remove member?' })).not.toBeInTheDocument()
      expect(within(membersDialog).queryByText('Bob')).not.toBeInTheDocument()
      expect(closeMembers).toHaveFocus()
    })
  })

  it('keeps member removal confirmation and errors within the members overlay', async () => {
    authenticateUser()
    mockWorkspace()
    apiMock.onGet('/trips/abc234def567/members').reply(200, [
      {
        userId: 42,
        email: 'alice@example.com',
        displayName: 'Alice',
        role: 'OWNER',
      },
      {
        userId: 84,
        email: 'bob@example.com',
        displayName: 'Bob',
        role: 'EDITOR',
      },
    ])
    apiMock.onDelete('/trips/abc234def567/members/84').reply(500, {
      error: 'internal_error',
    })

    renderWorkspace('/trips/abc234def567/members')

    const membersDialog = await screen.findByRole('dialog', { name: /^members$/i })
    await userEvent.click(await within(membersDialog).findByRole('button', { name: 'Remove Bob' }))
    const confirmation = await screen.findByRole('alertdialog', { name: 'Remove member?' })
    const cancelRemoval = within(confirmation).getByRole('button', { name: /^cancel$/i })
    await waitFor(() => expect(cancelRemoval).toHaveFocus())
    await userEvent.tab({ shift: true })
    expect(within(confirmation).getByRole('button', { name: 'Remove member' })).toHaveFocus()
    await userEvent.tab()
    expect(cancelRemoval).toHaveFocus()
    await userEvent.click(within(confirmation).getByRole('button', { name: 'Remove member' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The server ran into a problem. Please try again.',
    )
    expect(screen.getByRole('alertdialog', { name: 'Remove member?' })).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog', { name: 'Remove member?' })).not.toBeInTheDocument()
      expect(screen.getByRole('dialog', { name: /^members$/i })).toBeInTheDocument()
    })
  })

  it('focuses, traps, closes, and restores focus for workspace dialogs', async () => {
    mockWorkspace()

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    const settingsTrigger = await screen.findByRole('button', { name: /^settings$/i })
    settingsTrigger.focus()
    await userEvent.click(settingsTrigger)
    const settingsDialog = await screen.findByRole('dialog', { name: /trip settings/i })
    const closeButton = within(settingsDialog).getByRole('button', { name: /close trip settings/i })

    await waitFor(() => expect(closeButton).toHaveFocus())
    await userEvent.tab({ shift: true })
    expect(within(settingsDialog).getByRole('button', { name: /save changes/i })).toHaveFocus()

    const dateTrigger = within(settingsDialog).getByRole('button', { name: /trip dates/i })
    await userEvent.click(dateTrigger)
    const dateDialog = await screen.findByRole('dialog', { name: /trip dates/i })
    expect(within(dateDialog).getByRole('button', {
      name: /choose friday, may 1, 2026/i,
    })).toHaveFocus()
    await userEvent.tab()
    expect(dateDialog).toContainElement(document.activeElement as HTMLElement)
    await userEvent.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /trip dates/i })).not.toBeInTheDocument()
      expect(screen.getByRole('dialog', { name: /trip settings/i })).toBeInTheDocument()
      expect(dateTrigger).toHaveFocus()
    })

    await userEvent.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /trip settings/i })).not.toBeInTheDocument()
      expect(settingsTrigger).toHaveFocus()
    })
  })

  it('edits and moves a mobile activity by selecting its card', async () => {
    mockViewport(true)
    mockWorkspace([SAMPLE_ACTIVITY])
    apiMock.onPost('/activities/10/move?publicId=abc234def567').reply((config) => {
      expect(JSON.parse(config.data as string)).toEqual({
        dayDate: '2026-05-02',
        orderIndex: 0,
      })
      return [200, { ...SAMPLE_ACTIVITY, dayDate: '2026-05-02' }]
    })

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByRole('article', { name: /expand tsukiji sushi/i })
    expect(screen.queryByRole('button', { name: /edit tsukiji sushi/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /move to day/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /reorder tsukiji sushi/i })).toBeInTheDocument()

    const activityCard = screen.getByRole('article', { name: /expand tsukiji sushi/i })
    await userEvent.click(activityCard)
    const editorHeader = screen.getByText(/^edit activity$/i).parentElement
    expect(editorHeader).not.toBeNull()
    expect(within(editorHeader as HTMLElement).getByRole('button', { name: /^close activity editor$/i }))
      .toBeInTheDocument()
    expect(within(editorHeader as HTMLElement).queryByRole('button', { name: /^change day$/i }))
      .not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^done$/i })).not.toBeInTheDocument()
    expect(within(activityCard).getByRole('heading', { name: /tsukiji sushi/i })).toBeInTheDocument()
    const firstChangeDay = screen.getByRole('button', { name: /^change day$/i })
    const editFooter = firstChangeDay.parentElement
    expect(editFooter).not.toBeNull()
    expect(within(editFooter as HTMLElement).getByRole('button', { name: /^delete$/i }))
      .toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^close activity editor$/i }))
    await waitFor(() => {
      expect(screen.getByRole('article', { name: /expand tsukiji sushi/i })).toHaveFocus()
    })

    await userEvent.click(screen.getByRole('article', { name: /expand tsukiji sushi/i }))
    expect(screen.getByText(/^edit activity$/i)).toBeInTheDocument()
    const changeDay = screen.getByRole('button', { name: /^change day$/i })
    expect(changeDay).toBeInTheDocument()
    vi.spyOn(changeDay, 'getBoundingClientRect').mockReturnValue(domRect({
      bottom: 744,
      left: 220,
      right: 360,
      top: 700,
    }))

    await userEvent.click(changeDay)
    const moveDialog = screen.getByRole('dialog', { name: /move tsukiji sushi/i })
    expect(moveDialog).toHaveAttribute('data-placement', 'above')
    expect(moveDialog).toHaveStyle({
      bottom: '152px',
      left: '18px',
      maxHeight: '672px',
      width: '360px',
    })
    expect(screen.getByRole('button', { name: /close day picker/i })).toHaveFocus()

    await userEvent.click(screen.getByTitle('2026-05-02 (0 activities)'))
    await waitFor(() => {
      expect(apiMock.history.post.some((request) => request.url?.startsWith('/activities/10/move'))).toBe(true)
      expect(screen.getByTestId('current-location')).toHaveTextContent('/trips/abc234def567/d/2026-05-02')
    })
  })

  it('flushes a pending mobile edit before closing without a duplicate update', async () => {
    mockViewport(true)
    mockWorkspace([SAMPLE_ACTIVITY])
    apiMock.onPatch('/trips/abc234def567/activities/10').reply((config) => {
      const payload = JSON.parse(config.data as string)
      return [200, { ...SAMPLE_ACTIVITY, ...payload, version: 1 }]
    })

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await userEvent.click(await screen.findByRole('article', { name: /expand tsukiji sushi/i }))
    const titleInput = screen.getByLabelText(/activity name/i)
    await userEvent.clear(titleInput)
    await userEvent.type(titleInput, 'Quick sushi edit')
    expect(screen.getByRole('status')).toHaveTextContent('Saving\u2026')

    await userEvent.click(screen.getByRole('button', { name: /^close activity editor$/i }))

    await waitFor(() => {
      expect(apiMock.history.patch).toHaveLength(1)
      expect(JSON.parse(apiMock.history.patch[0].data as string)).toMatchObject({
        title: 'Quick sushi edit',
      })
      expect(screen.getByRole('article', { name: /expand quick sushi edit/i })).toBeInTheDocument()
    })
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 750))
    })
    expect(apiMock.history.patch).toHaveLength(1)
  })

  it('keeps the mobile editor open after an autosave error and retries the latest edit', async () => {
    mockViewport(true)
    mockWorkspace([SAMPLE_ACTIVITY])
    let attempts = 0
    apiMock.onPatch('/trips/abc234def567/activities/10').reply((config) => {
      attempts += 1
      if (attempts === 1) return [500, { message: 'Temporary failure' }]
      const payload = JSON.parse(config.data as string)
      return [200, { ...SAMPLE_ACTIVITY, ...payload, version: 1 }]
    })

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await userEvent.click(await screen.findByRole('article', { name: /expand tsukiji sushi/i }))
    const titleInput = screen.getByLabelText(/activity name/i)
    await userEvent.clear(titleInput)
    await userEvent.type(titleInput, 'Retry sushi edit')
    await userEvent.click(screen.getByRole('button', { name: /^close activity editor$/i }))

    expect(await screen.findByText('Couldn\u2019t save changes.'))
      .toBeInTheDocument()
    expect(screen.getByRole('article', { name: /collapse tsukiji sushi/i })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^retry$/i }))

    await waitFor(() => {
      expect(apiMock.history.patch).toHaveLength(2)
      expect(screen.getByRole('status')).toHaveTextContent(/^saved$/i)
    })
    expect(JSON.parse(apiMock.history.patch[1].data as string)).toMatchObject({
      title: 'Retry sushi edit',
    })
  })

  it('keeps the mobile editor open when its required name is invalid', async () => {
    mockViewport(true)
    mockWorkspace([SAMPLE_ACTIVITY])

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await userEvent.click(await screen.findByRole('article', { name: /expand tsukiji sushi/i }))
    await userEvent.clear(screen.getByLabelText(/activity name/i))
    await userEvent.click(screen.getByRole('button', { name: /^close activity editor$/i }))

    expect(screen.getByText('Activity name is required.')).toBeInTheDocument()
    expect(screen.getByRole('article', { name: /collapse tsukiji sushi/i })).toBeInTheDocument()
    expect(apiMock.history.patch).toHaveLength(0)
  })

  it('clears sortable positioning while the mobile activity editor is expanded', async () => {
    mockViewport(true)
    dndMockState.sortableTransform = { x: 12, y: 18, scaleX: 1, scaleY: 1 }
    dndMockState.sortableTransition = 'transform 200ms ease'
    mockWorkspace([SAMPLE_ACTIVITY])

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    const collapsedCard = await screen.findByRole('article', { name: /expand tsukiji sushi/i })
    const collapsedSlot = collapsedCard.parentElement as HTMLElement
    expect(collapsedSlot.style.transform).toBe('translate3d(12px, 18px, 0)')
    expect(collapsedSlot.style.transition).toBe('transform 200ms ease')

    await userEvent.click(collapsedCard)

    const expandedCard = screen.getByRole('article', { name: /collapse tsukiji sushi/i })
    const expandedSlot = expandedCard.parentElement as HTMLElement
    expect(expandedSlot.style.transform).toBe('')
    expect(expandedSlot.style.transition).toBe('')
    expect(screen.getByText(/^edit activity$/i)).toBeInTheDocument()
  })

  it('keeps mobile viewer cards free of edit and move actions', async () => {
    mockViewport(true)
    mockWorkspace([SAMPLE_ACTIVITY], { ...SAMPLE_TRIP, role: 'VIEWER' })

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByRole('heading', { level: 2, name: /friday, may 1/i })
    expect(screen.queryByRole('button', { name: /edit tsukiji sushi/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /move to day/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /change day/i })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('article', { name: /expand tsukiji sushi/i }))
    expect(screen.queryByRole('button', { name: /change day/i })).not.toBeInTheDocument()
  })

  it('preserves the mobile Ideas schedule quick action', async () => {
    const savedIdea = {
      ...SAMPLE_ACTIVITY,
      id: 33,
      dayDate: null,
      title: 'Save teamLab',
      orderIndex: 0,
    }
    mockViewport(true)
    mockWorkspace([savedIdea])

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByRole('heading', { level: 2, name: /friday, may 1/i })
    await userEvent.click(screen.getByRole('button', { name: /^ideas$/i }))
    expect(screen.getByRole('button', { name: /^schedule$/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /edit save teamlab/i })).not.toBeInTheDocument()
    expect(screen.getByRole('article', { name: /expand save teamlab/i })).toBeInTheDocument()

    const schedule = screen.getByRole('button', { name: /^schedule$/i })
    vi.spyOn(schedule, 'getBoundingClientRect').mockReturnValue(domRect({
      bottom: 236,
      left: 244,
      right: 360,
      top: 192,
    }))
    await userEvent.click(schedule)
    const scheduleDialog = screen.getByRole('dialog', { name: /move save teamlab/i })
    expect(scheduleDialog).toHaveAttribute('data-placement', 'below')
    expect(scheduleDialog).toHaveStyle({
      left: '18px',
      maxHeight: '588px',
      top: '244px',
      width: '360px',
    })
  })

  it('renders workspace shell when trip is loaded', async () => {
    mockWorkspace()

    renderWorkspace('/trips/abc234def567')

    expect(await screen.findByRole('heading', { level: 1, name: /tokyo 2026/i })).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('current-location')).toHaveTextContent('/trips/abc234def567/d/2026-05-01')
    })
    expect(screen.getByRole('heading', { level: 2, name: /friday, may 1/i })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Dupert/i })).toHaveAttribute('href', '/trips')
    expect(screen.getByRole('link', { name: /^tokyo 2026$/i })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: /^pin sidebar$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^settings$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /share trip/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^account$/i })).not.toBeInTheDocument()
    expect(screen.getByText(/Tokyo, Japan/)).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /may 2026/i })).toBeInTheDocument()
    expect(screen.getByTitle('2026-05-01 (0 activities)')).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: /^timeline$/i })).toHaveAttribute('aria-pressed', 'false')
    expect(await screen.findByText(/no activities planned for this day/i)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^days$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^calendar$/i })).not.toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /day schedule/i })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /^notes$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /^map$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /search results/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/ready to add/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^title$/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/day note/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/selected day summary/i)).not.toBeInTheDocument()
  })

  it('keeps reusable URLs out of listed share links while showing a newly created URL once', async () => {
    mockWorkspace()
    apiMock.onGet('/trips/abc234def567/members').reply(200, [
      {
        userId: 42,
        email: 'alice@example.com',
        displayName: 'Alice',
        role: 'OWNER',
      },
    ])
    apiMock.onGet('/trips/abc234def567/share-links').reply(200, [
      {
        id: 7,
        name: 'Existing invite',
        role: 'EDITOR',
        allowAnonymous: false,
        createdAt: '2026-05-22T16:00:00Z',
        expiresAt: null,
        revokedAt: null,
      },
    ])
    apiMock.onPost('/trips/abc234def567/share-links').reply(201, {
      id: 8,
      name: 'Trip invite',
      role: 'EDITOR',
      allowAnonymous: false,
      createdAt: '2026-05-22T16:00:00Z',
      expiresAt: null,
      revokedAt: null,
      shareUrl: 'https://app.example.com/share/new-token',
    })

    renderWorkspace('/trips/abc234def567')

    await screen.findByRole('heading', { level: 1, name: /tokyo 2026/i })
    await userEvent.click(screen.getByRole('button', { name: /share trip/i }))

    expect(await screen.findByDisplayValue('Existing invite')).toBeInTheDocument()
    expect(screen.getByText(/URLs are shown only when a link is created/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /copy url/i })).toBeDisabled()

    await userEvent.click(screen.getByRole('button', { name: /^create link$/i }))

    expect(await screen.findByDisplayValue('https://app.example.com/share/new-token')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /copy url/i })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /copy url/i }).some(
      (button) => !button.hasAttribute('disabled'),
    )).toBe(true)
  })

  it('shows guest users links to save the trip after signing in or creating an account', async () => {
    mockWorkspace()

    renderWorkspace('/trips/abc234def567')

    await waitFor(() => {
      expect(screen.getByTestId('current-location')).toHaveTextContent('/trips/abc234def567/d/2026-05-01')
    })

    const expectedReturn = encodeURIComponent('/trips/abc234def567/d/2026-05-01?claimGuest=1')
    expect(screen.getByRole('link', { name: /sign in to save/i })).toHaveAttribute(
      'href',
      `/login?return=${expectedReturn}`,
    )
    expect(screen.getByRole('link', { name: /create account/i })).toHaveAttribute(
      'href',
      `/register?return=${expectedReturn}`,
    )
  })

  it('claims a guest trip before loading it for an authenticated user', async () => {
    const claimedTrip = { ...SAMPLE_TRIP, role: 'VIEWER' as const }
    useAuthStore.getState().setSession({
      accessToken: 'jwt-access-token',
      expiresInSeconds: 900,
      user: {
        id: 200,
        email: 'bob@example.com',
        displayName: 'Bob',
        emailVerified: true,
      },
    })
    apiMock.onPost('/guest-session/claim').reply(200, claimedTrip)
    apiMock.onGet('/trips/abc234def567').reply(200, claimedTrip)
    apiMock.onGet('/trips/abc234def567/activities').reply(200, [])

    renderWorkspace('/trips/abc234def567?claimGuest=1')

    await waitFor(() => {
      expect(apiMock.history.post.some((request) => request.url === '/guest-session/claim')).toBe(true)
    })
    await screen.findByText(/trip saved to my trips/i)
    await waitFor(() => {
      expect(screen.getByTestId('current-location')).toHaveTextContent('/trips/abc234def567/d/2026-05-01')
    })

    expect(screen.queryByRole('link', { name: /sign in to save/i })).not.toBeInTheDocument()
    expect(queryClient.getQueryData(['trips', 'list'])).toEqual([claimedTrip])
    expect(queryClient.getQueryData(['trips', 'detail', 'abc234def567'])).toEqual(claimedTrip)
  })

  it('shows a generic error when claiming a guest trip fails', async () => {
    useAuthStore.getState().setSession({
      accessToken: 'jwt-access-token',
      expiresInSeconds: 900,
      user: {
        id: 200,
        email: 'bob@example.com',
        displayName: 'Bob',
        emailVerified: true,
      },
    })
    apiMock.onPost('/guest-session/claim').reply(404, { error: 'not_found' })

    renderWorkspace('/trips/abc234def567?claimGuest=1')

    expect(await screen.findByRole('heading', { name: /could not save trip/i })).toBeInTheDocument()
    expect(screen.getByText(/link may have expired/i)).toBeInTheDocument()
    expect(apiMock.history.get).toHaveLength(0)
  })

  it('collapses the pinned sidebar when the timeline tab is selected', async () => {
    mockWorkspace()

    renderWorkspace('/trips/abc234def567')

    await screen.findByRole('heading', { level: 1, name: /tokyo 2026/i })
    await userEvent.click(screen.getByRole('button', { name: /^pin sidebar$/i }))
    expect(screen.getByRole('button', { name: /^unpin sidebar$/i })).toHaveAttribute('aria-pressed', 'true')

    await userEvent.click(screen.getByRole('button', { name: /^timeline$/i }))

    expect(screen.getByRole('button', { name: /^pin sidebar$/i })).toHaveAttribute('aria-pressed', 'false')
    expect(screen.getByRole('button', { name: /^timeline$/i })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('heading', { name: /full trip timeline/i })).toBeInTheDocument()

    expect(screen.queryByRole('button', { name: /^calendar$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^days$/i })).not.toBeInTheDocument()
  })

  it('shows deep-linked day when /d/:day is present', async () => {
    mockWorkspace()

    renderWorkspace('/trips/abc234def567/d/2026-05-03')

    expect(await screen.findByTitle('2026-05-03 (0 activities)')).toHaveAttribute('aria-pressed', 'true')
  })

  it('switches the workspace when a day rail item is selected', async () => {
    const dayTwoActivity = {
      ...SAMPLE_ACTIVITY,
      id: 22,
      dayDate: '2026-05-02',
      title: 'Tokyo Tower',
      notes: 'Sunset slot',
      lat: 35.6586,
      lng: 139.7454,
      orderIndex: 0,
    }
    apiMock.onGet('/trips/abc234def567').reply(200, SAMPLE_TRIP)
    apiMock.onGet('/trips/abc234def567/activities').reply(200, [SAMPLE_ACTIVITY, dayTwoActivity])

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    expect(await screen.findByRole('heading', { name: /friday, may 1/i })).toBeInTheDocument()
    await userEvent.click(screen.getByTitle('2026-05-02 (1 activities)'))

    expect(screen.queryByTitle('2026-05-02 (1 activities)')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Calendar')).toBeInTheDocument()
    expect(screen.getAllByText('Tokyo Tower').length).toBeGreaterThan(0)
    expect(screen.queryByLabelText(/day note/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/selected day summary/i)).not.toBeInTheDocument()

    const selectedMapActivities = within(screen.getByTestId('selected-map-activities'))
    expect(selectedMapActivities.getByText('Tokyo Tower')).toBeInTheDocument()
    expect(selectedMapActivities.queryByText('Tsukiji sushi')).not.toBeInTheDocument()
  })

  it('focuses the activity name field when opening a new day activity composer', async () => {
    mockWorkspace()

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByRole('heading', { level: 2, name: /friday, may 1/i })
    await userEvent.click(screen.getAllByRole('button', { name: /^add activity$/i })[0])

    const nameInput = screen.getByRole('textbox', { name: /activity name/i })
    await waitFor(() => {
      expect(nameInput).toHaveFocus()
    })
  })

  it('jumps to the target day after dragging an activity to another day', async () => {
    const dayTwoActivity = {
      ...SAMPLE_ACTIVITY,
      id: 22,
      dayDate: '2026-05-02',
      title: 'Tokyo Tower',
      notes: 'Sunset slot',
      orderIndex: 0,
    }
    mockWorkspace([SAMPLE_ACTIVITY, dayTwoActivity])
    apiMock.onPost('/activities/10/move?publicId=abc234def567').reply((config) => {
      expect(JSON.parse(config.data as string)).toEqual({
        dayDate: '2026-05-02',
        orderIndex: 1,
      })
      return [200, {
        ...SAMPLE_ACTIVITY,
        dayDate: '2026-05-02',
        orderIndex: 1,
      }]
    })

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    expect(await screen.findByRole('heading', { level: 2, name: /friday, may 1/i })).toBeInTheDocument()

    triggerDragEnd(activityDragId(10), sidebarDayDropId('2026-05-02'))

    expect(await screen.findByRole('heading', { level: 2, name: /saturday, may 2/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /day schedule/i })).toBeInTheDocument()
    expect(screen.getByText(/2 activities scheduled today/i)).toBeInTheDocument()
    expect(screen.getByRole('article', { name: /expand tsukiji sushi/i })).toBeInTheDocument()
    await waitFor(() => {
      expect(document.activeElement).toHaveAttribute('id', 'activity-10')
    })
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('uses the painted sidebar day under the pointer and clears a stale target over a gap', async () => {
    const dayTwoActivity = {
      ...SAMPLE_ACTIVITY,
      id: 22,
      dayDate: '2026-05-02',
      title: 'Tokyo Tower',
      orderIndex: 0,
    }
    mockWorkspace([SAMPLE_ACTIVITY, dayTwoActivity])

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByRole('heading', { level: 2, name: /friday, may 1/i })
    const sidebar = screen.getByLabelText('Trip workspace navigation')
    vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue(domRect({
      bottom: 700,
      left: 0,
      right: 300,
      top: 0,
    }))
    const paintedDay = screen.getByTitle('2026-05-02 (1 activities)')
    expect(paintedDay).not.toHaveAttribute('data-sidebar-drop-target')

    triggerDragStart(activityDragId(10), 400, 200)
    const paintedDayChild = paintedDay.querySelector('span')
    expect(paintedDayChild).not.toBeNull()
    expect(paintedDay).toHaveAttribute(
      'data-sidebar-drop-target',
      sidebarDayDropId('2026-05-02'),
    )
    vi.mocked(document.elementFromPoint).mockReturnValue(paintedDayChild)
    dndMockState.pointerCollisions = [{ id: sidebarDayDropId('2026-05-03') }]
    expect(runCollisionDetection(activityDragId(10), { x: 120, y: 400 })).toEqual([
      { id: sidebarDayDropId('2026-05-02') },
    ])
    triggerDragOver(activityDragId(10), sidebarDayDropId('2026-05-02'))

    vi.mocked(document.elementFromPoint).mockReturnValue(null)
    dndMockState.pointerCollisions = [{ id: sidebarDayDropId('2026-05-02') }]
    expect(runCollisionDetection(activityDragId(10), { x: 120, y: 440 })).toEqual([])
    triggerDragOver(activityDragId(10), null)
    triggerDragEnd(activityDragId(10), null)

    expect(screen.getByTestId('current-location')).toHaveTextContent(
      '/trips/abc234def567/d/2026-05-01',
    )
    expect(apiMock.history.post.some((request) => request.url?.startsWith('/activities/10/move')))
      .toBe(false)
  })

  it('keeps the fixed drag overlay wrapper out of pointer hit testing', async () => {
    mockWorkspace([SAMPLE_ACTIVITY])

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByRole('heading', { level: 2, name: /friday, may 1/i })
    triggerDragStart(activityDragId(10), 400, 200)

    expect(screen.getByTestId('drag-overlay')).toHaveTextContent(/tsukiji sushi/i)
    expect(dndMockState.dragOverlayStyle).toEqual({ pointerEvents: 'none' })
  })

  it('rejects an out-of-range sidebar calendar day under the pointer', async () => {
    mockWorkspace([SAMPLE_ACTIVITY])

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByRole('heading', { level: 2, name: /friday, may 1/i })
    const sidebar = screen.getByLabelText('Trip workspace navigation')
    vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue(domRect({
      bottom: 700,
      left: 0,
      right: 300,
      top: 0,
    }))
    const outOfRangeDay = screen.getByTitle('2026-04-30 (0 activities)')
    expect(outOfRangeDay).toBeDisabled()
    expect(outOfRangeDay).not.toHaveAttribute('data-sidebar-drop-target')

    triggerDragStart(activityDragId(10), 400, 200)
    expect(outOfRangeDay).not.toHaveAttribute('data-sidebar-drop-target')
    vi.mocked(document.elementFromPoint).mockReturnValue(outOfRangeDay.querySelector('span'))
    dndMockState.pointerCollisions = [{ id: sidebarDayDropId('2026-05-02') }]

    expect(runCollisionDetection(activityDragId(10), { x: 120, y: 400 })).toEqual([])
  })

  it('accepts the enabled Ideas rail target at the exact pointer position', async () => {
    mockWorkspace([SAMPLE_ACTIVITY])

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByRole('heading', { level: 2, name: /friday, may 1/i })
    const sidebar = screen.getByLabelText('Trip workspace navigation')
    vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue(domRect({
      bottom: 700,
      left: 0,
      right: 300,
      top: 0,
    }))
    const ideasButton = screen.getByRole('button', { name: /^ideas$/i })
    expect(ideasButton).not.toHaveAttribute('data-sidebar-drop-target')

    triggerDragStart(activityDragId(10), 400, 200)
    expect(ideasButton).toHaveAttribute('data-sidebar-drop-target', sidebarIdeasDropId())
    vi.mocked(document.elementFromPoint).mockReturnValue(ideasButton.querySelector('span'))
    dndMockState.pointerCollisions = [{ id: sidebarDayDropId('2026-05-02') }]

    expect(runCollisionDetection(activityDragId(10), { x: 120, y: 400 })).toEqual([
      { id: sidebarIdeasDropId() },
    ])
  })

  it('excludes calendar days from pointer proximity fallback but keeps sortable and keyboard fallback', async () => {
    const secondActivity = {
      ...SAMPLE_ACTIVITY,
      id: 11,
      title: 'Morning market',
      orderIndex: 1,
    }
    mockWorkspace([SAMPLE_ACTIVITY, secondActivity])

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByRole('heading', { level: 2, name: /friday, may 1/i })
    const sidebar = screen.getByLabelText('Trip workspace navigation')
    vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue(domRect({
      bottom: 700,
      left: 0,
      right: 300,
      top: 0,
    }))
    dndMockState.pointerCollisions = []
    dndMockState.closestCenterCollisions = [
      { id: sidebarDayDropId('2026-05-02') },
      { id: activityDragId(11) },
    ]

    expect(runCollisionDetection(activityDragId(10), { x: 500, y: 400 })).toEqual([
      { id: activityDragId(11) },
    ])

    dndMockState.closestCenterCollisions = [{ id: sidebarDayDropId('2026-05-02') }]
    expect(runCollisionDetection(activityDragId(10), null)).toEqual([
      { id: sidebarDayDropId('2026-05-02') },
    ])
  })

  it('uses the last valid drop target when an activity drop ends with no current target', async () => {
    const dayTwoActivity = {
      ...SAMPLE_ACTIVITY,
      id: 22,
      dayDate: '2026-05-02',
      title: 'Tokyo Tower',
      notes: 'Sunset slot',
      orderIndex: 0,
    }
    mockWorkspace([SAMPLE_ACTIVITY, dayTwoActivity])
    apiMock.onPost('/activities/10/move?publicId=abc234def567').reply((config) => {
      expect(JSON.parse(config.data as string)).toEqual({
        dayDate: '2026-05-02',
        orderIndex: 1,
      })
      return [200, {
        ...SAMPLE_ACTIVITY,
        dayDate: '2026-05-02',
        orderIndex: 1,
      }]
    })

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    expect(await screen.findByRole('heading', { level: 2, name: /friday, may 1/i })).toBeInTheDocument()

    triggerDragStart(activityDragId(10))
    triggerDragOver(activityDragId(10), sidebarDayDropId('2026-05-02'))
    triggerDragEnd(activityDragId(10), null)

    expect(await screen.findByRole('heading', { level: 2, name: /saturday, may 2/i })).toBeInTheDocument()
    expect(screen.getByRole('article', { name: /expand tsukiji sushi/i })).toBeInTheDocument()
  })

  it('keeps the last sortable activity target across a transient null drag-over', async () => {
    const secondActivity = {
      ...SAMPLE_ACTIVITY,
      id: 11,
      title: 'Morning market',
      orderIndex: 1,
    }
    mockWorkspace([SAMPLE_ACTIVITY, secondActivity])
    apiMock.onPost('/trips/abc234def567/days/2026-05-01/order').reply((config) => {
      expect(JSON.parse(config.data as string)).toEqual({ activityIds: [11, 10] })
      return [204]
    })

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByRole('heading', { level: 2, name: /friday, may 1/i })
    triggerDragStart(activityDragId(11))
    triggerDragOver(activityDragId(11), activityDragId(10))
    triggerDragOver(activityDragId(11), null)
    triggerDragEnd(activityDragId(11), null)

    await waitFor(() => {
      expect(apiMock.history.post.some(
        (request) => request.url === '/trips/abc234def567/days/2026-05-01/order',
      )).toBe(true)
    })
  })

  it('jumps to Ideas after dragging a scheduled activity to ideas', async () => {
    const savedIdea = {
      ...SAMPLE_ACTIVITY,
      id: 33,
      dayDate: null,
      title: 'Save teamLab',
      orderIndex: 0,
    }
    mockWorkspace([SAMPLE_ACTIVITY, savedIdea])
    apiMock.onPost('/activities/10/move?publicId=abc234def567').reply((config) => {
      expect(JSON.parse(config.data as string)).toEqual({
        dayDate: null,
        orderIndex: 1,
      })
      return [200, {
        ...SAMPLE_ACTIVITY,
        dayDate: null,
        orderIndex: 1,
      }]
    })

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    expect(await screen.findByRole('heading', { level: 2, name: /friday, may 1/i })).toBeInTheDocument()

    triggerDragEnd(activityDragId(10), sidebarIdeasDropId())

    expect(await screen.findByRole('heading', { level: 2, name: /^ideas$/i })).toBeInTheDocument()
    const ideasSection = screen.getByRole('heading', { name: /saved ideas/i }).closest('section')
    expect(ideasSection).not.toBeNull()
    expect(within(ideasSection as HTMLElement).getByRole('article', { name: /expand tsukiji sushi/i }))
      .toBeInTheDocument()
    await waitFor(() => {
      expect(document.activeElement).toHaveAttribute('id', 'activity-10')
    })
    expect(within(ideasSection as HTMLElement).getByRole('article', { name: /expand tsukiji sushi/i }))
      .toHaveAttribute('aria-expanded', 'false')
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('keeps the current day after same-day drag reorder', async () => {
    const secondDayOneActivity = {
      ...SAMPLE_ACTIVITY,
      id: 11,
      title: 'Morning market',
      orderIndex: 1,
    }
    mockWorkspace([SAMPLE_ACTIVITY, secondDayOneActivity])
    apiMock.onPost('/trips/abc234def567/days/2026-05-01/order').reply((config) => {
      expect(JSON.parse(config.data as string)).toEqual({
        activityIds: [11, 10],
      })
      return [204]
    })

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    expect(await screen.findByRole('heading', { level: 2, name: /friday, may 1/i })).toBeInTheDocument()

    triggerDragEnd(activityDragId(11), activityDragId(10))

    expect(screen.getByRole('heading', { level: 2, name: /friday, may 1/i })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { level: 2, name: /saturday, may 2/i })).not.toBeInTheDocument()
    expect(apiMock.history.post.some((request) => request.url?.startsWith('/activities/11/move')))
      .toBe(false)
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled()
  })

  it('opens sidebar calendar pick mode before scheduling a saved idea', async () => {
    const savedIdea = {
      ...SAMPLE_ACTIVITY,
      id: 33,
      dayDate: null,
      title: 'Save teamLab',
      orderIndex: 0,
    }
    mockWorkspace([savedIdea])

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByRole('heading', { level: 2, name: /friday, may 1/i })
    await userEvent.click(screen.getByRole('button', { name: /^ideas$/i }))
    await userEvent.click(screen.getByRole('button', { name: /^schedule$/i }))

    expect(screen.getByText(/choose a day for/i)).toHaveTextContent('Choose a day for Save teamLab')
    expect(screen.getByRole('button', { name: /cancel scheduling save teamlab/i })).toBeInTheDocument()
    expect(apiMock.history.post.some((request) => request.url?.startsWith('/activities/33/move')))
      .toBe(false)

    await userEvent.click(screen.getByRole('button', { name: /cancel scheduling save teamlab/i }))
    expect(screen.queryByText(/choose a day for/i)).not.toBeInTheDocument()
  })

  it('schedules a saved idea after a sidebar calendar day is selected', async () => {
    const savedIdea = {
      ...SAMPLE_ACTIVITY,
      id: 33,
      dayDate: null,
      title: 'Save teamLab',
      orderIndex: 0,
    }
    const dayTwoActivity = {
      ...SAMPLE_ACTIVITY,
      id: 22,
      dayDate: '2026-05-02',
      title: 'Tokyo Tower',
      orderIndex: 0,
    }
    mockWorkspace([savedIdea, dayTwoActivity])
    apiMock.onPost('/activities/33/move?publicId=abc234def567').reply((config) => {
      expect(JSON.parse(config.data as string)).toEqual({
        dayDate: '2026-05-02',
        orderIndex: 1,
      })
      return [200, {
        ...savedIdea,
        dayDate: '2026-05-02',
        orderIndex: 1,
      }]
    })

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByRole('heading', { level: 2, name: /friday, may 1/i })
    await userEvent.click(screen.getByRole('button', { name: /^ideas$/i }))
    await userEvent.click(screen.getByRole('button', { name: /^schedule$/i }))
    await userEvent.click(screen.getByTitle('2026-05-02 (1 activities)'))

    expect(await screen.findByRole('heading', { level: 2, name: /saturday, may 2/i })).toBeInTheDocument()
    expect(screen.queryByText(/choose a day for/i)).not.toBeInTheDocument()
    expect(screen.getByRole('article', { name: /expand save teamlab/i })).toBeInTheDocument()
    await waitFor(() => {
      expect(document.activeElement).toHaveAttribute('id', 'activity-33')
    })
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled()
  })

  it('expands the sidebar only after the dragged card enters it', async () => {
    mockWorkspace([SAMPLE_ACTIVITY])

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByRole('heading', { level: 2, name: /friday, may 1/i })
    const sidebar = screen.getByLabelText('Trip workspace navigation')
    const activityCard = document.getElementById('activity-10')
    expect(activityCard).not.toBeNull()
    vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue(domRect({
      bottom: 700,
      left: 0,
      right: 64,
      top: 0,
    }))
    vi.spyOn(activityCard as HTMLElement, 'getBoundingClientRect').mockReturnValue(domRect({
      bottom: 150,
      left: 80,
      right: 320,
      top: 100,
    }))

    triggerDragStart(activityDragId(10), 96, 120)
    expect(within(screen.getByTestId('drag-overlay')).getByText('Tsukiji sushi')).toBeInTheDocument()
    triggerDragMove(activityDragId(10), { x: -10, y: 0 })

    expect(sidebar.className).not.toMatch(/dayPanelDragExpanded/)

    triggerDragMove(activityDragId(10), { x: -20, y: 0 })

    expect(sidebar.className).toMatch(/dayPanelDragExpanded/)
  })

  it('exports the selected mapped day stops to Google Maps in itinerary order', async () => {
    const breakfast = {
      ...SAMPLE_ACTIVITY,
      id: 11,
      title: 'Breakfast',
      placeId: 'google.breakfast',
      lat: 35.6586,
      lng: 139.7454,
      orderIndex: 0,
    }
    const unmappedStop = {
      ...SAMPLE_ACTIVITY,
      id: 12,
      title: 'Unmapped note',
      orderIndex: 1,
    }
    const lunch = {
      ...SAMPLE_ACTIVITY,
      id: 13,
      title: 'Lunch',
      placeId: 'google.lunch',
      lat: 35.6654,
      lng: 139.7707,
      orderIndex: 2,
    }
    const otherDayStop = {
      ...SAMPLE_ACTIVITY,
      id: 14,
      dayDate: '2026-05-02',
      title: 'Other day',
      lat: 35.6762,
      lng: 139.6503,
      orderIndex: 0,
    }
    mockWorkspace([breakfast, unmappedStop, lunch, otherDayStop])

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    const exportLink = await screen.findByRole('link', { name: /export day/i })
    const url = new URL(exportLink.getAttribute('href') ?? '')

    expect(url.origin + url.pathname).toBe('https://www.google.com/maps/dir/')
    expect(url.searchParams.get('api')).toBe('1')
    expect(url.searchParams.get('travelmode')).toBe('driving')
    expect(url.searchParams.get('origin')).toBe('35.6586,139.7454')
    expect(url.searchParams.get('destination')).toBe('35.6654,139.7707')
    expect(url.searchParams.get('waypoints')).toBeNull()
    expect(exportLink).toHaveAttribute('target', '_blank')
  })

  it('passes only selected-day activities to the map', async () => {
    const dayTwoActivity = {
      ...SAMPLE_ACTIVITY,
      id: 22,
      dayDate: '2026-05-02',
      title: 'Tokyo Tower',
      lat: 35.6586,
      lng: 139.7454,
      orderIndex: 0,
    }
    mockWorkspace([SAMPLE_ACTIVITY, dayTwoActivity])

    renderWorkspace('/trips/abc234def567/d/2026-05-02')

    const map = await screen.findByTestId('trip-map')
    const selectedMapActivities = within(screen.getByTestId('selected-map-activities'))
    const fallbackMapActivities = within(screen.getByTestId('fallback-map-activities'))
    const routeMapActivities = within(screen.getByTestId('route-map-activities'))
    expect(map).toBeInTheDocument()
    expect(selectedMapActivities.getByText('Tokyo Tower')).toBeInTheDocument()
    expect(selectedMapActivities.queryByText('Tsukiji sushi')).not.toBeInTheDocument()
    expect(fallbackMapActivities.queryByText('Tokyo Tower')).not.toBeInTheDocument()
    expect(fallbackMapActivities.queryByText('Tsukiji sushi')).not.toBeInTheDocument()
    expect(routeMapActivities.getByText('Tokyo Tower')).toBeInTheDocument()
    expect(routeMapActivities.queryByText('Tsukiji sushi')).not.toBeInTheDocument()
    expect(screen.getByText(/1 activity scheduled today/i)).toBeInTheDocument()
    expect(screen.queryByText(/mapped stop in view/i)).not.toBeInTheDocument()
  })

  it('toggles selected-day route activities without changing map markers', async () => {
    const lunch = {
      ...SAMPLE_ACTIVITY,
      id: 12,
      title: 'Lunch stop',
      lat: 35.6654,
      lng: 139.7707,
      orderIndex: 1,
    }
    mockWorkspace([SAMPLE_ACTIVITY, lunch])

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByTestId('trip-map')
    const selectedMapActivities = within(screen.getByTestId('selected-map-activities'))
    const routeMapActivities = within(screen.getByTestId('route-map-activities'))
    const routesToggle = screen.getByRole('checkbox', { name: /routes/i })

    expect(routesToggle).toBeChecked()
    expect(selectedMapActivities.getByText('Tsukiji sushi')).toBeInTheDocument()
    expect(selectedMapActivities.getByText('Lunch stop')).toBeInTheDocument()
    expect(routeMapActivities.getByText('Tsukiji sushi')).toBeInTheDocument()
    expect(routeMapActivities.getByText('Lunch stop')).toBeInTheDocument()

    await userEvent.click(routesToggle)

    expect(routesToggle).not.toBeChecked()
    expect(selectedMapActivities.getByText('Tsukiji sushi')).toBeInTheDocument()
    expect(selectedMapActivities.getByText('Lunch stop')).toBeInTheDocument()
    expect(routeMapActivities.queryByText('Tsukiji sushi')).not.toBeInTheDocument()
    expect(routeMapActivities.queryByText('Lunch stop')).not.toBeInTheDocument()

    await userEvent.click(routesToggle)

    expect(routesToggle).toBeChecked()
    expect(routeMapActivities.getByText('Tsukiji sushi')).toBeInTheDocument()
    expect(routeMapActivities.getByText('Lunch stop')).toBeInTheDocument()
  })

  it('does not show other-day markers as fallback when the selected day has no mapped activities', async () => {
    const dayOneMappedActivity = {
      ...SAMPLE_ACTIVITY,
      placeId: 'google.tsukiji',
      placeName: 'Tsukiji sushi',
      address: 'Tsukiji, Chuo City, Tokyo',
      lat: 35.6654,
      lng: 139.7707,
    }
    mockWorkspace([dayOneMappedActivity])

    renderWorkspace('/trips/abc234def567/d/2026-05-02')

    await screen.findByTestId('trip-map')
    const selectedMapActivities = within(screen.getByTestId('selected-map-activities'))
    const fallbackMapActivities = within(screen.getByTestId('fallback-map-activities'))
    const routeMapActivities = within(screen.getByTestId('route-map-activities'))
    expect(selectedMapActivities.queryByText('Tsukiji sushi')).not.toBeInTheDocument()
    expect(fallbackMapActivities.queryByText('Tsukiji sushi')).not.toBeInTheDocument()
    expect(routeMapActivities.queryByText('Tsukiji sushi')).not.toBeInTheDocument()
    expect(screen.getByText(/0 activities scheduled today/i)).toBeInTheDocument()
  })

  it('switches to a full-trip timeline and maps all trip activities', async () => {
    const dayOneActivity = {
      ...SAMPLE_ACTIVITY,
      placeId: 'google.tsukiji',
      placeName: 'Tsukiji sushi',
      address: 'Tsukiji, Chuo City, Tokyo',
      lat: 35.6654,
      lng: 139.7707,
    }
    const dayTwoActivity = {
      ...SAMPLE_ACTIVITY,
      id: 22,
      dayDate: '2026-05-02',
      title: 'Tokyo Tower',
      lat: 35.6586,
      lng: 139.7454,
      orderIndex: 0,
    }
    mockWorkspace([dayOneActivity, dayTwoActivity])

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByRole('heading', { level: 1, name: /tokyo 2026/i })
    await userEvent.click(screen.getByRole('button', { name: /^timeline$/i }))

    expect(screen.getByRole('button', { name: /^timeline$/i })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('heading', { name: /full trip timeline/i })).toBeInTheDocument()
    expect(screen.getByText(/2 scheduled activities across 2 days/i)).toBeInTheDocument()

    const fullTimeline = screen.getByLabelText(/trip days timeline/i)
    expect(within(fullTimeline).getByText('Tsukiji sushi')).toBeInTheDocument()
    expect(within(fullTimeline).getByText('Tokyo Tower')).toBeInTheDocument()
    expect(within(fullTimeline).getAllByText('Counter seat').length).toBeGreaterThan(0)
    expect(within(fullTimeline).getAllByText('9:00 AM').length).toBeGreaterThan(0)
    expect(within(fullTimeline).queryByRole('heading', { name: /sunday, may 3/i })).not.toBeInTheDocument()
    expect(within(fullTimeline).queryByText(/mapped/i)).not.toBeInTheDocument()
    expect(within(fullTimeline).queryByText(/^day \d/i)).not.toBeInTheDocument()

    const selectedMapActivities = within(screen.getByTestId('selected-map-activities'))
    const fallbackMapActivities = within(screen.getByTestId('fallback-map-activities'))
    const routeMapActivities = within(screen.getByTestId('route-map-activities'))
    expect(selectedMapActivities.getByText('Tsukiji sushi')).toBeInTheDocument()
    expect(selectedMapActivities.getByText('Tokyo Tower')).toBeInTheDocument()
    expect(screen.getByTestId('destination-fallback')).toHaveTextContent('false')
    expect(routeMapActivities.getByText('Tsukiji sushi')).toBeInTheDocument()
    expect(routeMapActivities.getByText('Tokyo Tower')).toBeInTheDocument()
    const routesToggle = screen.getByRole('checkbox', { name: /routes/i })
    expect(routesToggle).toBeChecked()
    const exportLink = screen.getByRole('link', { name: /export timeline/i })
    const exportUrl = new URL(exportLink.getAttribute('href') ?? '')
    expect(exportUrl.searchParams.get('origin')).toBe('35.6654,139.7707')
    expect(exportUrl.searchParams.get('destination')).toBe('35.6586,139.7454')
    expect(exportUrl.searchParams.get('travelmode')).toBe('driving')
    await userEvent.click(routesToggle)
    expect(routeMapActivities.queryByText('Tsukiji sushi')).not.toBeInTheDocument()
    expect(routeMapActivities.queryByText('Tokyo Tower')).not.toBeInTheDocument()
    await userEvent.click(routesToggle)
    expect(routeMapActivities.getByText('Tsukiji sushi')).toBeInTheDocument()
    expect(routeMapActivities.getByText('Tokyo Tower')).toBeInTheDocument()
    expect(screen.queryByLabelText(/full trip map summary/i)).not.toBeInTheDocument()

    expect(within(fullTimeline).queryByRole('button', { name: /drag tokyo tower/i }))
      .not.toBeInTheDocument()

    const tokyoTowerButton = within(fullTimeline).getByRole('button', { name: /^tokyo tower/i })
    fireEvent.mouseEnter(tokyoTowerButton)
    expect(screen.getByTestId('active-map-activity')).toHaveTextContent('22')
    await userEvent.click(tokyoTowerButton)
    expect(screen.getByTestId('focused-map-activity')).toHaveTextContent('22')
    expect(screen.getByLabelText(/selected map place/i)).toBeInTheDocument()

    const dayTwoToggle = within(fullTimeline).getByRole('button', { name: /saturday, may 2/i })
    await userEvent.click(dayTwoToggle)
    expect(dayTwoToggle).toHaveAttribute('aria-expanded', 'false')
    expect(within(fullTimeline).queryByRole('button', { name: /^tokyo tower/i })).not.toBeInTheDocument()
    expect(selectedMapActivities.queryByText('Tokyo Tower')).not.toBeInTheDocument()
    expect(routeMapActivities.queryByText('Tokyo Tower')).not.toBeInTheDocument()
    expect(fallbackMapActivities.queryByText('Tokyo Tower')).not.toBeInTheDocument()
    expect(selectedMapActivities.getByText('Tsukiji sushi')).toBeInTheDocument()
    expect(routeMapActivities.getByText('Tsukiji sushi')).toBeInTheDocument()
    expect(screen.getByTestId('active-map-activity')).toHaveTextContent('none')
    expect(screen.getByTestId('focused-map-activity')).toHaveTextContent('none')
    expect(screen.queryByLabelText(/selected map place/i)).not.toBeInTheDocument()
    expect(screen.getByTestId('map-viewport-fit-key')).toHaveAttribute(
      'data-viewport-fit-key',
      'timeline:timeline:2026-05-02:Tokyo, Japan',
    )

    await userEvent.click(dayTwoToggle)
    expect(dayTwoToggle).toHaveAttribute('aria-expanded', 'true')
    expect(selectedMapActivities.getByText('Tokyo Tower')).toBeInTheDocument()
    expect(routeMapActivities.getByText('Tokyo Tower')).toBeInTheDocument()
    expect(screen.getByTestId('active-map-activity')).toHaveTextContent('none')
    expect(screen.getByTestId('focused-map-activity')).toHaveTextContent('none')
    expect(screen.getByTestId('map-viewport-fit-key')).toHaveAttribute(
      'data-viewport-fit-key',
      'timeline:timeline::Tokyo, Japan',
    )

    await userEvent.click(within(fullTimeline).getByRole('button', { name: /^tokyo tower/i }))
    expect(screen.getByTestId('active-map-activity')).toHaveTextContent('22')
    expect(screen.getByRole('button', { name: /^timeline$/i })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('heading', { name: /full trip timeline/i })).toBeInTheDocument()
    await waitFor(() => {
      expect(within(screen.getByLabelText(/selected map place/i)).getByRole('heading', {
        name: /tokyo tower/i,
      })).toBeInTheDocument()
    })
    expect(googlePlacesMockState.fetchGooglePlaceNearLocation).not.toHaveBeenCalled()
  })

  it('lists only active mobile map days while preserving trip-day numbers and filters', async () => {
    mockViewport(true)
    const dayOneActivity = {
      ...SAMPLE_ACTIVITY,
      placeId: 'google.tsukiji',
      placeName: 'Tsukiji sushi',
      address: 'Tsukiji, Chuo City, Tokyo',
      lat: 35.6654,
      lng: 139.7707,
    }
    const dayThreeActivity = {
      ...SAMPLE_ACTIVITY,
      id: 22,
      dayDate: '2026-05-03',
      title: 'Tokyo Tower',
      lat: 35.6586,
      lng: 139.7454,
      orderIndex: 0,
    }
    mockWorkspace([dayOneActivity, dayThreeActivity])

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await userEvent.click(await screen.findByRole('button', { name: /^map$/i }))

    const selectedMapActivities = within(await screen.findByTestId('selected-map-activities'))
    const routeMapActivities = within(screen.getByTestId('route-map-activities'))
    expect(selectedMapActivities.getByText('Tsukiji sushi')).toBeInTheDocument()
    expect(selectedMapActivities.getByText('Tokyo Tower')).toBeInTheDocument()
    expect(routeMapActivities.getByText('Tokyo Tower')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /routes/i })).toBeChecked()
    expect(screen.getByRole('button', { name: /days 2\/2/i })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /mock activate second marker/i }))
    expect(screen.getByLabelText(/selected map place/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /days 2\/2/i }))
    expect(screen.getByRole('dialog', { name: /^map days$/i })).toBeInTheDocument()
    const dayThreeVisibility = screen.getByRole('button', {
      name: /day 3.*sunday, may 3.*1 activity/i,
    })
    expect(dayThreeVisibility).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByRole('button', { name: /day 2.*saturday, may 2/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /day 4.*monday, may 4/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /day 5.*tuesday, may 5/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /show all/i })).toBeDisabled()

    await userEvent.click(dayThreeVisibility)
    expect(screen.getByRole('button', {
      name: /day 3.*sunday, may 3.*1 activity/i,
    })).toHaveAttribute('aria-pressed', 'false')
    expect(selectedMapActivities.queryByText('Tokyo Tower')).not.toBeInTheDocument()
    expect(routeMapActivities.queryByText('Tokyo Tower')).not.toBeInTheDocument()
    expect(selectedMapActivities.getByText('Tsukiji sushi')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /show all/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /days 1\/2/i })).toBeInTheDocument()
    expect(screen.queryByLabelText(/selected map place/i)).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /show all/i }))
    expect(screen.getByRole('button', { name: /days 2\/2/i })).toBeInTheDocument()
    expect(selectedMapActivities.getByText('Tokyo Tower')).toBeInTheDocument()
    await userEvent.click(dayThreeVisibility)

    await userEvent.click(screen.getByRole('button', { name: /^plan$/i }))
    await userEvent.click(screen.getByRole('button', { name: /^map$/i }))
    expect(screen.getByRole('button', { name: /days 1\/2/i })).toBeInTheDocument()
    expect(within(screen.getByTestId('selected-map-activities')).queryByText('Tokyo Tower')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^timeline$/i }))
    const fullTimeline = screen.getByLabelText(/trip days timeline/i)
    await userEvent.click(within(fullTimeline).getByRole('button', {
      name: /^tokyo tower/i,
    }))

    expect(screen.getByRole('button', { name: /days 2\/2/i })).toBeInTheDocument()
    expect(within(screen.getByTestId('selected-map-activities')).getByText('Tokyo Tower')).toBeInTheDocument()
    expect(within(screen.getByTestId('route-map-activities')).getByText('Tokyo Tower')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /open map layers and export/i }))
    const mapLayersDialog = screen.getByRole('dialog', { name: /map layers and export/i })
    expect(mapLayersDialog).toBeInTheDocument()
    expect(within(mapLayersDialog).getByRole('link', { name: /open in google maps/i })).toBeInTheDocument()
    await userEvent.click(within(mapLayersDialog).getByRole('button', { name: /terrain/i }))
    expect(screen.getByTestId('map-style')).toHaveTextContent('terrain')
  })

  it('keeps the mobile map day control empty when the trip has no scheduled activities', async () => {
    mockViewport(true)
    mockWorkspace([])

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await userEvent.click(await screen.findByRole('button', { name: /^map$/i }))
    const daysControl = screen.getByRole('button', { name: /days 0\/0/i })
    expect(daysControl).toBeInTheDocument()

    await userEvent.click(daysControl)
    const mapDaysDialog = screen.getByRole('dialog', { name: /^map days$/i })
    expect(within(mapDaysDialog).getByText('0 of 0 on map')).toBeInTheDocument()
    expect(within(mapDaysDialog).getByRole('button', { name: /show all/i })).toBeDisabled()
    expect(within(mapDaysDialog).getByLabelText(/map day visibility/i)).toBeEmptyDOMElement()
  })

  it('keeps Ideas out of day maps and routes and shows them in the Ideas tab', async () => {
    const dayActivity = {
      ...SAMPLE_ACTIVITY,
      placeId: 'google.tsukiji',
      placeName: 'Tsukiji sushi',
      address: 'Tsukiji, Chuo City, Tokyo',
      lat: 35.6654,
      lng: 139.7707,
    }
    const ideaActivity = withoutDayDate({
      ...SAMPLE_ACTIVITY,
      id: 33,
      dayDate: null,
      title: 'Save teamLab',
      placeId: 'google.teamlab',
      placeName: 'teamLab Planets',
      address: 'Toyosu, Tokyo',
      lat: 35.6491,
      lng: 139.7898,
      orderIndex: 0,
    })
    mockWorkspace([dayActivity, ideaActivity])

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByRole('heading', { name: /friday, may 1/i })
    expect(screen.getByText(/1 activity scheduled today/i)).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /^saved ideas$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /move to ideas/i })).not.toBeInTheDocument()

    const selectedDayMapActivities = within(screen.getByTestId('selected-map-activities'))
    const selectedDayRouteActivities = within(screen.getByTestId('route-map-activities'))
    expect(selectedDayMapActivities.getByText('Tsukiji sushi')).toBeInTheDocument()
    expect(selectedDayMapActivities.queryByText('Save teamLab')).not.toBeInTheDocument()
    expect(selectedDayRouteActivities.getByText('Tsukiji sushi')).toBeInTheDocument()
    expect(selectedDayRouteActivities.queryByText('Save teamLab')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^ideas$/i }))

    expect(screen.getByRole('button', { name: /^ideas$/i })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('heading', { name: /^ideas$/i })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: /^saved ideas$/i })).toBeInTheDocument()
    expect(screen.getAllByText('Save teamLab').length).toBeGreaterThan(0)

    const ideasMapActivities = within(screen.getByTestId('selected-map-activities'))
    const ideasRouteActivities = within(screen.getByTestId('route-map-activities'))
    expect(ideasMapActivities.getByText('Save teamLab')).toBeInTheDocument()
    expect(ideasMapActivities.queryByText('Tsukiji sushi')).not.toBeInTheDocument()
    expect(ideasRouteActivities.queryByText('Save teamLab')).not.toBeInTheDocument()
    expect(ideasRouteActivities.queryByText('Tsukiji sushi')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^timeline$/i }))

    const fullTimeline = screen.getByLabelText(/trip days timeline/i)
    expect(within(fullTimeline).queryByRole('heading', { name: /^ideas$/i })).not.toBeInTheDocument()
    expect(within(fullTimeline).queryByText('Save teamLab')).not.toBeInTheDocument()
    const timelineMapActivities = within(screen.getByTestId('selected-map-activities'))
    const timelineRouteActivities = within(screen.getByTestId('route-map-activities'))
    expect(timelineMapActivities.getByText('Tsukiji sushi')).toBeInTheDocument()
    expect(timelineMapActivities.queryByText('Save teamLab')).not.toBeInTheDocument()
    expect(timelineRouteActivities.getByText('Tsukiji sushi')).toBeInTheDocument()
    expect(timelineRouteActivities.queryByText('Save teamLab')).not.toBeInTheDocument()
  })

  it('keeps the timeline open and shows place details when a timeline marker is clicked', async () => {
    const dayOneActivity = {
      ...SAMPLE_ACTIVITY,
      placeId: 'google.tsukiji',
      placeName: 'Tsukiji sushi',
      address: 'Tsukiji, Chuo City, Tokyo',
      lat: 35.6654,
      lng: 139.7707,
    }
    const dayTwoActivity = {
      ...SAMPLE_ACTIVITY,
      id: 22,
      dayDate: '2026-05-02',
      title: 'Tokyo Tower',
      placeId: 'google.tokyo-tower',
      placeName: 'Tokyo Tower',
      address: '4 Chome-2-8 Shibakoen, Minato City, Tokyo',
      lat: 35.6586,
      lng: 139.7454,
      orderIndex: 0,
    }
    googlePlacesMockState.fetchGooglePlaceById.mockResolvedValueOnce({
      businessStatus: 'OPERATIONAL',
      currentOpeningHours: null,
      displayName: 'Tokyo Tower',
      formattedAddress: '4 Chome-2-8 Shibakoen, Minato City, Tokyo',
      googleMapsUri: 'https://maps.google.com/?cid=tokyo-tower',
      id: 'google.tokyo-tower',
      lat: 35.6586,
      lng: 139.7454,
      photoUrl: null,
      primaryType: 'tourist_attraction',
      primaryTypeDisplayName: 'Tourist attraction',
      rating: 4.5,
      regularOpeningHours: null,
      reviews: [],
      text: 'Tokyo Tower, 4 Chome-2-8 Shibakoen, Minato City, Tokyo',
      types: ['tourist_attraction'],
      userRatingCount: 10000,
      websiteUri: null,
    })
    mockWorkspace([dayOneActivity, dayTwoActivity])

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByRole('heading', { name: /friday, may 1/i })
    await userEvent.click(screen.getByRole('button', { name: /^timeline$/i }))
    expect(screen.getByRole('heading', { name: /full trip timeline/i })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /mock activate second marker/i }))

    expect(screen.getByRole('button', { name: /^timeline$/i })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('heading', { name: /full trip timeline/i })).toBeInTheDocument()
    expect(screen.getByTestId('active-map-activity')).toHaveTextContent('22')
    expect(screen.getByTestId('preview-map-place')).toHaveTextContent('none')
    await waitFor(() => {
      expect(within(screen.getByLabelText(/selected map place/i)).getByRole('heading', {
        name: /tokyo tower/i,
      })).toBeInTheDocument()
    })
    expect(screen.getByTestId('preview-map-place')).toHaveTextContent('none')
    expect(within(screen.getByTestId('selected-map-activities')).getByText('Tokyo Tower'))
      .toBeInTheDocument()
    expect(within(screen.getByTestId('selected-map-activities')).getByText('Tsukiji sushi'))
      .toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /mock map place click/i }))
    await waitFor(() => {
      expect(screen.getByTestId('preview-map-place')).toHaveTextContent('Clicked Place')
    })
  })

  it('syncs active activity state between cards and map controls', async () => {
    const dayTwoActivity = {
      ...SAMPLE_ACTIVITY,
      id: 22,
      dayDate: '2026-05-02',
      title: 'Tokyo Tower',
      placeId: 'google.tokyo-tower',
      placeName: 'Tokyo Tower',
      address: 'Saved Tokyo Tower address',
      lat: 35.6586,
      lng: 139.7454,
      orderIndex: 0,
    }
    const secondDayActivity = {
      ...SAMPLE_ACTIVITY,
      id: 23,
      dayDate: '2026-05-02',
      title: 'Senso-ji',
      placeId: 'google.sensoji',
      placeName: 'Senso-ji',
      address: '2 Chome-3-1 Asakusa, Taito City, Tokyo',
      lat: 35.7148,
      lng: 139.7967,
      orderIndex: 1,
    }
    googlePlacesMockState.fetchGooglePlaceById.mockResolvedValue({
      businessStatus: 'OPERATIONAL',
      currentOpeningHours: null,
      displayName: 'Tokyo Tower',
      formattedAddress: 'Enriched Google address',
      googleMapsUri: 'https://maps.google.com/?cid=tokyo-tower',
      id: 'google.tokyo-tower',
      lat: 35.6586,
      lng: 139.7454,
      photoUrl: 'https://example.com/tokyo-tower-marker.webp',
      primaryType: 'tourist_attraction',
      primaryTypeDisplayName: 'Tourist attraction',
      rating: 4.5,
      regularOpeningHours: null,
      reviews: [],
      text: 'Tokyo Tower, Enriched Google address',
      types: ['tourist_attraction'],
      userRatingCount: 10000,
      websiteUri: null,
    })
    mockWorkspace([dayTwoActivity, secondDayActivity])

    renderWorkspace('/trips/abc234def567/d/2026-05-02')

    expect(await screen.findByTestId('trip-map')).toBeInTheDocument()
    expect(screen.getByTestId('active-map-activity')).toHaveTextContent('none')

    const activityHeading = await screen.findByRole('heading', { name: /tokyo tower/i })
    const activityCard = activityHeading.closest('article')
    expect(activityCard).not.toBeNull()
    const secondActivityCard = screen.getByRole('heading', { name: /senso-ji/i }).closest('article')
    expect(secondActivityCard).not.toBeNull()

    expect(screen.queryByRole('button', { name: /drag tokyo tower/i })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/activity name/i)).not.toBeInTheDocument()
    expect(activityCard).toHaveAttribute('aria-expanded', 'false')
    expect(secondActivityCard).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(activityCard as HTMLElement)
    expect(screen.getByTestId('active-map-activity')).toHaveTextContent('22')
    expect(activityCard).toHaveAttribute('data-active', 'true')
    expect(activityCard).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByLabelText(/activity name/i)).toHaveValue('Tokyo Tower')

    await userEvent.click(activityCard as HTMLElement)
    expect(screen.getByTestId('active-map-activity')).toHaveTextContent('22')
    expect(activityCard).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(secondActivityCard as HTMLElement)
    expect(secondActivityCard).toHaveAttribute('aria-expanded', 'true')
    expect(activityCard).toHaveAttribute('aria-expanded', 'false')

    await userEvent.click(screen.getByRole('button', { name: /mock activate marker/i }))
    expect(screen.getByTestId('active-map-activity')).toHaveTextContent('22')
    expect(screen.getByTestId('preview-map-place')).toHaveTextContent('none')
    await waitFor(() => {
      expect(document.activeElement).toHaveAttribute('id', 'activity-22')
    })
    expect(activityCard).toHaveAttribute('aria-expanded', 'true')
    expect(secondActivityCard).toHaveAttribute('aria-expanded', 'false')
    await waitFor(() => {
      expect(googlePlacesMockState.fetchGooglePlaceById).toHaveBeenCalledWith({
        includePhoto: true,
        placeId: 'google.tokyo-tower',
      })
    })
    expect(within(screen.getByLabelText(/selected map place/i)).getByRole('img', {
      name: /tokyo tower/i,
    })).toHaveAttribute('src', 'https://example.com/tokyo-tower-marker.webp')
    expect(within(screen.getByLabelText(/selected map place/i)).getByText('Enriched Google address'))
      .toBeInTheDocument()
    expect(within(screen.getByLabelText(/selected map place/i)).getByText(/4\.5 \(10,000 reviews\)/i))
      .toBeInTheDocument()
    const selectedMapPlace = screen.getByLabelText(/selected map place/i)
    const googleMapsLink = within(selectedMapPlace).getByRole('link', {
      name: /open in google maps/i,
    })
    expectGoogleMapsPlaceLink(googleMapsLink, {
      placeId: 'google.tokyo-tower',
      query: 'Saved Tokyo Tower address',
    })
    expect(googleMapsLink).not.toHaveTextContent(/open in google maps/i)
    expect(screen.getByTestId('preview-map-place')).toHaveTextContent('none')

    await userEvent.click(screen.getByRole('button', { name: /mock activate marker/i }))
    expect(activityCard).toHaveAttribute('aria-expanded', 'true')

    await userEvent.click(screen.getByRole('button', { name: /^default$/i }))
    await userEvent.click(screen.getByRole('button', { name: /^satellite$/i }))
    expect(screen.getByTestId('map-style')).toHaveTextContent('satellite')
  })

  it('expands the current map style into the four supported map styles', async () => {
    mockWorkspace([SAMPLE_ACTIVITY])

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByTestId('trip-map')

    expect(screen.getByRole('button', { name: /^default$/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^satellite$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^terrain$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^hybrid$/i })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^default$/i }))
    const mapStyleGroup = screen.getByRole('group', { name: /^map style$/i })
    expect(within(mapStyleGroup).getAllByRole('button')).toHaveLength(4)
    expect(within(mapStyleGroup).getByRole('button', { name: /^default$/i })).toBeInTheDocument()
    expect(within(mapStyleGroup).getByRole('button', { name: /^satellite$/i })).toBeInTheDocument()
    expect(within(mapStyleGroup).getByRole('button', { name: /^terrain$/i })).toBeInTheDocument()
    expect(within(mapStyleGroup).getByRole('button', { name: /^hybrid$/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^more$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^traffic$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^transit$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^biking$/i })).not.toBeInTheDocument()

    await userEvent.click(within(mapStyleGroup).getByRole('button', { name: /^hybrid$/i }))
    expect(screen.getByTestId('map-style')).toHaveTextContent('hybrid')
    expect(screen.getByRole('button', { name: /^hybrid$/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^default$/i })).not.toBeInTheDocument()
  })

  it('keeps viewer workspaces read-only while preserving itinerary and map context', async () => {
    mockWorkspace([SAMPLE_ACTIVITY], { ...SAMPLE_TRIP, role: 'VIEWER' })

    renderWorkspace('/trips/abc234def567')

    expect(await screen.findByRole('heading', { level: 1, name: /tokyo 2026/i })).toBeInTheDocument()
    expect(screen.getAllByText('Tsukiji sushi').length).toBeGreaterThan(0)
    expect(screen.getByTestId('trip-map')).toBeInTheDocument()
    expect(screen.queryByLabelText(/day note/i)).not.toBeInTheDocument()

    expect(screen.queryByRole('button', { name: /mock place search/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save note/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add activity/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^settings$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /share trip/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /edit: tsukiji sushi/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /delete: tsukiji sushi/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /move tsukiji sushi up/i })).not.toBeInTheDocument()

    const calendarDay = screen.getByTitle('2026-05-02 (0 activities)')
    const ideasButton = screen.getByRole('button', { name: /^ideas$/i })
    triggerDragStart(activityDragId(10))
    expect(calendarDay).not.toHaveAttribute('data-sidebar-drop-target')
    expect(ideasButton).not.toHaveAttribute('data-sidebar-drop-target')
  })

  it('opens the empty-day composer and closes it when create is canceled', async () => {
    mockWorkspace()

    renderWorkspace('/trips/abc234def567')

    expect(await screen.findByText(/no activities planned for this day/i)).toBeInTheDocument()
    expect(screen.queryByLabelText(/activity name/i)).not.toBeInTheDocument()

    const addButtons = await screen.findAllByRole('button', { name: /add activity/i })
    await userEvent.click(addButtons[addButtons.length - 1])
    expect(screen.getByLabelText(/activity name/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }))
    expect(screen.queryByLabelText(/activity name/i)).not.toBeInTheDocument()
    expect(screen.getByText(/no activities planned for this day/i)).toBeInTheDocument()
  })

  it('creates an activity for the selected day', async () => {
    mockWorkspace()
    apiMock.onPost('/trips/abc234def567/activities?dayDate=2026-05-01').reply(201, {
      ...SAMPLE_ACTIVITY,
      title: 'Tsukiji sushi',
    })

    renderWorkspace('/trips/abc234def567')

    await userEvent.click((await screen.findAllByRole('button', { name: /add activity/i }))[0])
    expect(screen.queryByLabelText(/selected map place/i)).not.toBeInTheDocument()
    expect(screen.getByTestId('preview-map-place')).toHaveTextContent('none')
    await userEvent.click(await screen.findByRole('button', { name: /category: other/i }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: /meal/i }))
    await userEvent.type(await screen.findByLabelText(/activity name/i), 'Tsukiji sushi')
    await userEvent.click(screen.getByRole('button', { name: /^create activity$/i }))

    expect(await screen.findAllByText('Tsukiji sushi')).not.toHaveLength(0)
    expect(apiMock.history.post[0].url).toBe('/trips/abc234def567/activities?dayDate=2026-05-01')
    expect(JSON.parse(apiMock.history.post[0].data as string)).toMatchObject({
      category: 'MEAL',
      title: 'Tsukiji sushi',
      placeId: null,
      placeName: null,
      address: null,
      lat: null,
      lng: null,
    })
  })

  it('replaces the create composer with the optimistic activity while creation is pending', async () => {
    const response = createDeferred<[number, Activity]>()
    const createdActivity = {
      ...SAMPLE_ACTIVITY,
      id: 20,
      title: 'Latency-free activity',
    }
    mockWorkspace()
    apiMock.onPost('/trips/abc234def567/activities?dayDate=2026-05-01')
      .reply(() => response.promise)

    renderWorkspace('/trips/abc234def567')

    await userEvent.click((await screen.findAllByRole('button', { name: /add activity/i }))[0])
    await userEvent.type(screen.getByLabelText(/activity name/i), createdActivity.title)
    await userEvent.click(screen.getByRole('button', { name: /^create activity$/i }))

    await waitFor(() => {
      expect(screen.getAllByRole('article', { name: /latency-free activity/i })).toHaveLength(1)
    })
    expect(screen.queryByLabelText(/activity name/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /saving/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^add activity$/i })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Creating activity…')
    await waitFor(() => {
      expect(document.getElementById('timeline-panel')).toHaveFocus()
    })

    act(() => response.resolve([201, createdActivity]))

    await waitFor(() => {
      expect(screen.getAllByRole('article', { name: /latency-free activity/i })).toHaveLength(1)
      expect(screen.getByRole('button', { name: /^add activity$/i })).toBeEnabled()
    })
    expect(screen.queryByLabelText(/activity name/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('restores the populated composer after a create failure and hides it again on retry', async () => {
    const failedResponse = createDeferred<[number, { error: string }]>()
    const retryResponse = createDeferred<[number, Activity]>()
    const createdActivity = {
      ...SAMPLE_ACTIVITY,
      id: 21,
      category: 'MEAL' as const,
      title: 'Retry activity',
    }
    let attempt = 0
    mockWorkspace()
    apiMock.onPost('/trips/abc234def567/activities?dayDate=2026-05-01').reply(() => {
      attempt += 1
      return attempt === 1 ? failedResponse.promise : retryResponse.promise
    })

    renderWorkspace('/trips/abc234def567')

    await userEvent.click((await screen.findAllByRole('button', { name: /add activity/i }))[0])
    await userEvent.click(screen.getByRole('button', { name: /category: other/i }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: /meal/i }))
    await userEvent.type(screen.getByLabelText(/activity name/i), createdActivity.title)
    await userEvent.click(screen.getByRole('button', { name: /^create activity$/i }))

    await waitFor(() => {
      expect(screen.getAllByRole('article', { name: /retry activity/i })).toHaveLength(1)
    })
    expect(screen.queryByLabelText(/activity name/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /saving/i })).not.toBeInTheDocument()

    act(() => failedResponse.resolve([500, { error: 'create_failed' }]))

    const restoredTitleInput = await screen.findByLabelText(/activity name/i)
    expect(restoredTitleInput).toHaveValue(createdActivity.title)
    expect(restoredTitleInput).toHaveFocus()
    expect(screen.getByRole('button', { name: /category: meal/i })).toBeInTheDocument()
    expect(screen.queryByRole('article', { name: /retry activity/i })).not.toBeInTheDocument()
    expect(screen.getByRole('alert')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /^create activity$/i }))

    await waitFor(() => {
      expect(screen.getAllByRole('article', { name: /retry activity/i })).toHaveLength(1)
    })
    expect(screen.queryByLabelText(/activity name/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /saving/i })).not.toBeInTheDocument()

    act(() => retryResponse.resolve([201, createdActivity]))

    await waitFor(() => {
      expect(screen.getAllByRole('article', { name: /retry activity/i })).toHaveLength(1)
      expect(apiMock.history.post).toHaveLength(2)
    })
    expect(screen.queryByLabelText(/activity name/i)).not.toBeInTheDocument()
  })

  it('keeps the Ideas pending status stable when switching workspaces', async () => {
    const response = createDeferred<[number, Omit<Activity, 'dayDate'>]>()
    const createdIdea = withoutDayDate({
      ...SAMPLE_ACTIVITY,
      id: 22,
      dayDate: null,
      title: 'Save ramen shop',
    })
    mockWorkspace()
    apiMock.onPost('/trips/abc234def567/activities').reply(() => response.promise)

    renderWorkspace('/trips/abc234def567')

    await userEvent.click(await screen.findByRole('button', { name: /^ideas$/i }))
    await userEvent.click(screen.getAllByRole('button', { name: /^add idea$/i })[0])
    await userEvent.type(screen.getByLabelText(/activity name/i), createdIdea.title)
    await userEvent.click(screen.getByRole('button', { name: /^save idea$/i }))

    await waitFor(() => {
      expect(screen.getAllByRole('article', { name: /save ramen shop/i })).toHaveLength(1)
    })
    expect(screen.queryByLabelText(/activity name/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^save idea$/i })).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('Saving idea…')

    await userEvent.click(screen.getByRole('button', { name: /^timeline$/i }))

    expect(screen.getByRole('status')).toHaveTextContent('Saving idea…')

    act(() => response.resolve([201, createdIdea]))

    await waitFor(() => {
      expect(screen.queryByRole('status')).not.toBeInTheDocument()
      expect(apiMock.history.post).toHaveLength(1)
    })

    await userEvent.click(screen.getByRole('button', { name: /^ideas$/i }))
    expect(screen.getAllByRole('article', { name: /save ramen shop/i })).toHaveLength(1)
    expect(screen.queryByLabelText(/activity name/i)).not.toBeInTheDocument()
  })

  it('creates an activity from a selected Google place', async () => {
    mockWorkspace()
    apiMock.onPost('/trips/abc234def567/activities?dayDate=2026-05-01').reply(201, {
      ...SAMPLE_ACTIVITY,
      id: 20,
      category: 'ACTIVITY',
      title: 'Tokyo Tower',
      placeId: 'google.tokyo-tower',
      placeName: 'Tokyo Tower',
      address: '4 Chome-2-8 Shibakoen, Minato City, Tokyo',
      lat: 35.6586,
      lng: 139.7454,
    })

    renderWorkspace('/trips/abc234def567')

    await userEvent.click(await screen.findByRole('button', { name: /mock type ramen search/i }))
    expect(screen.getByTestId('place-search-value')).toHaveTextContent('ramen')
    await userEvent.click(await screen.findByRole('button', { name: /mock place search/i }))
    expect(screen.queryByRole('heading', { name: /search results/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/ready to add/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/activity name/i)).not.toBeInTheDocument()
    expect(screen.getByTestId('search-map-results')).toBeEmptyDOMElement()
    expect(screen.getByTestId('selected-search-result')).toHaveTextContent('google.tokyo-tower')
    expect(screen.getByTestId('preview-map-place')).toHaveTextContent('Tokyo Tower')
    const detailCard = screen.getByLabelText(/selected map place/i)
    expect(within(detailCard).getByRole('heading', { name: /tokyo tower/i })).toBeInTheDocument()
    expect(within(detailCard).getByRole('img', { name: /tokyo tower/i })).toHaveAttribute(
      'src',
      'https://example.com/tokyo-tower.webp',
    )
    await userEvent.click(within(detailCard).getByRole('button', { name: /add to trip/i }))
    expect(screen.getByLabelText(/activity name/i)).toHaveValue('Tokyo Tower')
    await userEvent.click(screen.getByRole('button', { name: /^create activity$/i }))

    await waitFor(() => {
      expect(JSON.parse(apiMock.history.post[0].data as string)).toMatchObject({
        category: 'ACTIVITY',
        title: 'Tokyo Tower',
        placeId: 'google.tokyo-tower',
        placeName: 'Tokyo Tower',
        address: '4 Chome-2-8 Shibakoen, Minato City, Tokyo',
        lat: 35.6586,
        lng: 139.7454,
      })
    })
    await waitFor(() => {
      expect(within(screen.getByTestId('selected-map-activities')).getByText('Tokyo Tower'))
        .toBeInTheDocument()
    })
    expect(screen.getByTestId('place-search-value')).toBeEmptyDOMElement()
    expect(screen.getByTestId('active-map-activity')).toHaveTextContent('none')
    expect(screen.getByTestId('preview-map-place')).toHaveTextContent('none')
  })

  it('edits an existing activity', async () => {
    const placedActivity = {
      ...SAMPLE_ACTIVITY,
      placeId: 'google.tsukiji',
      placeName: 'Tsukiji Outer Market',
      address: 'Tsukiji, Chuo City, Tokyo',
      lat: 35.6654,
      lng: 139.7707,
    }
    mockWorkspace([placedActivity])
    apiMock.onPatch('/trips/abc234def567/activities/10').reply((config) => {
      const payload = JSON.parse(config.data as string)
      return [
        200,
        {
          ...placedActivity,
          ...payload,
          updatedAt: '2026-05-22T17:00:00Z',
          version: 1,
        },
      ]
    })

    renderWorkspace('/trips/abc234def567')

    const activityCard = (await screen.findByRole('heading', { name: /tsukiji sushi/i })).closest('article')
    expect(activityCard).not.toBeNull()
    await userEvent.click(activityCard as HTMLElement)
    const titleInput = screen.getByLabelText(/activity name/i)
    await userEvent.clear(titleInput)
    await userEvent.type(titleInput, 'Updated sushi')
    expect(screen.getByText('Tsukiji, Chuo City, Tokyo')).toBeInTheDocument()
    expect(screen.queryByText('Tsukiji Outer Market')).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/place name/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^address$/i)).not.toBeInTheDocument()
    const notesInput = screen.getByLabelText(/^notes$/i)
    await userEvent.clear(notesInput)
    await userEvent.type(notesInput, 'Updated notes')
    expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument()

    await waitFor(() => {
      expect(apiMock.history.patch.some((request) => {
        const payload = JSON.parse(request.data as string)
        return payload.title === 'Updated sushi' && payload.notes === 'Updated notes'
      })).toBe(true)
    }, { timeout: 2500 })
    const lastPatch = apiMock.history.patch[apiMock.history.patch.length - 1]
    expect(lastPatch.url).toBe('/trips/abc234def567/activities/10')
    expect(JSON.parse(lastPatch.data as string)).toMatchObject({
      title: 'Updated sushi',
      notes: 'Updated notes',
      placeId: 'google.tsukiji',
      placeName: 'Tsukiji Outer Market',
      address: 'Tsukiji, Chuo City, Tokyo',
      lat: 35.6654,
      lng: 139.7707,
    })
  })

  it('confirms activity deletion with an in-app dialog', async () => {
    mockWorkspace([SAMPLE_ACTIVITY])
    apiMock.onDelete('/trips/abc234def567/activities/10').reply(204)

    renderWorkspace('/trips/abc234def567')

    const activityCard = (await screen.findByRole('heading', { name: /tsukiji sushi/i })).closest('article')
    expect(activityCard).not.toBeNull()
    await userEvent.click(activityCard as HTMLElement)
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }))

    const dialog = screen.getByRole('alertdialog', { name: /delete activity/i })
    expect(dialog).toHaveTextContent('Delete "Tsukiji sushi"? This cannot be undone.')
    await userEvent.click(screen.getByRole('button', { name: /^delete activity$/i }))

    await waitFor(() => {
      expect(apiMock.history.delete[0].url).toBe('/trips/abc234def567/activities/10')
    })
  })

  it('links activity location editing to the map pane and updates after selecting a place', async () => {
    const placedActivity = {
      ...SAMPLE_ACTIVITY,
      placeId: 'google.tsukiji',
      placeName: 'Tsukiji Outer Market',
      address: 'Tsukiji, Chuo City, Tokyo',
      lat: 35.6654,
      lng: 139.7707,
    }
    mockWorkspace([placedActivity])
    apiMock.onPatch('/trips/abc234def567/activities/10').reply((config) => {
      const payload = JSON.parse(config.data as string)
      return [
        200,
        {
          ...placedActivity,
          ...payload,
          updatedAt: '2026-05-22T17:00:00Z',
          version: 1,
        },
      ]
    })

    renderWorkspace('/trips/abc234def567')

    const activityCard = (await screen.findByRole('heading', { name: /tsukiji sushi/i })).closest('article')
    expect(activityCard).not.toBeNull()
    await userEvent.click(activityCard as HTMLElement)
    expect(screen.getByText('Tsukiji, Chuo City, Tokyo')).toBeInTheDocument()
    expect(screen.queryByText('Tsukiji Outer Market')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /change on map/i }))

    expect(screen.getByTestId('place-search-value')).toHaveTextContent('Tsukiji, Chuo City, Tokyo')
    expect(screen.getByText(/updating location for tsukiji sushi/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /mock place search/i }))

    expect(screen.getByTestId('preview-map-place')).toHaveTextContent('Tokyo Tower')
    expect(screen.getByRole('button', { name: /confirm update/i })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /confirm update/i }))

    await waitFor(() => {
      expect(apiMock.history.patch[0].url).toBe('/trips/abc234def567/activities/10')
    })
    expect(JSON.parse(apiMock.history.patch[0].data as string)).toMatchObject({
      category: 'MEAL',
      title: 'Tsukiji sushi',
      notes: 'Counter seat',
      startTime: '09:00',
      placeId: 'google.tokyo-tower',
      placeName: 'Tokyo Tower',
      address: '4 Chome-2-8 Shibakoen, Minato City, Tokyo',
      lat: 35.6586,
      lng: 139.7454,
    })
    expect(screen.getByText('4 Chome-2-8 Shibakoen, Minato City, Tokyo')).toBeInTheDocument()
    expect(screen.queryByText('Tsukiji Outer Market')).not.toBeInTheDocument()
    expect(screen.getByTestId('preview-map-place')).toHaveTextContent('none')
  })

  it('uses the compact editor without old move controls', async () => {
    const dinner = {
      ...SAMPLE_ACTIVITY,
      id: 11,
      title: 'Dinner',
      orderIndex: 1,
    }
    mockWorkspace([SAMPLE_ACTIVITY, dinner])

    renderWorkspace('/trips/abc234def567')

    expect(await screen.findByRole('heading', { name: /tsukiji sushi/i })).toBeInTheDocument()
    expect(screen.queryByText(/insert activity here/i)).not.toBeInTheDocument()

    const dinnerCard = screen.getByRole('heading', { name: /dinner/i }).closest('article')
    expect(dinnerCard).not.toBeNull()
    await userEvent.click(dinnerCard as HTMLElement)

    expect(screen.getByLabelText(/activity name/i)).toHaveValue('Dinner')
    expect(screen.getByLabelText(/^time$/i)).toHaveAttribute('type', 'time')
    expect(screen.getByText('No location selected')).toBeInTheDocument()
    expect(screen.queryByLabelText(/place name/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^address$/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /add on map/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /move dinner up/i })).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^day$/i)).not.toBeInTheDocument()
  })

  it('passes the current map center to place search as proximity', async () => {
    mockWorkspace()

    renderWorkspace('/trips/abc234def567')

    expect(await screen.findByTestId('place-search-proximity')).toHaveTextContent('none')

    await userEvent.click(screen.getByRole('button', { name: /mock viewport center/i }))

    expect(screen.getByTestId('place-search-proximity')).toHaveTextContent('139.7454,35.6586')
    expect(placeSearchMockState.searchOptions?.proximity).toEqual({
      lng: 139.7454,
      lat: 35.6586,
    })
  })

  it('uses viewport restriction and included type for category map search', async () => {
    mockWorkspace()

    renderWorkspace('/trips/abc234def567')

    await screen.findByTestId('trip-map')
    await userEvent.click(screen.getByRole('button', { name: /mock viewport center/i }))
    await userEvent.click(screen.getByRole('button', { name: /mock submit restaurants search/i }))

    await waitFor(() => {
      expect(googlePlacesMockState.fetchGooglePlaceTextSearch).toHaveBeenCalledWith({
        includePhoto: false,
        options: expect.objectContaining({
          includedType: 'restaurant',
          language: 'en',
          locationRestriction: {
            high: { lat: 35.7, lng: 139.8 },
            low: { lat: 35.6, lng: 139.7 },
          },
          proximity: { lat: 35.6586, lng: 139.7454 },
          rankPreference: 'RELEVANCE',
        }),
        pageSize: 10,
        query: 'restaurants',
      })
    })
  })

  it('submits map search, maps returned places, and shows selected place details', async () => {
    mockWorkspace()
    googlePlacesMockState.fetchGooglePlaceTextSearch.mockResolvedValueOnce({
      nextPageToken: 'next-page',
      places: [{
        businessStatus: 'OPERATIONAL',
        currentOpeningHours: {
          openNow: true,
          weekdayDescriptions: [],
        },
        displayName: 'Ramen Street',
        formattedAddress: '1 Chome Marunouchi, Tokyo',
        googleMapsUri: 'https://maps.google.com/?cid=ramen',
        id: 'google.ramen-street',
        lat: 35.6812,
        lng: 139.7671,
        photoName: 'places/google.ramen-street/photos/main',
        photoUrl: null,
        primaryType: 'restaurant',
        primaryTypeDisplayName: 'Restaurant',
        rating: 4.4,
        regularOpeningHours: {
          openNow: null,
          weekdayDescriptions: ['Friday: 10:00 AM – 10:00 PM'],
        },
        reviews: [{
          authorName: 'Aya',
          rating: 5,
          relativePublishTimeDescription: '2 weeks ago',
          text: 'Excellent ramen.',
        }],
        text: 'Ramen Street, 1 Chome Marunouchi, Tokyo',
        types: ['restaurant'],
        userRatingCount: 1200,
        websiteUri: null,
      }],
    })
    googlePlacesMockState.fetchGooglePlaceTextSearch.mockResolvedValueOnce({
      nextPageToken: null,
      places: [{
        businessStatus: 'OPERATIONAL',
        currentOpeningHours: null,
        displayName: 'Udon Alley',
        formattedAddress: '2 Chome Marunouchi, Tokyo',
        googleMapsUri: 'https://maps.google.com/?cid=udon',
        id: 'google.udon-alley',
        lat: 35.682,
        lng: 139.768,
        photoUrl: null,
        primaryType: 'restaurant',
        primaryTypeDisplayName: 'Restaurant',
        rating: 4.2,
        regularOpeningHours: null,
        reviews: [],
        text: 'Udon Alley, 2 Chome Marunouchi, Tokyo',
        types: ['restaurant'],
        userRatingCount: 80,
        websiteUri: null,
      }],
    })
    googlePlacesMockState.fetchGooglePlaceById.mockResolvedValueOnce({
      businessStatus: 'OPERATIONAL',
      currentOpeningHours: null,
      displayName: 'Ramen Street',
      formattedAddress: '1 Chome Marunouchi, Tokyo',
      googleMapsUri: 'https://maps.google.com/?cid=ramen',
      id: 'google.ramen-street',
      lat: 35.6812,
      lng: 139.7671,
      photoUrl: 'https://example.com/ramen-street.webp',
      primaryType: 'restaurant',
      primaryTypeDisplayName: 'Restaurant',
      rating: 4.6,
      regularOpeningHours: {
        openNow: null,
        weekdayDescriptions: ['Friday: 10:00 AM – 10:00 PM'],
      },
      reviews: [],
      text: 'Ramen Street, 1 Chome Marunouchi, Tokyo',
      types: ['restaurant'],
      userRatingCount: 1300,
      websiteUri: null,
    })

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByTestId('trip-map')
    await userEvent.click(screen.getByRole('button', { name: /mock viewport center/i }))
    await userEvent.click(screen.getByRole('button', { name: /mock type ramen search/i }))
    expect(screen.getByTestId('place-search-value')).toHaveTextContent('ramen')
    await userEvent.click(screen.getByRole('button', { name: /mock submit place search/i }))

    await waitFor(() => {
      expect(googlePlacesMockState.fetchGooglePlaceTextSearch).toHaveBeenCalledWith({
        includePhoto: false,
        options: expect.objectContaining({
          language: 'en',
          rankPreference: 'RELEVANCE',
        }),
        pageSize: 10,
        query: 'ramen',
      })
    })
    expect(within(screen.getByTestId('search-map-results')).getByText('Ramen Street')).toBeInTheDocument()
    const mapSearchResults = screen.getByLabelText(/map search results/i)
    expect(within(mapSearchResults).getByRole('button', { name: /ramen street/i })).toBeInTheDocument()
    expect(within(mapSearchResults).queryByRole('img', { name: /ramen street/i })).not.toBeInTheDocument()
    await waitFor(() => {
      expect(googlePlacesMockState.imageUrlFromGooglePhotoName).toHaveBeenCalledWith({
        maxHeightPx: 240,
        maxWidthPx: 320,
        photoName: 'places/google.ramen-street/photos/main',
      })
    })

    const initialSearchOptions = googlePlacesMockState.fetchGooglePlaceTextSearch.mock.calls[0]?.[0].options
    await userEvent.click(screen.getByRole('button', { name: /mock move map viewport/i }))

    const searchResultPlaces = screen.getByLabelText(/search result places/i)
    Object.defineProperties(searchResultPlaces, {
      clientWidth: { configurable: true, value: 900 },
      scrollWidth: { configurable: true, value: 1000 },
    })
    fireEvent.scroll(searchResultPlaces, { target: { scrollLeft: 850 } })
    await waitFor(() => {
      expect(googlePlacesMockState.fetchGooglePlaceTextSearch).toHaveBeenLastCalledWith({
        includePhoto: false,
        options: {
          ...initialSearchOptions,
          pageToken: 'next-page',
        },
        pageSize: 10,
        query: 'ramen',
      })
    })
    expect(within(screen.getByTestId('search-map-results')).getByText('Udon Alley')).toBeInTheDocument()
    expect(googlePlacesMockState.fetchGooglePlaceById).not.toHaveBeenCalled()

    await userEvent.click(screen.getByRole('button', { name: /mock select search result/i }))

    expect(screen.getByTestId('selected-search-result')).toHaveTextContent('google.ramen-street')
    expect(screen.getByLabelText(/map search results/i)).toBeInTheDocument()
    expect(
      within(screen.getByLabelText(/map search results/i)).getByRole('button', {
        name: /ramen street/i,
      }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByText('Search result')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(googlePlacesMockState.fetchGooglePlaceById).toHaveBeenCalledWith(expect.objectContaining({
        includePhoto: true,
        placeId: 'google.ramen-street',
        traceId: expect.stringMatching(/^place-/),
      }))
    })

    const detailCard = screen.getByLabelText(/selected map place/i)
    expect(within(detailCard).getByRole('heading', { name: /ramen street/i })).toBeInTheDocument()
    expect(within(detailCard).getByText(/4\.6 \(1,300 reviews\)/i)).toBeInTheDocument()
    expect(within(detailCard).getByRole('img', { name: /ramen street/i })).toHaveAttribute(
      'src',
      'https://example.com/ramen-street.webp',
    )
    expect(within(detailCard).queryByText('Operational')).not.toBeInTheDocument()
    expect(within(detailCard).queryByText('Open now')).not.toBeInTheDocument()
    expect(within(detailCard).getByText('Friday: 10:00 AM – 10:00 PM')).toBeInTheDocument()
    expect(within(detailCard).queryByText('Excellent ramen.')).not.toBeInTheDocument()
    expect(within(detailCard).getByRole('button', { name: /close place details/i })).toBeInTheDocument()
    expect(within(detailCard).queryByRole('button', { name: /clear/i })).not.toBeInTheDocument()
    expect(within(detailCard).getByRole('link', { name: /get directions/i })).toHaveAttribute(
      'href',
      'https://www.google.com/maps/dir/?api=1&destination=35.6812%2C139.7671',
    )
    expect(within(detailCard).getByRole('link', { name: /open in google maps/i })).toHaveAttribute(
      'href',
      'https://maps.google.com/?cid=ramen',
    )
    expect(within(detailCard).getByRole('button', { name: /add to trip/i })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /mock remove search marker/i }))
    await waitFor(() => {
      expect(screen.getByTestId('selected-search-result')).toHaveTextContent('none')
    })
    expect(within(screen.getByTestId('search-map-results')).queryByText('Ramen Street')).not.toBeInTheDocument()
    expect(within(screen.getByTestId('search-map-results')).getByText('Udon Alley')).toBeInTheDocument()
    expect(screen.queryByLabelText(/selected map place/i)).not.toBeInTheDocument()
    expect(screen.getByLabelText(/map search results/i)).toBeInTheDocument()

    await userEvent.click(
      within(screen.getByLabelText(/map search results/i)).getByRole('button', {
        name: /close search results/i,
      }),
    )
    expect(screen.queryByLabelText(/map search results/i)).not.toBeInTheDocument()
    expect(screen.getByTestId('search-map-results')).toBeEmptyDOMElement()
    expect(screen.getByTestId('place-search-value')).toHaveTextContent('')
    expect(screen.queryByLabelText(/selected map place/i)).not.toBeInTheDocument()
  })

  it('keeps loaded search results and requires explicit retry after pagination fails', async () => {
    mockWorkspace()
    const ramenPlace = {
      businessStatus: 'OPERATIONAL',
      currentOpeningHours: null,
      displayName: 'Ramen Street',
      formattedAddress: '1 Chome Marunouchi, Tokyo',
      googleMapsUri: null,
      id: 'google.ramen-street',
      lat: 35.6812,
      lng: 139.7671,
      photoName: null,
      photoUrl: null,
      primaryType: 'restaurant',
      primaryTypeDisplayName: 'Restaurant',
      priceLevel: null,
      rating: 4.4,
      regularOpeningHours: null,
      reviews: [],
      text: 'Ramen Street, 1 Chome Marunouchi, Tokyo',
      types: ['restaurant'],
      userRatingCount: 1200,
      websiteUri: null,
    }
    googlePlacesMockState.fetchGooglePlaceTextSearch
      .mockResolvedValueOnce({ nextPageToken: 'retry-page', places: [ramenPlace] })
      .mockRejectedValueOnce(new Error('Google Places returned 400'))
      .mockResolvedValueOnce({
        nextPageToken: null,
        places: [{
          ...ramenPlace,
          displayName: 'Udon Alley',
          formattedAddress: '2 Chome Marunouchi, Tokyo',
          id: 'google.udon-alley',
          text: 'Udon Alley, 2 Chome Marunouchi, Tokyo',
        }],
      })

    renderWorkspace('/trips/abc234def567/d/2026-05-01')
    await screen.findByTestId('trip-map')
    await userEvent.click(screen.getByRole('button', { name: /mock type ramen search/i }))
    await userEvent.click(screen.getByRole('button', { name: /mock submit place search/i }))

    const results = await screen.findByLabelText(/search result places/i)
    const initialSearchOptions = googlePlacesMockState.fetchGooglePlaceTextSearch.mock.calls[0]?.[0].options
    Object.defineProperties(results, {
      clientWidth: { configurable: true, value: 900 },
      scrollLeft: { configurable: true, value: 850, writable: true },
      scrollWidth: { configurable: true, value: 1000 },
    })
    fireEvent.scroll(results)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/couldn’t load more places/i)
    expect(within(screen.getByLabelText(/map search results/i)).getByText('Ramen Street'))
      .toBeInTheDocument()
    expect(googlePlacesMockState.fetchGooglePlaceTextSearch).toHaveBeenCalledTimes(2)

    fireEvent.scroll(results)
    fireEvent.scroll(results)
    expect(googlePlacesMockState.fetchGooglePlaceTextSearch).toHaveBeenCalledTimes(2)

    await userEvent.click(within(alert).getByRole('button', { name: /^retry$/i }))
    await waitFor(() => {
      expect(googlePlacesMockState.fetchGooglePlaceTextSearch).toHaveBeenCalledTimes(3)
      expect(within(screen.getByLabelText(/map search results/i)).getByText('Udon Alley'))
        .toBeInTheDocument()
    })
    expect(screen.queryByText(/couldn’t load more places/i)).not.toBeInTheDocument()
    expect(googlePlacesMockState.fetchGooglePlaceTextSearch).toHaveBeenLastCalledWith({
      includePhoto: false,
      options: {
        ...initialSearchOptions,
        pageToken: 'retry-page',
      },
      pageSize: 10,
      query: 'ramen',
    })
  })

  it('keeps mobile search results and place details as exclusive sheets', async () => {
    mockViewport(true)
    mockWorkspace()
    const ramenPlace = {
      businessStatus: 'OPERATIONAL',
      currentOpeningHours: null,
      displayName: 'Ramen Street',
      formattedAddress: '1 Chome Marunouchi, Tokyo',
      googleMapsUri: 'https://maps.google.com/?cid=ramen',
      id: 'google.ramen-street',
      lat: 35.6812,
      lng: 139.7671,
      photoUrl: 'https://example.com/ramen-street.webp',
      primaryType: 'restaurant',
      primaryTypeDisplayName: 'Restaurant',
      rating: 4.4,
      regularOpeningHours: null,
      reviews: [],
      text: 'Ramen Street, 1 Chome Marunouchi, Tokyo',
      types: ['restaurant'],
      userRatingCount: 1200,
      websiteUri: null,
    }
    googlePlacesMockState.fetchGooglePlaceTextSearch.mockResolvedValueOnce({
      nextPageToken: null,
      places: [ramenPlace],
    })
    googlePlacesMockState.fetchGooglePlaceById.mockResolvedValue(ramenPlace)

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await userEvent.click(await screen.findByRole('button', { name: /^map$/i }))
    await screen.findByTestId('trip-map')
    await userEvent.click(screen.getByRole('button', { name: /mock place search/i }))
    expect(screen.getByLabelText(/selected map place/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /mock type ramen search/i }))
    await userEvent.click(screen.getByRole('button', { name: /mock submit place search/i }))

    const resultsSheet = await screen.findByLabelText(/map search results/i)
    expect(screen.queryByLabelText(/selected map place/i)).not.toBeInTheDocument()
    expect(within(resultsSheet).getByText('1 place')).toBeInTheDocument()
    expect(within(resultsSheet).getByLabelText(/search result places/i)).toHaveAttribute(
      'data-layout',
      'vertical',
    )
    expect(within(resultsSheet).queryByRole('button', {
      name: /scroll search results/i,
    })).not.toBeInTheDocument()
    const ramenResult = within(resultsSheet).getByRole('button', { name: /ramen street/i })
    await waitFor(() => {
      expect(ramenResult).toHaveFocus()
    })

    await userEvent.click(ramenResult)

    const detailSheet = await screen.findByLabelText(/selected map place/i)
    expect(screen.queryByLabelText(/map search results/i)).not.toBeInTheDocument()
    expect(within(detailSheet).getByRole('button', { name: /back to results/i })).toBeInTheDocument()
    expect(within(detailSheet).getAllByRole('button', { name: /close place details/i })).toHaveLength(1)
    const placeImage = within(detailSheet).getByRole('img', { name: /ramen street/i })
    const hero = placeImage.parentElement?.parentElement
    expect(hero).toContainElement(within(detailSheet).getByRole('button', { name: /back to results/i }))
    expect(hero).toContainElement(
      within(detailSheet).getByRole('button', { name: /close place details/i }),
    )
    expect(detailSheet.querySelector('[class*="placeDetailMobileHeader"]')).not.toBeInTheDocument()

    fireEvent.error(placeImage)
    await waitFor(() => {
      expect(within(detailSheet).queryByRole('img', { name: /ramen street/i })).not.toBeInTheDocument()
      expect(detailSheet.querySelector('[data-photo-state="fallback"]')).toBeInTheDocument()
    })
    const detailHeading = within(detailSheet).getByRole('heading', { name: /ramen street/i })
    await waitFor(() => {
      expect(detailHeading).toHaveFocus()
    })

    await userEvent.click(within(detailSheet).getByRole('button', { name: /back to results/i }))

    const restoredResults = await screen.findByLabelText(/map search results/i)
    expect(screen.queryByLabelText(/selected map place/i)).not.toBeInTheDocument()
    expect(screen.getByTestId('place-search-value')).toHaveTextContent('ramen')
    await waitFor(() => {
      expect(within(restoredResults).getByRole('button', { name: /ramen street/i })).toHaveFocus()
    })

    await userEvent.click(
      within(restoredResults).getByRole('button', { name: /ramen street/i }),
    )
    const reopenedDetail = await screen.findByLabelText(/selected map place/i)
    await userEvent.click(
      within(reopenedDetail).getByRole('button', { name: /close place details/i }),
    )

    expect(screen.queryByLabelText(/selected map place/i)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/map search results/i)).not.toBeInTheDocument()
    expect(screen.getByTestId('place-search-value')).toHaveTextContent('')
    expect(screen.getByRole('textbox', { name: /map place search/i })).not.toHaveFocus()
  })

  it('keeps a saved event without a Place ID and uses its address for Maps', async () => {
    const activity = {
      ...SAMPLE_ACTIVITY,
      address: 'Saved address',
      lat: 35.7,
      lng: 139.8,
      placeName: 'Saved venue name',
      title: 'Saved event title',
    }
    mockWorkspace([activity])

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByTestId('trip-map')
    await userEvent.click(screen.getByRole('button', { name: /mock activate marker/i }))

    const placeCard = await screen.findByLabelText(/selected map place/i)
    expect(googlePlacesMockState.fetchGooglePlaceNearLocation).not.toHaveBeenCalled()
    expect(googlePlacesMockState.fetchGooglePlaceById).not.toHaveBeenCalled()
    expect(within(placeCard).getByRole('heading', { name: /saved venue name/i })).toBeInTheDocument()
    expect(within(placeCard).getByText('Saved address')).toBeInTheDocument()
    expect(within(placeCard).getByRole('link', { name: /directions/i })).toHaveAttribute(
      'href',
      'https://www.google.com/maps/dir/?api=1&destination=35.7%2C139.8',
    )
    expect(within(placeCard).getByRole('link', { name: /open in google maps/i })).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=Saved%20address',
    )
  })

  it('uses a saved place name before coordinates when an event has no address', async () => {
    const activity = {
      ...SAMPLE_ACTIVITY,
      address: null,
      lat: 35.7,
      lng: 139.8,
      placeName: 'Saved venue name',
      title: 'Saved event title',
    }
    mockWorkspace([activity])

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByTestId('trip-map')
    await userEvent.click(screen.getByRole('button', { name: /mock activate marker/i }))

    const placeCard = await screen.findByLabelText(/selected map place/i)
    expect(googlePlacesMockState.fetchGooglePlaceNearLocation).not.toHaveBeenCalled()
    expect(within(placeCard).getByRole('heading', { name: /saved venue name/i })).toBeInTheDocument()
    expect(within(placeCard).getByRole('link', { name: /open in google maps/i })).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=Saved%20venue%20name',
    )
  })

  it('uses a saved title before coordinates when an event has no address or place name', async () => {
    const activity = {
      ...SAMPLE_ACTIVITY,
      address: null,
      lat: 35.7,
      lng: 139.8,
      placeName: null,
      title: 'Saved event title',
    }
    mockWorkspace([activity])

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByTestId('trip-map')
    await userEvent.click(screen.getByRole('button', { name: /mock activate marker/i }))

    const placeCard = await screen.findByLabelText(/selected map place/i)
    expect(googlePlacesMockState.fetchGooglePlaceNearLocation).not.toHaveBeenCalled()
    expect(within(placeCard).getByRole('heading', { name: /saved event title/i })).toBeInTheDocument()
    expect(within(placeCard).getByRole('link', { name: /open in google maps/i })).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=Saved%20event%20title',
    )
  })

  it('uses coordinates only when a saved event has no usable location text', async () => {
    const activity = {
      ...SAMPLE_ACTIVITY,
      address: null,
      lat: 35.7,
      lng: 139.8,
      placeName: null,
      title: '   ',
    }
    mockWorkspace([activity])

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByTestId('trip-map')
    await userEvent.click(screen.getByRole('button', { name: /mock activate marker/i }))

    const placeCard = await screen.findByLabelText(/selected map place/i)
    expect(googlePlacesMockState.fetchGooglePlaceNearLocation).not.toHaveBeenCalled()
    expect(within(placeCard).getByRole('link', { name: /open in google maps/i })).toHaveAttribute(
      'href',
      'https://www.google.com/maps/search/?api=1&query=35.7%2C139.8',
    )
  })

  it('preserves the active mobile place details when a text search fails', async () => {
    mockViewport(true)
    mockWorkspace()
    googlePlacesMockState.fetchGooglePlaceTextSearch.mockRejectedValueOnce(new Error('search failed'))

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await userEvent.click(await screen.findByRole('button', { name: /^map$/i }))
    await userEvent.click(screen.getByRole('button', { name: /mock place search/i }))
    const activeDetail = screen.getByLabelText(/selected map place/i)
    expect(within(activeDetail).getByRole('heading', { name: /tokyo tower/i })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /mock type ramen search/i }))
    await userEvent.click(screen.getByRole('button', { name: /mock submit place search/i }))

    await waitFor(() => {
      expect(googlePlacesMockState.fetchGooglePlaceTextSearch).toHaveBeenCalledTimes(1)
      expect(document.getElementById('map-search-panel')).toHaveAttribute('aria-busy', 'false')
    })
    expect(within(screen.getByLabelText(/selected map place/i)).getByRole('heading', {
      name: /tokyo tower/i,
    })).toBeInTheDocument()
    expect(screen.queryByLabelText(/map search results/i)).not.toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: /map place search/i })).toHaveFocus()
    })
  })

  it('preserves a new activity draft through mobile map search and place selection', async () => {
    mockViewport(true)
    mockWorkspace()
    const ramenPlace = {
      businessStatus: 'OPERATIONAL',
      currentOpeningHours: null,
      displayName: 'Ramen Street',
      formattedAddress: '1 Chome Marunouchi, Tokyo',
      googleMapsUri: 'https://maps.google.com/?cid=ramen',
      id: 'google.ramen-street',
      lat: 35.6812,
      lng: 139.7671,
      photoUrl: null,
      primaryType: 'restaurant',
      primaryTypeDisplayName: 'Restaurant',
      rating: 4.4,
      regularOpeningHours: null,
      reviews: [],
      text: 'Ramen Street, 1 Chome Marunouchi, Tokyo',
      types: ['restaurant'],
      userRatingCount: 1200,
      websiteUri: null,
    }
    googlePlacesMockState.fetchGooglePlaceTextSearch.mockResolvedValueOnce({
      nextPageToken: null,
      places: [ramenPlace],
    })
    googlePlacesMockState.fetchGooglePlaceById.mockResolvedValue(ramenPlace)

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await userEvent.click((await screen.findAllByRole('button', { name: /add activity/i }))[0])
    await userEvent.click(screen.getByRole('button', { name: /category: other/i }))
    await userEvent.click(screen.getByRole('menuitemradio', { name: /meal/i }))
    await userEvent.type(screen.getByLabelText(/activity name/i), 'Birthday dinner')
    await userEvent.type(screen.getByLabelText(/^time$/i), '18:30')
    await userEvent.click(screen.getByRole('button', { name: /notes & details/i }))
    await userEvent.type(screen.getByLabelText(/^notes$/i), 'Window table')
    await userEvent.click(screen.getByRole('button', { name: /add on map/i }))

    await userEvent.click(screen.getByRole('button', { name: /mock type ramen search/i }))
    await userEvent.click(screen.getByRole('button', { name: /mock submit place search/i }))
    const resultsSheet = await screen.findByLabelText(/map search results/i)
    expect(screen.queryByLabelText(/selected map place/i)).not.toBeInTheDocument()

    await userEvent.click(within(resultsSheet).getByRole('button', { name: /ramen street/i }))
    const detailSheet = await screen.findByLabelText(/selected map place/i)
    await userEvent.click(within(detailSheet).getByRole('button', { name: /add to trip/i }))

    expect(screen.getByLabelText(/activity name/i)).toHaveValue('Birthday dinner')
    expect(screen.getByLabelText(/^time$/i)).toHaveValue('18:30')
    expect(screen.getByLabelText(/^notes$/i)).toHaveValue('Window table')
    expect(screen.getByRole('button', { name: /category: meal/i })).toBeInTheDocument()
    expect(screen.getByText('1 Chome Marunouchi, Tokyo')).toBeInTheDocument()
  })

  it('keeps the mobile activity location target when returning to search results', async () => {
    mockViewport(true)
    const placedActivity = {
      ...SAMPLE_ACTIVITY,
      placeId: 'google.tsukiji',
      placeName: 'Tsukiji Outer Market',
      address: 'Tsukiji, Chuo City, Tokyo',
      lat: 35.6654,
      lng: 139.7707,
    }
    const ramenPlace = {
      businessStatus: 'OPERATIONAL',
      currentOpeningHours: null,
      displayName: 'Ramen Street',
      formattedAddress: '1 Chome Marunouchi, Tokyo',
      googleMapsUri: 'https://maps.google.com/?cid=ramen',
      id: 'google.ramen-street',
      lat: 35.6812,
      lng: 139.7671,
      photoUrl: null,
      primaryType: 'restaurant',
      primaryTypeDisplayName: 'Restaurant',
      rating: 4.4,
      regularOpeningHours: null,
      reviews: [],
      text: 'Ramen Street, 1 Chome Marunouchi, Tokyo',
      types: ['restaurant'],
      userRatingCount: 1200,
      websiteUri: null,
    }
    mockWorkspace([placedActivity])
    googlePlacesMockState.fetchGooglePlaceTextSearch.mockResolvedValueOnce({
      nextPageToken: null,
      places: [ramenPlace],
    })
    googlePlacesMockState.fetchGooglePlaceById.mockResolvedValue(ramenPlace)

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    const activityCard = (await screen.findByRole('heading', {
      name: /tsukiji sushi/i,
    })).closest('article')
    expect(activityCard).not.toBeNull()
    await userEvent.click(activityCard as HTMLElement)
    await userEvent.click(screen.getByRole('button', { name: /change on map/i }))

    await screen.findByTestId('trip-map')
    expect(screen.getByText(/updating location for tsukiji sushi/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /mock type ramen search/i }))
    await userEvent.click(screen.getByRole('button', { name: /mock submit place search/i }))

    const resultsSheet = await screen.findByLabelText(/map search results/i)
    await userEvent.click(within(resultsSheet).getByRole('button', { name: /ramen street/i }))
    const detailSheet = await screen.findByLabelText(/selected map place/i)
    expect(within(detailSheet).getByRole('button', { name: /confirm update/i })).toBeInTheDocument()

    await userEvent.click(within(detailSheet).getByRole('button', { name: /back to results/i }))
    const restoredResults = await screen.findByLabelText(/map search results/i)
    expect(screen.getByText(/updating location for tsukiji sushi/i)).toBeInTheDocument()
    await userEvent.click(
      within(restoredResults).getByRole('button', { name: /ramen street/i }),
    )

    expect(await within(screen.getByLabelText(/selected map place/i)).findByRole('button', {
      name: /confirm update/i,
    })).toBeInTheDocument()
  })

  it('shows a closable empty-results state after a successful mobile search', async () => {
    mockViewport(true)
    mockWorkspace()
    googlePlacesMockState.fetchGooglePlaceTextSearch.mockResolvedValueOnce({
      nextPageToken: null,
      places: [],
    })

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await userEvent.click(await screen.findByRole('button', { name: /^map$/i }))
    await userEvent.click(screen.getByRole('button', { name: /mock type ramen search/i }))
    await userEvent.click(screen.getByRole('button', { name: /mock submit place search/i }))

    const resultsSheet = await screen.findByLabelText(/map search results/i)
    expect(within(resultsSheet).getByRole('status')).toHaveTextContent(/no places found/i)
    const closeResults = within(resultsSheet).getByRole('button', { name: /close search results/i })
    await waitFor(() => {
      expect(closeResults).toHaveFocus()
    })
    await userEvent.click(closeResults)

    expect(screen.queryByLabelText(/map search results/i)).not.toBeInTheDocument()
    expect(screen.getByTestId('place-search-value')).toHaveTextContent('')
    expect(screen.getByRole('textbox', { name: /map place search/i })).toHaveFocus()
  })

  it('clears search results when a concrete place suggestion is selected', async () => {
    mockWorkspace()
    googlePlacesMockState.fetchGooglePlaceTextSearch.mockResolvedValueOnce({
      nextPageToken: null,
      places: [{
        businessStatus: 'OPERATIONAL',
        currentOpeningHours: null,
        displayName: 'Ramen Street',
        formattedAddress: '1 Chome Marunouchi, Tokyo',
        googleMapsUri: 'https://maps.google.com/?cid=ramen',
        id: 'google.ramen-street',
        lat: 35.6812,
        lng: 139.7671,
        photoUrl: null,
        primaryType: 'restaurant',
        primaryTypeDisplayName: 'Restaurant',
        rating: 4.4,
        regularOpeningHours: null,
        reviews: [],
        text: 'Ramen Street, 1 Chome Marunouchi, Tokyo',
        types: ['restaurant'],
        userRatingCount: 1200,
        websiteUri: null,
      }],
    })

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByTestId('trip-map')
    await userEvent.click(screen.getByRole('button', { name: /mock type ramen search/i }))
    await userEvent.click(screen.getByRole('button', { name: /mock submit place search/i }))

    expect(await within(screen.getByTestId('search-map-results')).findByText('Ramen Street')).toBeInTheDocument()
    expect(screen.getByLabelText(/map search results/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /mock place search/i }))

    expect(screen.queryByLabelText(/map search results/i)).not.toBeInTheDocument()
    expect(screen.getByTestId('search-map-results')).toBeEmptyDOMElement()
    expect(screen.getByTestId('selected-search-result')).toHaveTextContent('google.tokyo-tower')
    expect(screen.getByTestId('preview-map-place')).toHaveTextContent('Tokyo Tower')
    expect(screen.queryByLabelText(/activity name/i)).not.toBeInTheDocument()
    expect(within(screen.getByLabelText(/selected map place/i)).getByRole('heading', {
      name: /tokyo tower/i,
    })).toBeInTheDocument()
  })

  it('uses the exact Place ID from a native POI tap without a nearby lookup', async () => {
    const basicPlace = {
      businessStatus: 'OPERATIONAL',
      currentOpeningHours: null,
      displayName: 'Clicked Place',
      formattedAddress: 'Clicked address',
      googleMapsUri: 'https://maps.google.com/?cid=clicked',
      id: 'google.poi-clicked',
      lat: 35.7,
      lng: 139.8,
      photoUrl: 'https://example.com/clicked-place.webp',
      primaryType: 'tourist_attraction',
      primaryTypeDisplayName: 'Tourist attraction',
      rating: null,
      regularOpeningHours: null,
      reviews: [],
      text: 'Clicked Place, Clicked address',
      types: ['tourist_attraction'],
      userRatingCount: null,
      websiteUri: null,
    }
    let resolvePlaceDetails!: (place: typeof basicPlace) => void
    googlePlacesMockState.fetchGooglePlaceById.mockReturnValueOnce(new Promise((resolve) => {
      resolvePlaceDetails = resolve
    }))
    mockWorkspace()

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByTestId('trip-map')
    await userEvent.click(screen.getByRole('button', { name: /mock native poi click/i }))

    expect(within(screen.getByLabelText(/selected map place/i)).getByRole('heading', {
      name: /fetching place details/i,
    })).toBeInTheDocument()
    expect(screen.getByLabelText(/selected map place/i)).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByText(/fetching data/i)).toBeInTheDocument()
    await waitFor(() => {
      expect(googlePlacesMockState.fetchGooglePlaceById).toHaveBeenCalledWith({
        includePhoto: true,
        placeId: 'google.poi-clicked',
        traceId: 'test-native-poi-click',
      })
    })
    expect(googlePlacesMockState.fetchGooglePlaceById).toHaveBeenCalledTimes(1)
    expect(googlePlacesMockState.fetchGooglePlaceNearLocation).not.toHaveBeenCalled()
    expect(within(screen.getByLabelText(/selected map place/i)).queryByRole('button', {
      name: /add to trip/i,
    })).not.toBeInTheDocument()
    expect(within(screen.getByLabelText(/selected map place/i)).queryByRole('link', {
      name: /open in google maps/i,
    })).not.toBeInTheDocument()

    resolvePlaceDetails(basicPlace)

    expect(within(screen.getByTestId('search-map-results')).queryByText('Clicked Place')).not.toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('preview-map-place')).toHaveTextContent('Clicked Place')
      expect(within(screen.getByLabelText(/selected map place/i)).getByRole('heading', {
        name: /clicked place/i,
      })).toBeInTheDocument()
    })
    expect(within(screen.getByLabelText(/selected map place/i)).getByRole('img', {
      name: /clicked place/i,
    })).toHaveAttribute('src', 'https://example.com/clicked-place.webp')
    expect(within(screen.getByLabelText(/selected map place/i)).getByRole('link', {
      name: /open in google maps/i,
    })).toHaveAttribute('href', 'https://maps.google.com/?cid=clicked')
  })

  it('retains nearby resolution for a coordinate-only web map tap', async () => {
    mockWorkspace()

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByTestId('trip-map')
    await userEvent.click(screen.getByRole('button', { name: /mock map location click/i }))

    await waitFor(() => {
      expect(googlePlacesMockState.fetchGooglePlaceNearLocation).toHaveBeenCalledWith({
        includePhoto: true,
        options: {
          location: { lat: 35.7, lng: 139.8 },
          radius: 75,
          rankPreference: 'DISTANCE',
        },
      })
    })
    expect(googlePlacesMockState.fetchGooglePlaceById).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(within(screen.getByLabelText(/selected map place/i)).getByRole('heading', {
        name: /nearby cafe/i,
      })).toBeInTheDocument()
    })
    expect(screen.getByLabelText(/selected map place/i)).toHaveAttribute('aria-busy', 'false')
    expect(screen.getByTestId('coordinate-preview-map-place')).toHaveTextContent('none')
    expect(within(screen.getByLabelText(/selected map place/i)).getByRole('link', {
      name: /open in google maps/i,
    })).toHaveAttribute('href', 'https://maps.google.com/?cid=nearby')
  })

  it('falls back to a coordinate marker when a web map tap has no nearby place', async () => {
    googlePlacesMockState.fetchGooglePlaceNearLocation.mockResolvedValueOnce(null)
    mockWorkspace()

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByTestId('trip-map')
    await userEvent.click(screen.getByRole('button', { name: /mock map location click/i }))

    await waitFor(() => {
      expect(googlePlacesMockState.fetchGooglePlaceNearLocation).toHaveBeenCalledTimes(1)
      expect(screen.getByTestId('coordinate-preview-map-place')).toHaveTextContent('Selected location')
    })
    expect(screen.getByTestId('preview-map-place')).toHaveTextContent('none')
    expect(screen.queryByLabelText(/selected map place/i)).not.toBeInTheDocument()
  })

  it('keeps a blank native map tap as a coordinate without assuming a nearby place', async () => {
    mockWorkspace()

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByTestId('trip-map')
    await userEvent.click(screen.getByRole('button', { name: /mock native coordinate click/i }))

    expect(googlePlacesMockState.fetchGooglePlaceById).not.toHaveBeenCalled()
    expect(googlePlacesMockState.fetchGooglePlaceNearLocation).not.toHaveBeenCalled()
    expect(screen.getByTestId('coordinate-preview-map-place')).toHaveTextContent('Selected location')
    expect(screen.getByTestId('preview-map-place')).toHaveTextContent('none')
    expect(screen.queryByLabelText(/selected map place/i)).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Selected location: 35.70010, 139.80010. No place details available.',
    )
  })

  it('treats a native POI event with a blank Place ID as a coordinate, not a nearby place', async () => {
    mockWorkspace()

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByTestId('trip-map')
    await userEvent.click(screen.getByRole('button', { name: /mock invalid native poi click/i }))

    expect(googlePlacesMockState.fetchGooglePlaceById).not.toHaveBeenCalled()
    expect(googlePlacesMockState.fetchGooglePlaceNearLocation).not.toHaveBeenCalled()
    expect(screen.getByTestId('coordinate-preview-map-place')).toHaveTextContent('Selected location')
  })

  it('keeps the active place details card when text search results open', async () => {
    googlePlacesMockState.fetchGooglePlaceTextSearch.mockResolvedValueOnce({
      nextPageToken: null,
      places: [{
        businessStatus: 'OPERATIONAL',
        currentOpeningHours: null,
        displayName: 'Ramen Street',
        formattedAddress: '1 Chome Marunouchi, Tokyo',
        googleMapsUri: 'https://maps.google.com/?cid=ramen',
        id: 'google.ramen-street',
        lat: 35.6812,
        lng: 139.7671,
        photoUrl: null,
        primaryType: 'restaurant',
        primaryTypeDisplayName: 'Restaurant',
        rating: 4.4,
        regularOpeningHours: null,
        reviews: [],
        text: 'Ramen Street, 1 Chome Marunouchi, Tokyo',
        types: ['restaurant'],
        userRatingCount: 1200,
        websiteUri: null,
      }],
    })
    mockWorkspace()

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByTestId('trip-map')
    await userEvent.click(screen.getByRole('button', { name: /mock map place click/i }))

    await waitFor(() => {
      expect(within(screen.getByLabelText(/selected map place/i)).getByRole('heading', {
        name: /clicked place/i,
      })).toBeInTheDocument()
    })

    await userEvent.click(screen.getByRole('button', { name: /mock type ramen search/i }))
    await userEvent.click(screen.getByRole('button', { name: /mock submit place search/i }))

    expect(await within(screen.getByTestId('search-map-results')).findByText('Ramen Street')).toBeInTheDocument()
    expect(screen.getByLabelText(/map search results/i)).toBeInTheDocument()
    expect(within(screen.getByLabelText(/selected map place/i)).getByRole('heading', {
      name: /clicked place/i,
    })).toBeInTheDocument()
  })

  it('replaces the active details card when a search result is selected', async () => {
    const ramenDetails = {
      businessStatus: 'OPERATIONAL',
      currentOpeningHours: null,
      displayName: 'Ramen Street Details',
      formattedAddress: '1 Chome Marunouchi, Tokyo',
      googleMapsUri: 'https://maps.google.com/?cid=ramen',
      id: 'google.ramen-street',
      lat: 35.6812,
      lng: 139.7671,
      photoUrl: null,
      primaryType: 'restaurant',
      primaryTypeDisplayName: 'Restaurant',
      rating: 4.6,
      regularOpeningHours: null,
      reviews: [],
      text: 'Ramen Street Details, 1 Chome Marunouchi, Tokyo',
      types: ['restaurant'],
      userRatingCount: 1300,
      websiteUri: null,
    }
    googlePlacesMockState.fetchGooglePlaceById
      .mockResolvedValueOnce({
        businessStatus: 'OPERATIONAL',
        currentOpeningHours: null,
        displayName: 'Clicked Place',
        formattedAddress: 'Clicked address',
        googleMapsUri: 'https://maps.google.com/?cid=clicked',
        id: 'google.poi-clicked',
        lat: 35.7,
        lng: 139.8,
        photoUrl: null,
        primaryType: 'tourist_attraction',
        primaryTypeDisplayName: 'Tourist attraction',
        rating: null,
        regularOpeningHours: null,
        reviews: [],
        text: 'Clicked Place, Clicked address',
        types: ['tourist_attraction'],
        userRatingCount: null,
        websiteUri: null,
      })
      .mockResolvedValueOnce(ramenDetails)
    googlePlacesMockState.fetchGooglePlaceTextSearch.mockResolvedValueOnce({
      nextPageToken: null,
      places: [{
        ...ramenDetails,
        displayName: 'Ramen Street',
        rating: 4.4,
        userRatingCount: 1200,
      }],
    })
    mockWorkspace()

    renderWorkspace('/trips/abc234def567/d/2026-05-01')

    await screen.findByTestId('trip-map')
    await userEvent.click(screen.getByRole('button', { name: /mock map place click/i }))
    await waitFor(() => {
      expect(within(screen.getByLabelText(/selected map place/i)).getByRole('heading', {
        name: /clicked place/i,
      })).toBeInTheDocument()
    })

    await userEvent.click(screen.getByRole('button', { name: /mock type ramen search/i }))
    await userEvent.click(screen.getByRole('button', { name: /mock submit place search/i }))
    expect(await within(screen.getByTestId('search-map-results')).findByText('Ramen Street')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /mock select search result/i }))

    await waitFor(() => {
      expect(within(screen.getByLabelText(/selected map place/i)).getByRole('heading', {
        name: /ramen street details/i,
      })).toBeInTheDocument()
    })
    expect(screen.getByTestId('selected-search-result')).toHaveTextContent('google.ramen-street')
  })

  it('updates trip settings, warns about hidden activities, and navigates to a valid day', async () => {
    const dayFiveActivity = {
      ...SAMPLE_ACTIVITY,
      id: 55,
      dayDate: '2026-05-05',
      title: 'Last day breakfast',
    }
    mockWorkspace([dayFiveActivity])
    apiMock.onPatch('/trips/abc234def567').reply(200, {
      ...SAMPLE_TRIP,
      name: 'Tokyo and Kyoto',
      destination: 'Kyoto, Japan',
      imageUrl: 'https://example.com/kyoto.jpg',
      startDate: '2026-05-02',
      endDate: '2026-05-03',
    })

    renderWorkspace('/trips/abc234def567/d/2026-05-05')

    await userEvent.click(await screen.findByRole('button', { name: /^settings$/i }))
    const settingsDialog = screen.getByRole('dialog', { name: /trip settings/i })
    expect(settingsDialog).toBeInTheDocument()

    const nameInput = screen.getByLabelText(/trip name/i)
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, 'Tokyo and Kyoto')
    const destinationInput = screen.getByLabelText(/destination/i)
    await userEvent.clear(destinationInput)
    await userEvent.type(destinationInput, 'Kyoto, Japan')
    await userEvent.type(screen.getByLabelText(/cover image url/i), 'https://example.com/kyoto.jpg')
    await userEvent.click(screen.getByRole('button', { name: /trip dates/i }))
    const datePickerDialog = screen.getByRole('dialog', { name: /trip dates/i })
    await userEvent.click(within(datePickerDialog).getByRole('button', {
      name: /choose saturday, may 2, 2026/i,
    }))
    await userEvent.click(within(datePickerDialog).getByRole('button', {
      name: /choose sunday, may 3, 2026/i,
    }))
    expect(screen.queryByText(/round trip/i)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /done/i }))

    expect(screen.getByText(/1 activity will be outside/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => {
      expect(apiMock.history.patch[0].url).toBe('/trips/abc234def567')
    })
    expect(JSON.parse(apiMock.history.patch[0].data as string)).toEqual({
      name: 'Tokyo and Kyoto',
      destination: 'Kyoto, Japan',
      imageUrl: 'https://example.com/kyoto.jpg',
      startDate: '2026-05-02',
      endDate: '2026-05-03',
      expectedVersion: 0,
    })
    expect(await screen.findByRole('heading', { level: 2, name: /sunday, may 3/i })).toBeInTheDocument()
  })

  it('keeps the settings draft and reloads the trip after an edit conflict', async () => {
    const latestTrip = { ...SAMPLE_TRIP, name: 'Edited elsewhere', version: 1 }
    apiMock.onGet('/trips/abc234def567').replyOnce(200, SAMPLE_TRIP)
    apiMock.onGet('/trips/abc234def567').reply(200, latestTrip)
    apiMock.onGet('/trips/abc234def567/activities').reply(200, [])
    apiMock.onPatch('/trips/abc234def567').replyOnce(409, { error: 'edit_conflict' })
    apiMock.onPatch('/trips/abc234def567').reply((config) => [
      200,
      { ...latestTrip, name: JSON.parse(config.data as string).name, version: 2 },
    ])

    renderWorkspace('/trips/abc234def567')

    await userEvent.click(await screen.findByRole('button', { name: /^settings$/i }))
    const nameInput = screen.getByLabelText(/trip name/i)
    await userEvent.clear(nameInput)
    await userEvent.type(nameInput, 'Keep my draft')
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }))

    expect(await screen.findByText(/latest details were reloaded/i)).toBeInTheDocument()
    expect(nameInput).toHaveValue('Keep my draft')
    await waitFor(() => {
      expect(apiMock.history.get.filter((request) => request.url === '/trips/abc234def567'))
        .toHaveLength(2)
    })
    expect(JSON.parse(apiMock.history.patch[0].data as string)).toMatchObject({
      name: 'Keep my draft',
      expectedVersion: 0,
    })

    await userEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => {
      expect(apiMock.history.patch).toHaveLength(2)
    })
    expect(JSON.parse(apiMock.history.patch[1].data as string)).toMatchObject({
      name: 'Keep my draft',
      expectedVersion: 1,
    })
    expect(screen.queryByRole('dialog', { name: /trip settings/i })).not.toBeInTheDocument()
  })

  it('shows 404 state for inaccessible or unknown trip', async () => {
    apiMock.onGet('/trips/abc234def567').reply(404, { error: 'not_found' })

    renderWorkspace('/trips/abc234def567')

    expect(await screen.findByRole('heading', { name: /404/i })).toBeInTheDocument()
    expect(screen.getByText(/does not exist or is not shared/i)).toBeInTheDocument()
  })

  it('shows generic error state and retries', async () => {
    apiMock
      .onGet('/trips/abc234def567')
      .replyOnce(500, {})
      .onGet('/trips/abc234def567')
      .reply(200, SAMPLE_TRIP)

    renderWorkspace('/trips/abc234def567')

    expect(await screen.findByRole('alert')).toHaveTextContent(/server ran into a problem/i)

    await userEvent.click(screen.getByRole('button', { name: /retry/i }))

    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: /tokyo 2026/i })).toBeInTheDocument()
    })
  })
})
