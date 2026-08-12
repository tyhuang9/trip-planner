import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render as renderBase, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { PropsWithChildren, ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDrivingDirections } from '../api/googleMapsRoute'
import type { Activity } from '../types/activity'
import { TripMap } from './TripMap'

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })
}

function render(ui: ReactNode, queryClient = createTestQueryClient()) {
  const result = renderBase(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  )
  return {
    ...result,
    queryClient,
    rerender: (nextUi: ReactNode) => result.rerender(
      <QueryClientProvider client={queryClient}>{nextUi}</QueryClientProvider>,
    ),
  }
}

const geocodeMock = vi.hoisted(() => ({
  geocodeDestination: vi.fn(),
}))

const mapControlMock = vi.hoisted(() => ({
  fitBounds: vi.fn(),
  moveCamera: vi.fn(),
}))

const mapMockState = vi.hoisted(() => ({
  apiStatus: 'LOADED',
  clickableIcons: null as null | boolean,
  currentMapTypeId: 'roadmap',
  disableDefaultUI: null as null | boolean,
  mapTypeId: null as null | string,
  mapTypeControl: null as null | boolean,
  onCameraChanged: null as null | ((event: {
    detail: {
      bounds?: { north: number; south: number; east: number; west: number }
      center: { lat: number; lng: number }
      zoom: number
    }
  }) => void),
  onClick: null as null | ((event: {
    detail: {
      latLng?: { lat: number; lng: number } | null
      placeId?: string | null
    }
    stop: () => void
  }) => void),
  onTilesLoaded: null as null | (() => void),
  preventMapHitsAndGesturesFrom: vi.fn(),
  zoomControl: null as null | boolean,
}))

vi.mock('../api/googleMapsRoute', () => ({
  getDrivingDirections: vi.fn(),
}))

vi.mock('../api/googleMapsGeocode', () => ({
  geocodeDestination: geocodeMock.geocodeDestination,
}))

vi.mock('@vis.gl/react-google-maps', () => {
  const googleMap = {
    fitBounds: mapControlMock.fitBounds,
    getBounds: () => ({
      toJSON: () => ({ north: 35.7, south: 35.6, east: 139.8, west: 139.7 }),
    }),
    getCenter: () => ({ lat: () => 35.6586, lng: () => 139.7454 }),
    getMapTypeId: () => mapMockState.currentMapTypeId,
    getZoom: () => 11,
    moveCamera: mapControlMock.moveCamera,
  }

  return {
    APILoadingStatus: {
      AUTH_FAILURE: 'AUTH_FAILURE',
      FAILED: 'FAILED',
      LOADED: 'LOADED',
      LOADING: 'LOADING',
      NOT_LOADED: 'NOT_LOADED',
    },
    Map: ({
      children,
      clickableIcons,
      disableDefaultUI,
      mapTypeId,
      mapTypeControl,
      onCameraChanged,
      onClick,
      onTilesLoaded,
      zoomControl,
    }: PropsWithChildren<{
      clickableIcons?: boolean
      disableDefaultUI?: boolean
      mapTypeId?: string
      mapTypeControl?: boolean
      onCameraChanged?: typeof mapMockState.onCameraChanged
      onClick?: typeof mapMockState.onClick
      onTilesLoaded?: () => void
      zoomControl?: boolean
    }>) => {
      mapMockState.clickableIcons = clickableIcons ?? null
      mapMockState.disableDefaultUI = disableDefaultUI ?? null
      mapMockState.mapTypeId = mapTypeId ?? null
      mapMockState.mapTypeControl = mapTypeControl ?? null
      mapMockState.onCameraChanged = onCameraChanged ?? null
      mapMockState.onClick = onClick ?? null
      mapMockState.onTilesLoaded = onTilesLoaded ?? null
      mapMockState.zoomControl = zoomControl ?? null
      return <div data-testid="map">{children}</div>
    },
    Polyline: ({
      children,
      onClick,
      onMouseOut,
      onMouseOver,
      path,
      strokeColor,
      strokeOpacity,
      strokeWeight,
    }: {
      children?: ReactNode
      onClick?: (event: { latLng: { lat: () => number; lng: () => number } }) => void
      onMouseOut?: (event: Record<string, never>) => void
      onMouseOver?: (event: { latLng: { lat: () => number; lng: () => number } }) => void
      path?: Array<{ lat: number; lng: number }>
      strokeColor?: string
      strokeOpacity?: number
      strokeWeight?: number
    }) => {
      const routeMouseEvent = {
        latLng: {
          lat: () => 35.662,
          lng: () => 139.758,
        },
      }
      return (
        <button
          type="button"
          data-testid="route-layer"
          data-path-length={path?.length ?? 0}
          data-stroke-color={strokeColor ?? ''}
          data-stroke-opacity={strokeOpacity ?? ''}
          data-stroke-weight={strokeWeight ?? ''}
          onClick={() => onClick?.(routeMouseEvent)}
          onMouseEnter={() => onMouseOver?.(routeMouseEvent)}
          onMouseLeave={() => onMouseOut?.({})}
        >
          {children}
        </button>
      )
    },
    useApiLoadingStatus: () => mapMockState.apiStatus,
    useMap: () => googleMap,
  }
})

const ACTIVITIES: Activity[] = [
  {
    id: 10,
    dayDate: '2026-05-01',
    category: 'ACTIVITY',
    startTime: null,
    endTime: null,
    title: 'Tokyo Tower',
    notes: null,
    placeId: 'google.tokyo-tower',
    placeName: 'Tokyo Tower',
    address: null,
    lat: 35.6586,
    lng: 139.7454,
    orderIndex: 0,
    createdByUserDisplayName: 'Alice',
    updatedByUserDisplayName: 'Alice',
    createdAt: '2026-05-01T12:00:00Z',
    updatedAt: '2026-05-01T12:00:00Z',
    version: 0,
  },
  {
    id: 11,
    dayDate: '2026-05-01',
    category: 'MEAL',
    startTime: null,
    endTime: null,
    title: 'Tsukiji Market',
    notes: null,
    placeId: 'google.tsukiji',
    placeName: 'Tsukiji Market',
    address: null,
    lat: 35.6654,
    lng: 139.7707,
    orderIndex: 1,
    createdByUserDisplayName: 'Alice',
    updatedByUserDisplayName: 'Alice',
    createdAt: '2026-05-01T12:00:00Z',
    updatedAt: '2026-05-01T12:00:00Z',
    version: 0,
  },
]

function runtimeActivity(overrides: Record<string, unknown>): Activity {
  return { ...ACTIVITIES[0], ...overrides } as unknown as Activity
}

function activityWithoutCoordinateKeys(): Activity {
  const activity = {
    ...ACTIVITIES[0],
    id: 99,
    title: 'Missing Coordinates',
  } as Record<string, unknown>
  delete activity.lat
  delete activity.lng
  return activity as unknown as Activity
}

