import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { fetchEventSource, type FetchEventSourceInit } from '@microsoft/fetch-event-source'
import type { PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { refreshSession } from '../api/client'
import { useAuthStore } from '../auth/authStore'
import { activityKeys } from './useActivities'
import { shareKeys } from './useShareLinks'
import { tripKeys } from './useTrips'
import { useTripStream } from './useTripStream'

vi.mock('@microsoft/fetch-event-source', () => ({
  EventStreamContentType: 'text/event-stream',
  fetchEventSource: vi.fn(() => new Promise(() => undefined)),
}))

vi.mock('../api/client', () => ({
  refreshSession: vi.fn(),
}))

let queryClient: QueryClient

const fetchEventSourceMock = vi.mocked(fetchEventSource)
const refreshSessionMock = vi.mocked(refreshSession)

function wrapper({ children }: PropsWithChildren) {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  )
}

function streamOptions(callIndex = fetchEventSourceMock.mock.calls.length - 1) {
  return fetchEventSourceMock.mock.calls[callIndex][1] as FetchEventSourceInit & {
    credentials: RequestCredentials
    headers?: Record<string, string>
    signal: AbortSignal
    onopen: (response: Response) => Promise<void>
    onmessage: (message: { data: string; event: string }) => void
  }
}

function setDocumentVisibility(visibilityState: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: visibilityState,
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

function tripEvent(type: string, overrides: Record<string, unknown> = {}) {
  return {
    type,
    publicId: 'abc234def567',
    occurredAt: '2026-05-01T12:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  sessionStorage.clear()
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  useAuthStore.getState().clearSession()
  setDocumentVisibility('visible')
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.useRealTimers()
})

describe('useTripStream', () => {
  it('connects with credentials and a bearer token when available', async () => {
    useAuthStore.getState().setSession({
      accessToken: 'live-token',
      expiresInSeconds: 900,
      user: {
        id: 1,
        email: 'alice@example.com',
        displayName: 'Alice',
        emailVerified: true,
      },
    })

    renderHook(() => useTripStream('abc234def567'), { wrapper })

    await waitFor(() => {
      expect(fetchEventSourceMock).toHaveBeenCalled()
    })
    expect(fetchEventSourceMock.mock.calls[0][0]).toBe('/api/trips/abc234def567/stream')
    expect(streamOptions().credentials).toBe('include')
    expect(streamOptions().headers).toMatchObject({
      Authorization: 'Bearer live-token',
      'X-Dupert-Stream-Client': expect.stringMatching(/^[A-Za-z0-9._~-]{16,64}$/),
    })
    expect(streamOptions().openWhenHidden).toBe(false)
  })

  it('does not open a stream until trip access succeeds', () => {
    renderHook(() => useTripStream('abc234def567', { enabled: false }), { wrapper })

    expect(fetchEventSourceMock).not.toHaveBeenCalled()
  })

  it('refreshes an expired signed-in user token before connecting', async () => {
    useAuthStore.getState().setSession({
      accessToken: 'stale-token',
      expiresInSeconds: 1,
      user: {
        id: 1,
        email: 'alice@example.com',
        displayName: 'Alice',
        emailVerified: true,
      },
    })
    refreshSessionMock.mockImplementation(async () => {
      useAuthStore.getState().setSession({
        accessToken: 'fresh-token',
        expiresInSeconds: 900,
        user: {
          id: 1,
          email: 'alice@example.com',
          displayName: 'Alice',
          emailVerified: true,
        },
      })
      return {
        accessToken: 'fresh-token',
        expiresInSeconds: 900,
        tokenType: 'Bearer',
        user: {
          id: 1,
          email: 'alice@example.com',
          displayName: 'Alice',
          emailVerified: true,
        },
      }
    })

    renderHook(() => useTripStream('abc234def567'), { wrapper })

    await waitFor(() => {
      expect(refreshSessionMock).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(fetchEventSourceMock).toHaveBeenCalledTimes(1)
    })
    expect(streamOptions().headers).toMatchObject({
      Authorization: 'Bearer fresh-token',
      'X-Dupert-Stream-Client': expect.stringMatching(/^[A-Za-z0-9._~-]{16,64}$/),
    })
  })

  it('uses the same opaque client identity after a route remount', async () => {
    const first = renderHook(() => useTripStream('abc234def567'), { wrapper })
    await waitFor(() => expect(fetchEventSourceMock).toHaveBeenCalledTimes(1))
    const firstClientId = streamOptions().headers?.['X-Dupert-Stream-Client']
    first.unmount()

    renderHook(() => useTripStream('abc234def567'), { wrapper })
    await waitFor(() => expect(fetchEventSourceMock).toHaveBeenCalledTimes(2))

    expect(streamOptions().headers?.['X-Dupert-Stream-Client']).toBe(firstClientId)
  })

  it('preserves cookie-backed guest auth while sending the client identity', async () => {
    renderHook(() => useTripStream('abc234def567'), { wrapper })

    await waitFor(() => expect(fetchEventSourceMock).toHaveBeenCalledTimes(1))

    expect(streamOptions().credentials).toBe('include')
    expect(streamOptions().headers).toEqual({
      'X-Dupert-Stream-Client': expect.stringMatching(/^[A-Za-z0-9._~-]{16,64}$/),
    })
  })

  it('does not retry forbidden stream setup failures', async () => {
    renderHook(() => useTripStream('abc234def567'), { wrapper })

    await waitFor(() => {
      expect(fetchEventSourceMock).toHaveBeenCalled()
    })

    let streamError: unknown
    try {
      await streamOptions().onopen?.(
        new Response(JSON.stringify({ error: 'internal_error' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      )
    } catch (error) {
      streamError = error
    }

    expect(streamError).toBeInstanceOf(Error)
    expect(() => streamOptions().onerror?.(streamError)).toThrow(
      'Trip stream returned HTTP 403',
    )
  })

  it('retries dropped streams with exponential backoff and jitter', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    renderHook(() => useTripStream('abc234def567'), { wrapper })

    await waitFor(() => {
      expect(fetchEventSourceMock).toHaveBeenCalled()
    })

    expect(streamOptions().onerror?.(new Error('network lost'))).toBe(1000)
    expect(streamOptions().onerror?.(new Error('network lost'))).toBe(2000)
  })

  it('resynchronizes exactly once when a dropped stream reopens', async () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    renderHook(() => useTripStream('abc234def567'), { wrapper })
    await waitFor(() => expect(fetchEventSourceMock).toHaveBeenCalledTimes(1))

    expect(streamOptions().onerror?.(new Error('network lost'))).toBeGreaterThan(0)
    await act(async () => {
      await streamOptions().onopen(
        new Response('', { headers: { 'content-type': 'text/event-stream' } }),
      )
      await streamOptions().onopen(
        new Response('', { headers: { 'content-type': 'text/event-stream' } }),
      )
    })

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: tripKeys.detail('abc234def567'),
    })
    expect(invalidateSpy.mock.calls.filter(
      ([options]) => JSON.stringify(options) === JSON.stringify({
        queryKey: tripKeys.detail('abc234def567'),
      }),
    )).toHaveLength(1)
  })

  it('aborts the stream when its route owner unmounts', async () => {
    const { unmount } = renderHook(() => useTripStream('abc234def567'), { wrapper })
    await waitFor(() => expect(fetchEventSourceMock).toHaveBeenCalledTimes(1))
    const signal = streamOptions().signal

    unmount()

    expect(signal.aborted).toBe(true)
  })

  it('coalesces activity query invalidation for a realtime burst', async () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    renderHook(() => useTripStream('abc234def567'), { wrapper })

    await waitFor(() => {
      expect(fetchEventSourceMock).toHaveBeenCalled()
    })

    act(() => {
      streamOptions().onmessage({
        event: 'trip-event',
        data: JSON.stringify(tripEvent('activity.updated', { activityId: 10 })),
      })
      streamOptions().onmessage({
        event: 'trip-event',
        data: JSON.stringify(tripEvent('activity.created', { activityId: 11 })),
      })
    })

    expect(invalidateSpy).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledTimes(1)
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: activityKeys.list('abc234def567'),
    })
  })

  it('buffers activity invalidation while dragging and flushes afterward', async () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    const { rerender } = renderHook(
      ({ buffering }: { buffering: boolean }) =>
        useTripStream('abc234def567', { bufferActivityEvents: buffering }),
      { initialProps: { buffering: true }, wrapper },
    )

    await waitFor(() => {
      expect(fetchEventSourceMock).toHaveBeenCalled()
    })

    act(() => {
      streamOptions().onmessage({
        event: 'trip-event',
        data: JSON.stringify(tripEvent('day.reordered', { dayDate: '2026-05-01' })),
      })
    })
    expect(invalidateSpy).not.toHaveBeenCalled()

    rerender({ buffering: false })

    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: activityKeys.list('abc234def567'),
      })
    })
  })

  it('invalidates trip sharing and access caches for share-link events', async () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    renderHook(() => useTripStream('abc234def567'), { wrapper })

    await waitFor(() => {
      expect(fetchEventSourceMock).toHaveBeenCalled()
    })

    act(() => {
      streamOptions().onmessage({
        event: 'trip-event',
        data: JSON.stringify(tripEvent('share-links.changed')),
      })
    })

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: shareKeys.forTrip('abc234def567'),
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: shareKeys.members('abc234def567'),
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: tripKeys.detail('abc234def567'),
    })
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: activityKeys.list('abc234def567'),
      })
    })
  })

  it('invalidates trip sharing and access caches without activities for member events', async () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    renderHook(() => useTripStream('abc234def567'), { wrapper })

    await waitFor(() => {
      expect(fetchEventSourceMock).toHaveBeenCalled()
    })

    act(() => {
      streamOptions().onmessage({
        event: 'trip-event',
        data: JSON.stringify(tripEvent('members.changed')),
      })
    })

    expect(invalidateSpy).toHaveBeenCalledTimes(3)
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: shareKeys.forTrip('abc234def567'),
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: shareKeys.members('abc234def567'),
    })
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: tripKeys.detail('abc234def567'),
    })
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: activityKeys.list('abc234def567'),
    })
  })

  it('ignores server heartbeat events', async () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    renderHook(() => useTripStream('abc234def567'), { wrapper })
    await waitFor(() => expect(fetchEventSourceMock).toHaveBeenCalledTimes(1))

    act(() => {
      streamOptions().onmessage({ event: 'heartbeat', data: '' })
    })

    expect(invalidateSpy).not.toHaveBeenCalled()
  })

  it('closes while hidden and resynchronizes once after reconnecting', async () => {
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')
    renderHook(() => useTripStream('abc234def567'), { wrapper })

    await waitFor(() => {
      expect(fetchEventSourceMock).toHaveBeenCalledTimes(1)
    })
    const firstSignal = streamOptions().signal

    act(() => {
      setDocumentVisibility('hidden')
    })
    expect(firstSignal.aborted).toBe(true)
    window.dispatchEvent(new Event('focus'))
    expect(fetchEventSourceMock).toHaveBeenCalledTimes(1)

    act(() => {
      setDocumentVisibility('visible')
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('pageshow'))
    })
    await waitFor(() => {
      expect(fetchEventSourceMock).toHaveBeenCalledTimes(2)
    })

    await act(async () => {
      await streamOptions().onopen(
        new Response('', { headers: { 'content-type': 'text/event-stream' } }),
      )
    })

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: tripKeys.detail('abc234def567'),
    })
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: activityKeys.list('abc234def567'),
      })
    })
  })
})
