import { render, screen, waitFor } from '@testing-library/react'
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

function renderSurface(routeActivities: Activity[]) {
  return render(
    <TripMapSurface
      activities={routeActivities}
      fallbackActivities={[]}
      routeActivities={routeActivities}
      destination={null}
    />,
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
    view.rerender(
      <TripMapSurface
        activities={equivalentActivities}
        fallbackActivities={[]}
        routeActivities={equivalentActivities}
        destination={null}
      />,
    )

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
    view.rerender(
      <TripMapSurface
        activities={nextActivities}
        fallbackActivities={[]}
        routeActivities={nextActivities}
        destination={null}
      />,
    )

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
    view.rerender(
      <TripMapSurface
        activities={nextActivities}
        fallbackActivities={[]}
        routeActivities={nextActivities}
        destination={null}
      />,
    )

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
    view.rerender(
      <TripMapSurface
        activities={[ROUTE_ACTIVITIES[0]]}
        fallbackActivities={[]}
        routeActivities={[ROUTE_ACTIVITIES[0]]}
        destination={null}
      />,
    )

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
    view.rerender(
      <TripMapSurface
        activities={[ROUTE_ACTIVITIES[0]]}
        fallbackActivities={[]}
        routeActivities={[ROUTE_ACTIVITIES[0]]}
        destination={null}
      />,
    )

    await waitFor(() => {
      expect(screen.queryByText('12 min total · 2.4 km')).not.toBeInTheDocument()
    })
  })
})