function installGoogleOverlayMock() {
  class OverlayViewMock {
    onAdd: () => void = () => {}
    draw: () => void = () => {}
    onRemove: () => void = () => {}

    getPanes() {
      return { overlayMouseTarget: document.body }
    }

    getProjection() {
      return {
        fromLatLngToDivPixel: () => ({ x: 0, y: 0 }),
      }
    }

    setMap(map: unknown) {
      if (map) {
        this.onAdd()
        this.draw()
      } else {
        this.onRemove()
      }
    }
  }

  Object.assign(OverlayViewMock, {
    preventMapHitsAndGesturesFrom: mapMockState.preventMapHitsAndGesturesFrom,
  })

  const googleMock = {
    maps: {
      OverlayView: OverlayViewMock,
    },
  }
  Object.defineProperty(globalThis, 'google', {
    configurable: true,
    value: googleMock,
  })
  Object.defineProperty(window, 'google', {
    configurable: true,
    value: googleMock,
  })
}

const directionsMock = vi.mocked(getDrivingDirections)

function testRoute(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
  duration = 720,
  distance = 2400,
): NonNullable<Awaited<ReturnType<typeof getDrivingDirections>>> {
  return {
    distance,
    duration,
    legs: [{
      distance,
      duration,
      path: [from, to],
    }],
    path: [from, to],
  }
}

function createMultiDayRouteActivities(dayCount: number): Activity[] {
  return Array.from({ length: dayCount }, (_, dayIndex) => [
    runtimeActivity({
      id: 100 + dayIndex * 2,
      dayDate: `2026-05-${String(dayIndex + 1).padStart(2, '0')}`,
      lat: 35.6 + dayIndex * 0.01,
      lng: 139.7 + dayIndex * 0.01,
      orderIndex: 0,
    }),
    runtimeActivity({
      id: 101 + dayIndex * 2,
      dayDate: `2026-05-${String(dayIndex + 1).padStart(2, '0')}`,
      lat: 35.605 + dayIndex * 0.01,
      lng: 139.705 + dayIndex * 0.01,
      orderIndex: 1,
    }),
  ]).flat()
}

async function advanceRouteTimersByTime(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds)
  })
}

beforeEach(() => {
  vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'gmaps.test')
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    },
  })
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: vi.fn(),
  })
  installGoogleOverlayMock()
  geocodeMock.geocodeDestination.mockResolvedValue(null)
  mapControlMock.fitBounds.mockClear()
  mapControlMock.moveCamera.mockClear()
  mapMockState.apiStatus = 'LOADED'
  mapMockState.clickableIcons = null
  mapMockState.currentMapTypeId = 'roadmap'
  mapMockState.disableDefaultUI = null
  mapMockState.mapTypeId = null
  mapMockState.mapTypeControl = null
  mapMockState.onCameraChanged = null
  mapMockState.onClick = null
  mapMockState.onTilesLoaded = null
  mapMockState.zoomControl = null
  mapMockState.preventMapHitsAndGesturesFrom.mockClear()
  directionsMock.mockResolvedValue({
    distance: 2400,
    duration: 720,
    legs: [{
      distance: 2400,
      duration: 720,
      path: [
        { lat: 35.6586, lng: 139.7454 },
        { lat: 35.662, lng: 139.758 },
        { lat: 35.6654, lng: 139.7707 },
      ],
    }],
    path: [
      { lat: 35.6586, lng: 139.7454 },
      { lat: 35.6654, lng: 139.7707 },
    ],
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  vi.unstubAllEnvs()
})

