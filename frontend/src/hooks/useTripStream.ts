import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EventStreamContentType, fetchEventSource } from '@microsoft/fetch-event-source'
import { useQueryClient } from '@tanstack/react-query'
import { useAuthStore, useAccessToken } from '../auth/authStore'
import { buildApiUrl } from '../api/baseUrl'
import { refreshSession } from '../api/client'
import { shareKeys } from './useShareLinks'
import { activityKeys } from './useActivities'
import { tripKeys } from './useTrips'
import { platformRuntime, subscribeToAppLifecycle } from '../platform/runtime'
import { getOrCreateStreamClientId } from '../realtime/streamClientId'

export interface TripStreamEvent {
  type: string
  publicId: string
  activityId?: number | null
  dayDate?: string | null
  occurredAt: string
}

interface UseTripStreamOptions {
  bufferActivityEvents?: boolean
  enabled?: boolean
}

const ACTIVITY_INVALIDATION_DEBOUNCE_MS = 200
const INITIAL_RETRY_DELAY_MS = 1_000
const MAX_RETRY_DELAY_MS = 30_000

class FatalTripStreamError extends Error {
}

function isActivityEvent(event: TripStreamEvent): boolean {
  return event.type.startsWith('activity.') || event.type === 'day.reordered'
}

function appIsForeground(): boolean {
  return platformRuntime.target === 'native' ||
    typeof document === 'undefined' ||
    document.visibilityState !== 'hidden'
}

function retryDelayWithJitter(attempt: number): number {
  const exponentialDelay = Math.min(
    MAX_RETRY_DELAY_MS,
    INITIAL_RETRY_DELAY_MS * 2 ** Math.min(attempt, 5),
  )
  const jitter = 0.5 + Math.random()
  return Math.min(MAX_RETRY_DELAY_MS, Math.round(exponentialDelay * jitter))
}

function parseTripStreamEvent(data: string): TripStreamEvent | null {
  try {
    const event = JSON.parse(data) as TripStreamEvent
    return typeof event.type === 'string' && typeof event.publicId === 'string'
      ? event
      : null
  } catch {
    return null
  }
}

