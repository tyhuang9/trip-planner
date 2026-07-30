import { render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDrivingDirections, type AppRoute } from '../api/googleMapsRoute'
import type { Activity } from '../types/activity'
import { TripMapSurface } from './TripMapSurface.native'

vi.mock('../api/googleMapsRoute', () => ({
  getDrivingDirections: vi.fn(),
}))

const directionsMock = vi.mocked(getDrivingDirections)

const ROUTE: AppRoute = {
  distance: 2400,
  duration: 720,
  legs: [{
    distance: 2400,
    duration: 720,
    path: [{ lat: 35.6586, lng: 139.7454 }, { lat: 35.6654, lng: 139.7707 }],
  }],
  path: [{ lat: 35.6586, lng: 139.7454 }, { lat: 35.6654, lng: 139.7707 }],
}

const ROUTE_ACTIVITIES: Activity[] = [
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

const MULTI_DAY_ROUTE_ACTIVITIES: Activity[] = [
  ...ROUTE_ACTIVITIES,
  {
    ...ROUTE_ACTIVITIES[0],
    id: 20,
    dayDate: '2026-05-02',
    lat: 35.6762,
    lng: 139.6503,
  },
  {
    ...ROUTE_ACTIVITIES[1],
    id: 21,
    dayDate: '2026-05-02',
    lat: 35.6895,
    lng: 139.6917,
  },
]

function renderSurface(routeActivities: Activity[]) {
  return render(surface(routeActivities))
}

function surface(routeActivities: Activity[]) {
  return (
    <TripMapSurface
      activities={routeActivities}
      fallbackActivities={[]}
      routeActivities={routeActivities}
      destination={null}
    />
  )
}

afterEach(() => {
  directionsMock.mockReset()
})

describe('<TripMapSurface> native route requests', () => {
  it('keeps an in-flight request for an equivalent fresh route activity array', async () => {
    let firstSignal: AbortSignal | undefined
    directionsMock.mockImplementation((_activities, signal) => {
      firstSignal = signal
      return new Promise(() => undefined)
    })

    const view = renderSurface(ROUTE_ACTIVITIES)

    await waitFor(() => {
      expect(directionsMock).toHaveBeenCalledTimes(1)
    })
    expect(firstSignal?.aborted).toBe(false)

    const equivalentActivities = ROUTE_ACTIVITIES.map((activity) => ({ ...activity }))
    view.rerender(surface(equivalentActivities))

    expect(directionsMock).toHaveBeenCalledTimes(1)
    expect(firstSignal?.aborted).toBe(false)
  })

  it('aborts and replaces a request when its day changes', async () => {
    const signals: AbortSignal[] = []
    directionsMock.mockImplementation((_activities, signal) => {
      if (signal) signals.push(signal)
      return new Promise(() => undefined)
    })

    const view = renderSurface(ROUTE_ACTIVITIES)

    await waitFor(() => {
      expect(directionsMock).toHaveBeenCalledTimes(1)
    })

    const nextActivities = [
      { ...ROUTE_ACTIVITIES[0], dayDate: '2026-05-02' },
      { ...ROUTE_ACTIVITIES[1], dayDate: '2026-05-02' },
    ]
    view.rerender(surface(nextActivities))

    await waitFor(() => {
      expect(directionsMock).toHaveBeenCalledTimes(2)
    })
    expect(signals[0]?.aborted).toBe(true)
    expect(directionsMock).toHaveBeenLastCalledWith(
      nextActivities,
      signals[1],
    )
  })

  it('aborts and replaces a request with the latest ordered coordinates', async () => {
    const signals: AbortSignal[] = []
    directionsMock.mockImplementation((_activities, signal) => {
      if (signal) signals.push(signal)
      return new Promise(() => undefined)
    })

    const view = renderSurface(ROUTE_ACTIVITIES)

    await waitFor(() => {
      expect(directionsMock).toHaveBeenCalledTimes(1)
    })

    const nextActivities = [
      { ...ROUTE_ACTIVITIES[0], orderIndex: 1 },
      { ...ROUTE_ACTIVITIES[1], orderIndex: 0 },
    ]
    view.rerender(surface(nextActivities))

    await waitFor(() => {
      expect(directionsMock).toHaveBeenCalledTimes(2)
    })
    expect(signals[0]?.aborted).toBe(true)
    expect(directionsMock).toHaveBeenLastCalledWith(
      [nextActivities[1], nextActivities[0]],
      signals[1],
    )
  })

  it('aborts an active request and clears its loading state when no day is routable', async () => {
    let firstSignal: AbortSignal | undefined
    directionsMock.mockImplementation((_activities, signal) => {
      firstSignal = signal
      return new Promise(() => undefined)
    })

    const view = renderSurface(ROUTE_ACTIVITIES)

    await screen.findByText('Calculating route…')
    view.rerender(surface([ROUTE_ACTIVITIES[0]]))

    await waitFor(() => {
      expect(screen.queryByText('Calculating route…')).not.toBeInTheDocument()
    })
    expect(firstSignal?.aborted).toBe(true)
    expect(directionsMock).toHaveBeenCalledTimes(1)
  })

  it('clears loaded route state when no day remains routable', async () => {
    directionsMock.mockResolvedValue(ROUTE)
    const view = renderSurface(ROUTE_ACTIVITIES)

    await screen.findByText('12 min total · 2.4 km')
    view.rerender(surface([ROUTE_ACTIVITIES[0]]))

    await waitFor(() => {
      expect(screen.queryByText('12 min total · 2.4 km')).not.toBeInTheDocument()
    })
  })

  it('retries an equivalent fresh route activity array after a request failure', async () => {
    directionsMock
      .mockRejectedValueOnce(new Error('Directions unavailable'))
      .mockResolvedValueOnce(ROUTE)
    const view = renderSurface(ROUTE_ACTIVITIES)

    await screen.findByText('Routes could not be calculated. Try again shortly.')
    expect(directionsMock).toHaveBeenCalledTimes(1)

    view.rerender(surface(ROUTE_ACTIVITIES.map((activity) => ({ ...activity }))))

    await waitFor(() => {
      expect(directionsMock).toHaveBeenCalledTimes(2)
    })
  })

  it('does not refetch an equivalent fresh route activity array after full success', async () => {
    directionsMock.mockResolvedValue(ROUTE)
    const view = renderSurface(ROUTE_ACTIVITIES)

    await screen.findByText('12 min total · 2.4 km')
    await waitFor(() => {
      expect(screen.queryByText('Calculating route…')).not.toBeInTheDocument()
    })

    view.rerender(surface(ROUTE_ACTIVITIES.map((activity) => ({ ...activity }))))

    expect(directionsMock).toHaveBeenCalledTimes(1)
  })

  it('retries an equivalent fresh route activity array after a partial result', async () => {
    directionsMock
      .mockResolvedValueOnce(ROUTE)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(ROUTE)
      .mockResolvedValueOnce(ROUTE)
    const view = renderSurface(MULTI_DAY_ROUTE_ACTIVITIES)

    await screen.findByText('Some selected-day routes are unavailable.')
    expect(directionsMock).toHaveBeenCalledTimes(2)

    view.rerender(surface(MULTI_DAY_ROUTE_ACTIVITIES.map((activity) => ({ ...activity }))))

    await waitFor(() => {
      expect(directionsMock).toHaveBeenCalledTimes(4)
    })
  })

  it('aborts an active route request when the surface unmounts', async () => {
    let signal: AbortSignal | undefined
    directionsMock.mockImplementation((_activities, nextSignal) => {
      signal = nextSignal
      return new Promise(() => undefined)
    })
    const view = renderSurface(ROUTE_ACTIVITIES)

    await waitFor(() => {
      expect(directionsMock).toHaveBeenCalledTimes(1)
    })

    view.unmount()

    expect(signal?.aborted).toBe(true)
  })

  it('aborts the StrictMode replay request without orphaning the live request', async () => {
    const signals: AbortSignal[] = []
    directionsMock.mockImplementation((_activities, signal) => {
      if (signal) signals.push(signal)
      return new Promise(() => undefined)
    })
    const view = render(<StrictMode>{surface(ROUTE_ACTIVITIES)}</StrictMode>)

    await waitFor(() => {
      expect(directionsMock).toHaveBeenCalledTimes(2)
    })
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]?.aborted).toBe(false)

    view.unmount()

    expect(signals[1]?.aborted).toBe(true)
  })
})