describe('<TripMap>', () => {
  it('renders markers and route legs without showing duration labels by default', async () => {
    render(<TripMap activities={ACTIVITIES} fallbackActivities={[]} destination="Tokyo" />)

    expect(screen.getByRole('region', { name: 'Map for Tokyo' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /stop 1: tokyo tower/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /stop 2: tsukiji market/i })).toBeInTheDocument()

    await waitFor(() => {
      expect(directionsMock).toHaveBeenCalledWith(
        ACTIVITIES,
        expect.any(AbortSignal),
      )
    })
    expect(screen.queryByText('12 min')).not.toBeInTheDocument()
    expect(await screen.findByText('12 min total · 2.4 km')).toBeInTheDocument()
    expect(screen.getByTestId('route-layer')).toHaveAttribute('data-path-length', '3')
    expect(geocodeMock.geocodeDestination).not.toHaveBeenCalled()
  })

  it('renders one route summary in a supplied mobile overlay host', async () => {
    const routeSummaryHost = document.createElement('div')
    document.body.append(routeSummaryHost)

    try {
      render(
        <TripMap
          activities={ACTIVITIES}
          fallbackActivities={[]}
          destination="Tokyo"
          routeSummaryClassName="mobile-route-summary"
          routeSummaryContainer={routeSummaryHost}
        />,
      )

      await waitFor(() => {
        expect(routeSummaryHost).toHaveTextContent('12 min total · 2.4 km')
      })

      expect(routeSummaryHost.querySelector('.mobile-route-summary')).toBeInTheDocument()
      expect(document.body.querySelectorAll('[aria-live="polite"]')).toHaveLength(1)
    } finally {
      routeSummaryHost.remove()
    }
  })

  it('requests and renders independent routes for each day without cross-day legs', async () => {
    const dayTwoActivities = [
      runtimeActivity({
        id: 20,
        dayDate: '2026-05-02',
        title: 'Ferry Building',
        lat: 35.68,
        lng: 139.76,
        orderIndex: 0,
      }),
      runtimeActivity({
        id: 21,
        dayDate: '2026-05-02',
        title: 'Museum Stop',
        lat: 35.69,
        lng: 139.75,
        orderIndex: 1,
      }),
    ]
    directionsMock.mockImplementation(async (activities) =>
      testRoute(activities[0], activities[1]),
    )

    render(
      <TripMap
        activities={[...ACTIVITIES, ...dayTwoActivities]}
        fallbackActivities={[]}
        routeActivities={[...ACTIVITIES, ...dayTwoActivities]}
        destination="Tokyo"
      />,
    )

    await waitFor(() => {
      expect(directionsMock).toHaveBeenCalledTimes(2)
    })
    expect(directionsMock).toHaveBeenNthCalledWith(
      1,
      ACTIVITIES,
      expect.any(AbortSignal),
    )
    expect(directionsMock).toHaveBeenNthCalledWith(
      2,
      dayTwoActivities,
      expect.any(AbortSignal),
    )
    expect(directionsMock).not.toHaveBeenCalledWith(
      [ACTIVITIES[1], dayTwoActivities[0]],
      expect.any(AbortSignal),
    )
    expect(await screen.findAllByTestId('route-layer')).toHaveLength(2)
    expect(screen.getByText('24 min total · 4.8 km across 2 days')).toBeInTheDocument()
    expect(screen.getByText('Visible-days routes')).toBeInTheDocument()
  })

  it('paces route request starts at least 600 ms apart while eventually routing every day', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-01T12:00:00Z'))
    const routeActivities = createMultiDayRouteActivities(3)
    const requestStartTimes: number[] = []
    directionsMock.mockImplementation(async (activities) => {
      requestStartTimes.push(Date.now())
      return testRoute(activities[0], activities[1])
    })

    const view = render(
      <TripMap
        activities={routeActivities}
        fallbackActivities={[]}
        routeActivities={routeActivities}
        destination="Tokyo"
      />,
    )

    await advanceRouteTimersByTime(0)
    expect(directionsMock).toHaveBeenCalledTimes(1)

    await advanceRouteTimersByTime(599)
    expect(directionsMock).toHaveBeenCalledTimes(1)

    await advanceRouteTimersByTime(1)
    expect(directionsMock).toHaveBeenCalledTimes(2)

    await advanceRouteTimersByTime(599)
    expect(directionsMock).toHaveBeenCalledTimes(2)

    await advanceRouteTimersByTime(1)
    expect(directionsMock).toHaveBeenCalledTimes(3)
    await advanceRouteTimersByTime(1)
    expect(requestStartTimes[1] - requestStartTimes[0]).toBeGreaterThanOrEqual(600)
    expect(requestStartTimes[2] - requestStartTimes[1]).toBeGreaterThanOrEqual(600)
    expect(screen.getAllByTestId('route-layer')).toHaveLength(3)
    expect(screen.getByText('36 min total · 7.2 km across 3 days')).toBeInTheDocument()
    view.unmount()
    vi.clearAllTimers()
  })

  it('keeps successful routes visible and reports a resolved null day as unavailable', async () => {
    vi.useFakeTimers()
    const routeActivities = createMultiDayRouteActivities(2)
    directionsMock
      .mockImplementationOnce(async (activities) => testRoute(activities[0], activities[1]))
      .mockResolvedValueOnce(null)

    const view = render(
      <TripMap
        activities={routeActivities}
        fallbackActivities={[]}
        routeActivities={routeActivities}
        destination="Tokyo"
      />,
    )

    await advanceRouteTimersByTime(600)
    await advanceRouteTimersByTime(1)

    expect(directionsMock).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Route unavailable for 1 day.')).toBeInTheDocument()
    expect(screen.getAllByTestId('route-layer')).toHaveLength(1)
    expect(screen.getByText('12 min total · 2.4 km across 1 of 2 days')).toBeInTheDocument()
    view.unmount()
    vi.clearAllTimers()
  })

  it('reports all resolved null routes as unavailable without showing an empty summary', async () => {
    vi.useFakeTimers()
    const routeActivities = createMultiDayRouteActivities(2)
    directionsMock.mockResolvedValue(null)

    const view = render(
      <TripMap
        activities={routeActivities}
        fallbackActivities={[]}
        routeActivities={routeActivities}
        destination="Tokyo"
      />,
    )

    await advanceRouteTimersByTime(600)
    await advanceRouteTimersByTime(1)

    expect(directionsMock).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Route unavailable for 2 days.')).toBeInTheDocument()
    expect(screen.queryByTestId('route-layer')).not.toBeInTheDocument()
    expect(screen.queryByText(/total ·/i)).not.toBeInTheDocument()
    view.unmount()
    vi.clearAllTimers()
  })

  it('routes each day in itinerary order even when route activities arrive out of order', async () => {
    const breakfast = runtimeActivity({
      id: 30,
      dayDate: '2026-05-03',
      title: 'Breakfast',
      startTime: '09:00',
      lat: 35.7,
      lng: 139.74,
      orderIndex: 0,
    })
    const museum = runtimeActivity({
      id: 31,
      dayDate: '2026-05-03',
      title: 'Museum',
      startTime: '11:00',
      lat: 35.71,
      lng: 139.75,
      orderIndex: 1,
    })
    directionsMock.mockImplementation(async (activities) =>
      testRoute(activities[0], activities[1]),
    )

    render(
      <TripMap
        activities={[breakfast, museum]}
        fallbackActivities={[]}
        routeActivities={[museum, breakfast]}
        destination="Tokyo"
      />,
    )

    await waitFor(() => {
      expect(directionsMock).toHaveBeenCalledWith(
        [breakfast, museum],
        expect.any(AbortSignal),
      )
    })
  })

  it('keeps successful day routes visible when another day route fails', async () => {
    const dayTwoActivities = [
      runtimeActivity({
        id: 20,
        dayDate: '2026-05-02',
        lat: 35.68,
        lng: 139.76,
        orderIndex: 0,
      }),
      runtimeActivity({
        id: 21,
        dayDate: '2026-05-02',
        lat: 35.69,
        lng: 139.75,
        orderIndex: 1,
      }),
    ]
    directionsMock.mockImplementation(async (activities) => {
      if (activities[0].lat === dayTwoActivities[0].lat) {
        throw {
          isAxiosError: true,
          response: {
            status: 502,
            data: { error: 'google_maps_unavailable' },
          },
        }
      }
      return testRoute(activities[0], activities[1])
    })

    render(
      <TripMap
        activities={[...ACTIVITIES, ...dayTwoActivities]}
        fallbackActivities={[]}
        routeActivities={[...ACTIVITIES, ...dayTwoActivities]}
        destination="Tokyo"
      />,
    )

    expect(await screen.findByText(/route unavailable/i, {}, { timeout: 3_000 })).toBeInTheDocument()
    expect(screen.getByTestId('route-layer')).toBeInTheDocument()
    expect(screen.getByText('12 min total · 2.4 km across 1 of 2 days')).toBeInTheDocument()
  })

  it('does not route single-stop, malformed, or unscheduled day groups', async () => {
    const singleStop = runtimeActivity({
      id: 20,
      dayDate: '2026-05-02',
      lat: 35.68,
      lng: 139.76,
    })
    const validBeforeMalformed = runtimeActivity({
      id: 30,
      dayDate: '2026-05-03',
      lat: 35.7,
      lng: 139.74,
    })
    const malformedStop = runtimeActivity({
      id: 31,
      dayDate: '2026-05-03',
      lat: Number.NaN,
      lng: 139.75,
    })
    const unscheduledStops = [
      runtimeActivity({ id: 40, dayDate: null, lat: 35.71, lng: 139.73 }),
      runtimeActivity({ id: 41, dayDate: null, lat: 35.72, lng: 139.72 }),
    ]

    render(
      <TripMap
        activities={ACTIVITIES}
        fallbackActivities={[]}
        routeActivities={[
          ...ACTIVITIES,
          singleStop,
          validBeforeMalformed,
          malformedStop,
          ...unscheduledStops,
        ]}
        destination="Tokyo"
      />,
    )

    await waitFor(() => {
      expect(directionsMock).toHaveBeenCalledTimes(1)
    })
    expect(directionsMock).toHaveBeenCalledWith(ACTIVITIES, expect.any(AbortSignal))
  })

  it('limits route calculation to four concurrent day requests', async () => {
    vi.useFakeTimers()
    let activeRequests = 0
    let maxActiveRequests = 0
    let releaseFirstWave = () => {}
    const firstWaveGate = new Promise<void>((resolve) => {
      releaseFirstWave = resolve
    })
    let requestIndex = 0
    directionsMock.mockImplementation(async (activities) => {
      const currentRequestIndex = requestIndex
      requestIndex += 1
      activeRequests += 1
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
      if (currentRequestIndex < 4) await firstWaveGate
      activeRequests -= 1
      return testRoute(activities[0], activities[1])
    })
    const routeActivities = createMultiDayRouteActivities(6)

    const view = render(
      <TripMap
        activities={routeActivities}
        fallbackActivities={[]}
        routeActivities={routeActivities}
        destination="Tokyo"
      />,
    )

    await advanceRouteTimersByTime(0)
    expect(directionsMock).toHaveBeenCalledTimes(1)
    await advanceRouteTimersByTime(600)
    expect(directionsMock).toHaveBeenCalledTimes(2)
    await advanceRouteTimersByTime(600)
    expect(directionsMock).toHaveBeenCalledTimes(3)
    await advanceRouteTimersByTime(600)
    expect(directionsMock).toHaveBeenCalledTimes(4)
    expect(maxActiveRequests).toBe(4)

    await act(async () => {
      releaseFirstWave()
      await firstWaveGate
    })

    await advanceRouteTimersByTime(599)
    expect(directionsMock).toHaveBeenCalledTimes(4)
    await advanceRouteTimersByTime(1)
    expect(directionsMock).toHaveBeenCalledTimes(5)
    await advanceRouteTimersByTime(600)
    expect(directionsMock).toHaveBeenCalledTimes(6)
    await advanceRouteTimersByTime(1)
    expect(maxActiveRequests).toBe(4)
    expect(screen.getAllByTestId('route-layer')).toHaveLength(6)
    expect(screen.getByText('1 hr 12 min total · 14.4 km across 6 days')).toBeInTheDocument()
    view.unmount()
    vi.clearAllTimers()
  })

  it('aborts active route signals and never launches queued requests after unmount', async () => {
    vi.useFakeTimers()
    const routeActivities = createMultiDayRouteActivities(6)
    const startedSignals: AbortSignal[] = []
    const resolveRequests: Array<() => void> = []
    directionsMock.mockImplementation((activities, signal) => new Promise((resolve) => {
      if (signal) startedSignals.push(signal)
      resolveRequests.push(() => resolve(testRoute(activities[0], activities[1])))
    }))

    const view = render(
      <TripMap
        activities={routeActivities}
        fallbackActivities={[]}
        routeActivities={routeActivities}
        destination="Tokyo"
      />,
    )

    await advanceRouteTimersByTime(0)
    await advanceRouteTimersByTime(600)
    await advanceRouteTimersByTime(600)
    await advanceRouteTimersByTime(600)
    expect(directionsMock).toHaveBeenCalledTimes(4)
    expect(startedSignals).toHaveLength(4)

    view.unmount()

    expect(startedSignals.every((signal) => signal.aborted)).toBe(true)
    await advanceRouteTimersByTime(10_000)
    expect(directionsMock).toHaveBeenCalledTimes(4)

    await act(async () => {
      resolveRequests.forEach((resolveRequest) => resolveRequest())
      await Promise.resolve()
    })
    await advanceRouteTimersByTime(10_000)
    expect(directionsMock).toHaveBeenCalledTimes(4)
    vi.clearAllTimers()
  })

  it('shows only the hovered or tapped route leg duration', async () => {
    const user = userEvent.setup()
    render(<TripMap activities={ACTIVITIES} fallbackActivities={[]} destination="Tokyo" />)

    await waitFor(() => {
      expect(directionsMock).toHaveBeenCalledTimes(1)
    })
    const routeLayer = await screen.findByTestId('route-layer')

    expect(screen.queryByText('12 min')).not.toBeInTheDocument()
    await user.hover(routeLayer)
    expect(await screen.findByText('12 min')).toBeInTheDocument()
    expect(routeLayer).toHaveAttribute('data-stroke-weight', '6')

    await user.unhover(routeLayer)
    await waitFor(() => {
      expect(screen.queryByText('12 min')).not.toBeInTheDocument()
    })

    await user.click(routeLayer)
    expect(await screen.findByText('12 min')).toBeInTheDocument()
  })

  it('falls back to the full route line when route legs have no paths', async () => {
    directionsMock.mockResolvedValueOnce({
      distance: 2400,
      duration: 720,
      legs: [{
        distance: 2400,
        duration: 720,
      } as NonNullable<Awaited<ReturnType<typeof getDrivingDirections>>>['legs'][number]],
      path: [
        { lat: 35.6586, lng: 139.7454 },
        { lat: 35.6654, lng: 139.7707 },
      ],
    })

    render(<TripMap activities={ACTIVITIES} fallbackActivities={[]} destination="Tokyo" />)

    await waitFor(() => {
      expect(directionsMock).toHaveBeenCalledTimes(1)
    })
    expect(await screen.findByTestId('route-layer')).toHaveAttribute('data-path-length', '2')
    expect(screen.getByText('12 min total · 2.4 km')).toBeInTheDocument()
    expect(screen.queryByText('12 min')).not.toBeInTheDocument()
  })

  it('ignores undefined cached route legs and falls back to the full route line', async () => {
    directionsMock.mockResolvedValueOnce({
      distance: 2400,
      duration: 720,
      legs: [
        undefined as unknown as NonNullable<Awaited<ReturnType<typeof getDrivingDirections>>>['legs'][number],
      ],
      path: [
        { lat: 35.6586, lng: 139.7454 },
        { lat: 35.6654, lng: 139.7707 },
      ],
    })

    render(<TripMap activities={ACTIVITIES} fallbackActivities={[]} destination="Tokyo" />)

    await waitFor(() => {
      expect(directionsMock).toHaveBeenCalledTimes(1)
    })
    expect(await screen.findByTestId('route-layer')).toHaveAttribute('data-path-length', '2')
    expect(screen.getByText('12 min total · 2.4 km')).toBeInTheDocument()
  })

  it('shows route calculation state while directions are loading', async () => {
    let resolveRoute: (route: Awaited<ReturnType<typeof getDrivingDirections>>) => void = () => {}
    directionsMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRoute = resolve
        }),
    )

    render(<TripMap activities={ACTIVITIES} fallbackActivities={[]} destination="Tokyo" />)

    expect(await screen.findByText('Calculating route...')).toBeInTheDocument()
    resolveRoute({
      distance: 2400,
      duration: 720,
      legs: [{
        distance: 2400,
        duration: 720,
        path: [
          { lat: 35.6586, lng: 139.7454 },
          { lat: 35.662, lng: 139.758 },
          { lat: 35.6654, lng: 139.7707 },
        ],
      }],
      path: [
        { lat: 35.6586, lng: 139.7454 },
        { lat: 35.6654, lng: 139.7707 },
      ],
    })
    expect(await screen.findByText('12 min total · 2.4 km')).toBeInTheDocument()
    expect(screen.queryByText(/mapped stops/i)).not.toBeInTheDocument()
  })

  it('shows backend Google diagnostics when route calculation fails', async () => {
    directionsMock.mockRejectedValueOnce({
      isAxiosError: true,
      response: {
        status: 502,
        data: { error: 'google_maps_unavailable' },
      },
    })

    render(<TripMap activities={ACTIVITIES} fallbackActivities={[]} destination="Tokyo" />)

    expect(await screen.findByText(/route unavailable/i)).toBeInTheDocument()
    expect(screen.getByText(/google routes request reached the backend/i)).toBeInTheDocument()
    expect(screen.getByText(/google_maps_api_key/i)).toBeInTheDocument()
  })

  it('does not request directions with fewer than two mapped activities', () => {
    render(<TripMap activities={[ACTIVITIES[0]]} fallbackActivities={[]} destination="Tokyo" />)

    expect(directionsMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('route-layer')).not.toBeInTheDocument()
    expect(screen.queryByText('Route needs at least two mapped stops.')).not.toBeInTheDocument()
  })

  it('ignores activities with missing, null, undefined, or non-finite coordinates', () => {
    render(
      <TripMap
        activities={[
          activityWithoutCoordinateKeys(),
          runtimeActivity({ id: 20, title: 'Null Latitude', lat: null, lng: 139.7454 }),
          runtimeActivity({ id: 21, title: 'Undefined Longitude', lat: 35.6586, lng: undefined }),
          runtimeActivity({ id: 22, title: 'NaN Latitude', lat: Number.NaN, lng: 139.7454 }),
          runtimeActivity({
            id: 23,
            title: 'Infinite Longitude',
            lat: 35.6586,
            lng: Number.POSITIVE_INFINITY,
          }),
        ]}
        fallbackActivities={[]}
        destination={null}
      />,
    )

    expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument()
    expect(screen.getByText('Map is ready')).toBeInTheDocument()
    expect(directionsMock).not.toHaveBeenCalled()
    expect(mapControlMock.fitBounds).not.toHaveBeenCalled()
    expect(mapControlMock.moveCamera).not.toHaveBeenCalled()
  })

  it('uses only finite activity coordinates for markers, routes, and bounds', async () => {
    const malformedStop = runtimeActivity({
      id: 12,
      orderIndex: 1,
      title: 'Broken Stop',
      lat: Number.NEGATIVE_INFINITY,
      lng: 139.76,
    })
    const validStopAfterMalformed = { ...ACTIVITIES[1], orderIndex: 2 }

    render(
      <TripMap
        activities={[ACTIVITIES[0], malformedStop, validStopAfterMalformed]}
        fallbackActivities={[]}
        routeActivities={[ACTIVITIES[0], malformedStop, validStopAfterMalformed]}
        destination="Tokyo"
      />,
    )

    expect(screen.getByRole('button', { name: /stop 1: tokyo tower/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /stop 2: tsukiji market/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /broken stop/i })).not.toBeInTheDocument()

    await waitFor(() => {
      expect(directionsMock).toHaveBeenCalledWith(
        [ACTIVITIES[0], validStopAfterMalformed],
        expect.any(AbortSignal),
      )
    })
    expect(mapControlMock.fitBounds).toHaveBeenCalledWith(
      {
        east: 139.7707,
        north: 35.6654,
        south: 35.6586,
        west: 139.7454,
      },
      64,
    )
  })

  it('does not refit the viewport when activities change under the same fit key', async () => {
    const { rerender } = render(
      <TripMap
        activities={ACTIVITIES}
        fallbackActivities={[]}
        destination="Tokyo"
        viewportFitKey="days:2026-05-01:Tokyo"
      />,
    )

    await waitFor(() => {
      expect(mapControlMock.fitBounds).toHaveBeenCalled()
    })
    mapControlMock.fitBounds.mockClear()
    mapControlMock.moveCamera.mockClear()

    rerender(
      <TripMap
        activities={[ACTIVITIES[1], ACTIVITIES[0]]}
        fallbackActivities={[]}
        destination="Tokyo"
        viewportFitKey="days:2026-05-01:Tokyo"
      />,
    )

    expect(screen.getByRole('button', { name: /stop 1: tsukiji market/i })).toBeInTheDocument()
    expect(mapControlMock.fitBounds).not.toHaveBeenCalled()
    expect(mapControlMock.moveCamera).not.toHaveBeenCalled()
  })

  it('refits the viewport when mapped coordinates arrive under the same fit key', async () => {
    const { rerender } = render(
      <TripMap
        activities={[]}
        fallbackActivities={[]}
        destination="Tokyo"
        viewportFitKey="days:2026-05-01:Tokyo"
      />,
    )

    expect(mapControlMock.fitBounds).not.toHaveBeenCalled()
    expect(mapControlMock.moveCamera).not.toHaveBeenCalled()

    rerender(
      <TripMap
        activities={ACTIVITIES}
        fallbackActivities={[]}
        destination="Tokyo"
        viewportFitKey="days:2026-05-01:Tokyo"
      />,
    )

    await waitFor(() => {
      expect(mapControlMock.fitBounds).toHaveBeenCalledWith(
        {
          east: 139.7707,
          north: 35.6654,
          south: 35.6586,
          west: 139.7454,
        },
        64,
      )
    })
  })

  it('can render mapped stops without requesting a route', () => {
    render(
      <TripMap
        activities={ACTIVITIES}
        fallbackActivities={[]}
        routeActivities={[]}
        destination="Tokyo"
      />,
    )

    expect(screen.getByRole('button', { name: /stop 1: tokyo tower/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /stop 2: tsukiji market/i })).toBeInTheDocument()
    expect(directionsMock).not.toHaveBeenCalled()
    expect(screen.queryByTestId('route-layer')).not.toBeInTheDocument()
    expect(screen.queryByText(/selected-day route/i)).not.toBeInTheDocument()
  })

  it('reuses a successful route when route rendering is toggled off and back on', async () => {
    const { rerender } = render(
      <TripMap
        activities={ACTIVITIES}
        fallbackActivities={[]}
        routeActivities={ACTIVITIES}
        destination="Tokyo"
      />,
    )

    await waitFor(() => {
      expect(directionsMock).toHaveBeenCalledTimes(1)
    })
    expect(await screen.findByTestId('route-layer')).toBeInTheDocument()

    rerender(
      <TripMap
        activities={ACTIVITIES}
        fallbackActivities={[]}
        routeActivities={[]}
        destination="Tokyo"
      />,
    )

    expect(screen.getByRole('button', { name: /stop 1: tokyo tower/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /stop 2: tsukiji market/i })).toBeInTheDocument()
    expect(screen.queryByTestId('route-layer')).not.toBeInTheDocument()
    expect(screen.queryByText(/selected-day route/i)).not.toBeInTheDocument()

    rerender(
      <TripMap
        activities={ACTIVITIES}
        fallbackActivities={[]}
        routeActivities={ACTIVITIES}
        destination="Tokyo"
      />,
    )

    expect(screen.getByTestId('route-layer')).toBeInTheDocument()
    expect(directionsMock).toHaveBeenCalledTimes(1)
  })

  it('keeps route results in React Query when the map unmounts and remounts', async () => {
    const queryClient = createTestQueryClient()
    const firstRender = render(
      <TripMap activities={ACTIVITIES} fallbackActivities={[]} destination="Tokyo" />,
      queryClient,
    )

    await waitFor(() => {
      expect(directionsMock).toHaveBeenCalledTimes(1)
    })
    firstRender.unmount()

    render(
      <TripMap activities={ACTIVITIES} fallbackActivities={[]} destination="Tokyo" />,
      queryClient,
    )

    expect(await screen.findByTestId('route-layer')).toBeInTheDocument()
    expect(directionsMock).toHaveBeenCalledTimes(1)
  })

  it('numbers timeline markers per day without rendering unscheduled ideas', () => {
    const unscheduledActivity = runtimeActivity({
      id: 22,
      dayDate: null,
      title: 'Crystal Fish',
      lat: 35.7,
      lng: 139.74,
      orderIndex: 0,
    })
    delete (unscheduledActivity as Partial<Activity>).dayDate

    render(
      <TripMap
        activities={[
          ACTIVITIES[0],
          ACTIVITIES[1],
          runtimeActivity({
            id: 20,
            dayDate: '2026-05-02',
            title: 'Ferry Building',
            lat: 35.68,
            lng: 139.76,
            orderIndex: 0,
          }),
          runtimeActivity({
            id: 21,
            dayDate: '2026-05-02',
            title: 'Museum Stop',
            lat: 35.69,
            lng: 139.75,
            orderIndex: 1,
          }),
          unscheduledActivity,
        ]}
        activityMarkerColors={{
          10: '#3F5F53',
          11: '#3F5F53',
          20: '#6E8193',
          21: '#6E8193',
        }}
        activityMarkerMode="timeline-days"
        fallbackActivities={[]}
        routeActivities={[]}
        destination="Tokyo"
      />,
    )

    const dayOneFirst = screen.getByRole('button', { name: /stop 1: tokyo tower/i })
    const dayOneSecond = screen.getByRole('button', { name: /stop 2: tsukiji market/i })
    const dayTwoFirst = screen.getByRole('button', { name: /stop 1: ferry building/i })
    const dayTwoSecond = screen.getByRole('button', { name: /stop 2: museum stop/i })

    expect(screen.queryByRole('button', { name: /crystal fish/i })).not.toBeInTheDocument()
    expect(dayOneFirst).toHaveTextContent('1')
    expect(dayOneSecond).toHaveTextContent('2')
    expect(dayTwoFirst).toHaveTextContent('1')
    expect(dayTwoSecond).toHaveTextContent('2')
    expect(dayOneFirst.getAttribute('style')).toContain('--marker-accent: #3F5F53')
    expect(dayTwoFirst.getAttribute('style')).toContain('--marker-accent: #6E8193')
  })

  it('applies selected map style while keeping native map controls hidden', () => {
    render(
      <TripMap
        activities={[]}
        fallbackActivities={[]}
        destination={null}
        mapStyle="terrain"
      />,
    )

    expect(mapMockState.mapTypeId).toBe('terrain')
    expect(mapMockState.disableDefaultUI).toBe(true)
    expect(mapMockState.mapTypeControl).toBe(false)
    expect(mapMockState.zoomControl).toBe(false)
    expect(screen.queryByRole('button', { name: /map style/i })).not.toBeInTheDocument()
  })

  it('reports viewport context on tiles and camera changes', () => {
    const onViewportContextChange = vi.fn()
    render(
      <TripMap
        activities={[]}
        fallbackActivities={[]}
        destination={null}
        onViewportContextChange={onViewportContextChange}
      />,
    )

    act(() => {
      mapMockState.onTilesLoaded?.()
    })
    expect(onViewportContextChange).toHaveBeenCalledWith({
      bounds: { north: 35.7, south: 35.6, east: 139.8, west: 139.7 },
      center: { lng: 139.7454, lat: 35.6586 },
      zoom: 11,
    })

    act(() => {
      mapMockState.onCameraChanged?.({
        detail: {
          bounds: { north: 35.9, south: 35.5, east: 140, west: 139.5 },
          center: { lat: 35.7, lng: 139.8 },
          zoom: 12,
        },
      })
    })
    expect(onViewportContextChange).toHaveBeenLastCalledWith({
      bounds: { north: 35.9, south: 35.5, east: 140, west: 139.5 },
      center: { lat: 35.7, lng: 139.8 },
      zoom: 12,
    })
  })

  it('enables native POI clicks and reports the clicked place id', () => {
    const onMapPlaceClick = vi.fn()
    const stop = vi.fn()
    render(
      <TripMap
        activities={[]}
        fallbackActivities={[]}
        destination={null}
        onMapPlaceClick={onMapPlaceClick}
      />,
    )

    expect(mapMockState.clickableIcons).toBe(true)

    act(() => {
      mapMockState.onClick?.({
        detail: {
          latLng: { lat: 35.7, lng: 139.8 },
          placeId: 'google.clicked-place',
        },
        stop,
      })
    })

    expect(stop).toHaveBeenCalled()
    expect(onMapPlaceClick).toHaveBeenCalledWith(expect.objectContaining({
      clickedAtIso: expect.any(String),
      clickedAtMs: expect.any(Number),
      location: { lat: 35.7, lng: 139.8 },
      placeName: null,
      placeId: 'google.clicked-place',
      source: 'web',
      traceId: expect.stringMatching(/^place-/),
    }))
  })

  it('reports coordinate-only map clicks without a place id', () => {
    const onMapPlaceClick = vi.fn()
    const stop = vi.fn()
    render(
      <TripMap
        activities={[]}
        fallbackActivities={[]}
        destination={null}
        onMapPlaceClick={onMapPlaceClick}
      />,
    )

    act(() => {
      mapMockState.onClick?.({
        detail: {
          latLng: { lat: 35.7001, lng: 139.8001 },
          placeId: null,
        },
        stop,
      })
    })

    expect(stop).toHaveBeenCalled()
    expect(onMapPlaceClick).toHaveBeenCalledWith(expect.objectContaining({
      clickedAtIso: expect.any(String),
      clickedAtMs: expect.any(Number),
      location: { lat: 35.7001, lng: 139.8001 },
      placeName: null,
      placeId: null,
      source: 'web',
      traceId: expect.stringMatching(/^place-/),
    }))
  })

  it('shows full-trip fallback markers when the selected day has no mapped stops', async () => {
    render(<TripMap activities={[]} fallbackActivities={ACTIVITIES} destination="Tokyo" />)

    expect(directionsMock).not.toHaveBeenCalled()
    expect(geocodeMock.geocodeDestination).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /stop 1: tokyo tower/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /stop 2: tsukiji market/i })).toBeInTheDocument()

    await waitFor(() => {
      expect(mapControlMock.fitBounds).toHaveBeenCalled()
    })
  })

  it('shows the geocoded destination when the trip has no mapped stops', async () => {
    geocodeMock.geocodeDestination.mockResolvedValueOnce({
      label: 'Tokyo, Japan',
      lat: 35.6762,
      lng: 139.6503,
    })

    render(<TripMap activities={[]} fallbackActivities={[]} destination="Tokyo, Japan" />)

    expect(screen.getByText('Finding trip destination...')).toBeInTheDocument()
    expect(await screen.findByRole('img', { name: /destination: tokyo, japan/i })).toBeInTheDocument()
    expect(directionsMock).not.toHaveBeenCalled()

    await waitFor(() => {
      expect(mapControlMock.moveCamera).toHaveBeenCalledWith({
        center: { lat: 35.6762, lng: 139.6503 },
        zoom: 9,
      })
    })
  })

  it('schedules the destination geocode stale timer at exactly 24 days', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const expectedStaleTimerMs = 24 * 24 * 60 * 60 * 1000
    const legacyStaleTimerMs = 30 * 24 * 60 * 60 * 1000 + 1

    try {
      geocodeMock.geocodeDestination.mockResolvedValueOnce({
        label: 'Tokyo, Japan',
        lat: 35.6762,
        lng: 139.6503,
      })

      render(<TripMap activities={[]} fallbackActivities={[]} destination="Tokyo, Japan" />)

      await screen.findByRole('img', { name: /destination: tokyo, japan/i })

      const scheduledDelays = setTimeoutSpy.mock.calls
        .map(([, delay]) => delay)
        .filter((delay): delay is number => typeof delay === 'number')

      expect(scheduledDelays).toContain(expectedStaleTimerMs)
      expect(Math.max(...scheduledDelays)).toBe(expectedStaleTimerMs)
      expect(scheduledDelays).not.toContain(legacyStaleTimerMs)
    } finally {
      setTimeoutSpy.mockRestore()
    }
  })

  it('does not geocode the destination when destination fallback is disabled', () => {
    render(
      <TripMap
        activities={[]}
        fallbackActivities={[]}
        destination="Tokyo, Japan"
        showDestinationFallback={false}
      />,
    )

    expect(geocodeMock.geocodeDestination).not.toHaveBeenCalled()
    expect(screen.queryByText('Finding trip destination...')).not.toBeInTheDocument()
    expect(screen.queryByRole('img', { name: /destination:/i })).not.toBeInTheDocument()
  })

  it('previews a selected place on the map before it is saved', async () => {
    render(
      <TripMap
        activities={[ACTIVITIES[0]]}
        fallbackActivities={[]}
        destination="Tokyo"
        previewPlace={{
          address: 'Kyoto Station, Kyoto',
          coordinatesLabel: '34.98585, 135.75877',
          featureType: 'poi',
          placeName: 'Kyoto Station',
          placeCategory: 'Transit',
          lat: 34.98585,
          lng: 135.75877,
        }}
      />,
    )

    expect(screen.getByRole('img', { name: /search preview: kyoto station/i })).toBeInTheDocument()
    expect(screen.queryByText(/previewing selected place/i)).not.toBeInTheDocument()

    expect(mapControlMock.fitBounds).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(mapControlMock.moveCamera).toHaveBeenCalledWith({
        center: { lat: 34.98585, lng: 135.75877 },
      })
    })
    expect(directionsMock).not.toHaveBeenCalled()
  })

  it('leaves the camera alone when a selected place is already in the viewport', () => {
    render(
      <TripMap
        activities={[]}
        fallbackActivities={[]}
        destination={null}
        previewPlace={{
          address: '4 Chome-2-8 Shibakoen, Minato City, Tokyo',
          coordinatesLabel: '35.65860, 139.74540',
          featureType: 'poi',
          placeName: 'Tokyo Tower',
          placeCategory: 'Tourist attraction',
          lat: 35.6586,
          lng: 139.7454,
        }}
      />,
    )

    expect(screen.getByRole('img', { name: /search preview: tokyo tower/i })).toBeInTheDocument()
    expect(mapControlMock.fitBounds).not.toHaveBeenCalled()
    expect(mapControlMock.moveCamera).not.toHaveBeenCalled()
  })

  it('renders clickable search result markers with a selected state', async () => {
    const onSearchResultSelect = vi.fn()
    const onSearchResultHoverChange = vi.fn()

    render(
      <TripMap
        activities={[ACTIVITIES[0]]}
        fallbackActivities={[]}
        destination="Tokyo"
        searchResults={[{
          address: '1 Chome Marunouchi, Tokyo',
          coordinatesLabel: '36.20000, 140.20000',
          featureType: 'restaurant',
          lat: 36.2,
          lng: 140.2,
          placeId: 'google.ramen-street',
          placeCategory: 'Restaurant',
          placeName: 'Ramen Street',
          title: 'Ramen Street',
        }]}
        selectedSearchResultId="google.ramen-street"
        onSearchResultHoverChange={onSearchResultHoverChange}
        onSearchResultSelect={onSearchResultSelect}
      />,
    )

    const marker = screen.getByRole('button', {
      name: /show place details for ramen street/i,
    })
    expect(marker).toBeInTheDocument()
    expect(marker).not.toHaveTextContent('1')
    await userEvent.hover(marker)
    expect(onSearchResultHoverChange).toHaveBeenCalledWith('google.ramen-street')
    await userEvent.unhover(marker)
    expect(onSearchResultHoverChange).toHaveBeenCalledWith(null)
    await userEvent.click(marker)

    expect(onSearchResultSelect).toHaveBeenCalledWith(expect.objectContaining({
      placeId: 'google.ramen-street',
      placeName: 'Ramen Street',
    }))
    await waitFor(() => {
      expect(mapControlMock.moveCamera).toHaveBeenCalledWith({
        center: { lat: 36.2, lng: 140.2 },
      })
    })
    expect(mapControlMock.fitBounds).not.toHaveBeenCalled()
  })

  it('removes a selected search marker when it is clicked again', async () => {
    const onSearchResultRemove = vi.fn()
    const onSearchResultSelect = vi.fn()

    render(
      <TripMap
        activities={[ACTIVITIES[0]]}
        fallbackActivities={[]}
        destination="Tokyo"
        searchResults={[{
          address: '1 Chome Marunouchi, Tokyo',
          coordinatesLabel: '36.20000, 140.20000',
          featureType: 'restaurant',
          lat: 36.2,
          lng: 140.2,
          placeId: 'google.ramen-street',
          placeCategory: 'Restaurant',
          placeName: 'Ramen Street',
          title: 'Ramen Street',
        }]}
        selectedSearchResultId="google.ramen-street"
        onSearchResultRemove={onSearchResultRemove}
        onSearchResultSelect={onSearchResultSelect}
      />,
    )

    const marker = screen.getByRole('button', {
      name: /remove map marker for ramen street/i,
    })
    await userEvent.click(marker)

    expect(onSearchResultRemove).toHaveBeenCalledWith(expect.objectContaining({
      placeId: 'google.ramen-street',
      placeName: 'Ramen Street',
    }))
    expect(onSearchResultSelect).not.toHaveBeenCalled()
  })

  it('clears a loose preview marker when it is clicked', async () => {
    const onPreviewPlaceClear = vi.fn()

    render(
      <TripMap
        activities={[ACTIVITIES[0]]}
        fallbackActivities={[]}
        destination="Tokyo"
        previewPlace={{
          address: 'Kyoto Station, Kyoto',
          coordinatesLabel: '34.98585, 135.75877',
          featureType: 'poi',
          placeName: 'Kyoto Station',
          placeCategory: 'Transit',
          lat: 34.98585,
          lng: 135.75877,
        }}
        onPreviewPlaceClear={onPreviewPlaceClear}
      />,
    )

    await userEvent.click(screen.getByRole('button', {
      name: /remove map marker for kyoto station/i,
    }))

    expect(onPreviewPlaceClear).toHaveBeenCalledTimes(1)
  })

  it('renders and clears a coordinate preview marker independently', async () => {
    const onPreviewPlaceClear = vi.fn()
    const onCoordinatePreviewPlaceClear = vi.fn()

    render(
      <TripMap
        activities={[]}
        fallbackActivities={[]}
        destination={null}
        previewPlace={{
          address: 'Kyoto Station, Kyoto',
          coordinatesLabel: '34.98585, 135.75877',
          featureType: 'poi',
          placeName: 'Kyoto Station',
          placeCategory: 'Transit',
          lat: 34.98585,
          lng: 135.75877,
        }}
        coordinatePreviewPlace={{
          coordinatesLabel: '35.70010, 139.80010',
          placeName: 'Selected location',
          lat: 35.7001,
          lng: 139.8001,
        }}
        onPreviewPlaceClear={onPreviewPlaceClear}
        onCoordinatePreviewPlaceClear={onCoordinatePreviewPlaceClear}
      />,
    )

    expect(screen.getByRole('button', {
      name: /remove map marker for kyoto station/i,
    })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', {
      name: /remove map marker for selected location/i,
    }))

    expect(onCoordinatePreviewPlaceClear).toHaveBeenCalledTimes(1)
    expect(onPreviewPlaceClear).not.toHaveBeenCalled()
  })

  it('ignores preview places without finite coordinates', () => {
    const invalidPreviewPlaces = [
      { title: 'Null Preview', lat: null, lng: 139.7707 },
      { title: 'Undefined Preview', lat: 35.6654, lng: undefined },
      { title: 'NaN Preview', lat: Number.NaN, lng: 139.7707 },
      { title: 'Infinite Preview', lat: 35.6654, lng: Number.POSITIVE_INFINITY },
    ]

    const { rerender } = render(
      <TripMap
        activities={[]}
        fallbackActivities={[]}
        destination={null}
        previewPlace={invalidPreviewPlaces[0]}
      />,
    )

    for (const previewPlace of invalidPreviewPlaces) {
      rerender(
        <TripMap
          activities={[]}
          fallbackActivities={[]}
          destination={null}
          previewPlace={previewPlace}
        />,
      )
      expect(screen.queryByRole('img', { name: new RegExp(previewPlace.title, 'i') })).not.toBeInTheDocument()
    }
    expect(screen.getByText('Map is ready')).toBeInTheDocument()
    expect(directionsMock).not.toHaveBeenCalled()
    expect(mapControlMock.fitBounds).not.toHaveBeenCalled()
    expect(mapControlMock.moveCamera).not.toHaveBeenCalled()
  })

  it('shows a clear empty map message when destination geocoding fails', async () => {
    geocodeMock.geocodeDestination.mockRejectedValueOnce(new Error('Google unavailable'))

    render(<TripMap activities={[]} fallbackActivities={[]} destination="Tokyo" />)

    expect(await screen.findByText(/google maps could not load trip location/i)).toBeInTheDocument()
    expect(screen.getByText(/http referrer/i)).toBeInTheDocument()
    expect(directionsMock).not.toHaveBeenCalled()
  })

  it('shows a clear empty map message when destination geocoding has no match', async () => {
    geocodeMock.geocodeDestination.mockResolvedValueOnce(null)

    render(<TripMap activities={[]} fallbackActivities={[]} destination="Unknown Place" />)

    expect(await screen.findByText('Destination could not be mapped. Add a place to start the map.')).toBeInTheDocument()
    expect(directionsMock).not.toHaveBeenCalled()
  })

  it('shows a clear empty map message when there is no destination', () => {
    render(<TripMap activities={[]} fallbackActivities={[]} destination={null} />)

    expect(screen.getByText('Map is ready')).toBeInTheDocument()
    expect(geocodeMock.geocodeDestination).not.toHaveBeenCalled()
    expect(directionsMock).not.toHaveBeenCalled()
  })

  it('activates one activity marker without creating a preview marker', async () => {
    const onActiveActivityChange = vi.fn()
    const onActivityActivate = vi.fn()
    render(
      <TripMap
        activities={[ACTIVITIES[0]]}
        fallbackActivities={[]}
        activeActivityId={10}
        destination="Tokyo"
        onActivityActivate={onActivityActivate}
        onActiveActivityChange={onActiveActivityChange}
      />,
    )

    const marker = screen.getByRole('button', { name: /stop 1: tokyo tower/i })
    expect(screen.getAllByRole('button', { name: /show place details for stop/i })).toHaveLength(1)
    expect(screen.queryByRole('img', { name: /search preview/i })).not.toBeInTheDocument()
    expect(mapMockState.preventMapHitsAndGesturesFrom).toHaveBeenCalledWith(
      expect.any(HTMLDivElement),
    )
    await userEvent.hover(marker)
    expect(onActiveActivityChange).toHaveBeenCalledWith(10)
    expect(mapControlMock.moveCamera).not.toHaveBeenCalledWith(
      expect.objectContaining({
        center: { lat: 35.6586, lng: 139.7454 },
        zoom: 13,
      }),
    )
    await userEvent.unhover(marker)
    expect(onActiveActivityChange).toHaveBeenCalledWith(null)
    fireEvent.pointerDown(marker)
    expect(onActivityActivate).toHaveBeenCalledWith(10)
    expect(onActivityActivate).toHaveBeenCalledTimes(1)
    expect(screen.getAllByRole('button', { name: /show place details for stop/i })).toHaveLength(1)
    expect(screen.queryByRole('img', { name: /search preview/i })).not.toBeInTheDocument()

    fireEvent.click(marker)
    expect(onActivityActivate).toHaveBeenCalledTimes(1)
  })

  it('shows a useful missing-key fallback', () => {
    vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', '')

    render(<TripMap activities={ACTIVITIES} fallbackActivities={[]} destination="Tokyo" />)

    expect(screen.getByRole('status')).toHaveTextContent(/google maps api key is not configured/i)
    expect(screen.getByText(/they will render here when the key is available/i)).toBeInTheDocument()
    expect(directionsMock).not.toHaveBeenCalled()
  })

  it('shows a Google access diagnostic when the Maps API fails to load', async () => {
    mapMockState.apiStatus = 'AUTH_FAILURE'

    render(<TripMap activities={ACTIVITIES} fallbackActivities={[]} destination="Tokyo" />)

    expect(await screen.findByText(/google maps could not load/i)).toBeInTheDocument()
    expect(screen.getByText(/http referrer/i)).toBeInTheDocument()
  })
})