export function useTripStream(
  publicId: string | undefined,
  options: UseTripStreamOptions = {},
) {
  const accessToken = useAccessToken()
  const queryClient = useQueryClient()
  const bufferActivityEvents = options.bufferActivityEvents ?? false
  const enabled = options.enabled ?? true
  const streamClientId = useMemo(() => getOrCreateStreamClientId(), [])
  const [isForeground, setIsForeground] = useState(appIsForeground)
  const lifecycleStateRef = useRef(isForeground ? 'foreground' : 'background')
  const bufferActivityEventsRef = useRef(bufferActivityEvents)
  const bufferedActivityInvalidationRef = useRef(false)
  const activityInvalidationTimerRef = useRef<number | null>(null)
  const retryAttemptRef = useRef(0)
  const resyncAfterLifecycleRef = useRef(false)
  const resyncAfterReconnectRef = useRef(false)

  const invalidateActivities = useCallback((streamPublicId: string) => {
    void queryClient.invalidateQueries({ queryKey: activityKeys.list(streamPublicId) })
  }, [queryClient])

  const scheduleActivityInvalidation = useCallback((streamPublicId: string) => {
    if (activityInvalidationTimerRef.current !== null) {
      window.clearTimeout(activityInvalidationTimerRef.current)
    }
    activityInvalidationTimerRef.current = window.setTimeout(() => {
      activityInvalidationTimerRef.current = null
      invalidateActivities(streamPublicId)
    }, ACTIVITY_INVALIDATION_DEBOUNCE_MS)
  }, [invalidateActivities])

  const resynchronize = useCallback((streamPublicId: string) => {
    void queryClient.invalidateQueries({ queryKey: shareKeys.forTrip(streamPublicId) })
    void queryClient.invalidateQueries({ queryKey: shareKeys.members(streamPublicId) })
    void queryClient.invalidateQueries({ queryKey: tripKeys.detail(streamPublicId) })
    scheduleActivityInvalidation(streamPublicId)
  }, [queryClient, scheduleActivityInvalidation])

  useEffect(() => {
    return subscribeToAppLifecycle((state) => {
      if (state === lifecycleStateRef.current) return
      if (state === 'foreground') {
        resyncAfterLifecycleRef.current = true
      }
      lifecycleStateRef.current = state
      setIsForeground(state === 'foreground')
    })
  }, [])

  useEffect(() => {
    return () => {
      if (activityInvalidationTimerRef.current !== null) {
        window.clearTimeout(activityInvalidationTimerRef.current)
        activityInvalidationTimerRef.current = null
      }
    }
  }, [publicId])

  useEffect(() => {
    bufferActivityEventsRef.current = bufferActivityEvents
    if (bufferActivityEvents || !publicId || !bufferedActivityInvalidationRef.current) {
      return
    }

    bufferedActivityInvalidationRef.current = false
    scheduleActivityInvalidation(publicId)
  }, [bufferActivityEvents, publicId, scheduleActivityInvalidation])

  useEffect(() => {
    if (!publicId || !enabled || !isForeground) return

    const streamPublicId = publicId
    const controller = new AbortController()

    async function connect() {
      if (await refreshedStaleUserToken(controller.signal)) {
        return
      }
      if (controller.signal.aborted) {
        return
      }

      const token = useAuthStore.getState().getAccessToken()
      const headers: Record<string, string> = {
        'X-Dupert-Stream-Client': streamClientId,
      }
      if (token) {
        headers.Authorization = `Bearer ${token}`
      }
      await fetchEventSource(
        buildApiUrl(`/trips/${encodeURIComponent(streamPublicId)}/stream`),
        {
          credentials: 'include',
          headers,
          openWhenHidden: false,
          signal: controller.signal,
          onopen: async (response) => {
            assertStreamResponse(response)
            retryAttemptRef.current = 0
            if (resyncAfterLifecycleRef.current || resyncAfterReconnectRef.current) {
              resyncAfterLifecycleRef.current = false
              resyncAfterReconnectRef.current = false
              resynchronize(streamPublicId)
            }
          },
          onerror: (error) => {
            if (error instanceof FatalTripStreamError) {
              throw error
            }
            resyncAfterReconnectRef.current = true
            const delay = retryDelayWithJitter(retryAttemptRef.current)
            retryAttemptRef.current += 1
            return delay
          },
          onmessage: (message) => {
            if (message.event === 'connected' || message.event === 'heartbeat') return
            const event = parseTripStreamEvent(message.data)
            if (!event || event.publicId !== streamPublicId) return

            if (isActivityEvent(event)) {
              if (bufferActivityEventsRef.current) {
                bufferedActivityInvalidationRef.current = true
                return
              }
              scheduleActivityInvalidation(streamPublicId)
              return
            }

            if (event.type === 'members.changed') {
              invalidateTripAccessState(queryClient, streamPublicId)
              return
            }

            if (event.type === 'share-links.changed') {
              invalidateTripAccessState(queryClient, streamPublicId)
              scheduleActivityInvalidation(streamPublicId)
            }
          },
        },
      )
    }

    void connect().catch(() => {
      // Access errors are fatal. A route, token, or successful trip query change
      // is the next valid opportunity to create another stream.
    })

    return () => controller.abort()
  }, [accessToken, enabled, isForeground, publicId, queryClient, resynchronize, scheduleActivityInvalidation, streamClientId])
}

async function refreshedStaleUserToken(signal: AbortSignal): Promise<boolean> {
  const state = useAuthStore.getState()
  if (state.user === null || state.getAccessToken() !== null) {
    return false
  }

  try {
    await refreshSession()
  } catch {
    return true
  }

  return !signal.aborted
}

function assertStreamResponse(response: Response): void {
  if (!response.ok) {
    if ([401, 403, 404].includes(response.status)) {
      throw new FatalTripStreamError(`Trip stream returned HTTP ${response.status}`)
    }
    throw new Error(`Trip stream returned HTTP ${response.status}`)
  }

  const contentType = response.headers.get('content-type')
  if (!contentType?.startsWith(EventStreamContentType)) {
    throw new FatalTripStreamError(
      `Expected trip stream content-type ${EventStreamContentType}, received ${contentType ?? 'none'}`,
    )
  }
}

function invalidateTripAccessState(
  queryClient: ReturnType<typeof useQueryClient>,
  publicId: string,
) {
  void queryClient.invalidateQueries({ queryKey: shareKeys.forTrip(publicId) })
  void queryClient.invalidateQueries({ queryKey: shareKeys.members(publicId) })
  void queryClient.invalidateQueries({ queryKey: tripKeys.detail(publicId) })
}
