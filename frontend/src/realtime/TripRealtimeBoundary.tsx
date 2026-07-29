import { useCallback, useContext, useState } from 'react'
import { Outlet, useLocation, useParams, useSearchParams } from 'react-router'
import { AuthContext } from '../auth/authContextValue'
import { AuthBootstrapShell } from '../auth/AuthBootstrapShell'
import { useIsAuthenticated } from '../auth/authStore'
import { useTripStream } from '../hooks/useTripStream'
import { useTrip } from '../hooks/useTrips'
import { ActivityBufferContext } from './tripRealtimeActivityBuffer'

/**
 * Owns the one intentional realtime stream for every trip sub-route. Child
 * screens only publish short-lived UI buffering state; they never open streams.
 */
export function TripRealtimeBoundary() {
  const { publicId } = useParams()
  const location = useLocation()
  const [searchParams] = useSearchParams()
  const isAuthenticated = useIsAuthenticated()
  const isInitializing = useContext(AuthContext)?.isInitializing ?? false
  const [bufferActivityEvents, setBufferActivityEvents] = useState(false)
  const isProtectedMembersRoute = location.pathname.endsWith('/members')
  const shouldClaimGuestSession =
    isAuthenticated && searchParams.get('claimGuest') === '1'
  const mayResolveTrip =
    !isInitializing &&
    !shouldClaimGuestSession &&
    (!isProtectedMembersRoute || isAuthenticated)
  const streamPublicId = mayResolveTrip ? publicId : undefined
  const tripQuery = useTrip(streamPublicId, { enabled: mayResolveTrip })

  useTripStream(streamPublicId, {
    bufferActivityEvents,
    enabled: mayResolveTrip && tripQuery.isSuccess,
  })

  const updateActivityBuffer = useCallback((buffering: boolean) => {
    setBufferActivityEvents(buffering)
  }, [])

  if (isInitializing) {
    return <AuthBootstrapShell />
  }

  return (
    <ActivityBufferContext.Provider value={updateActivityBuffer}>
      <Outlet />
    </ActivityBufferContext.Provider>
  )
}
