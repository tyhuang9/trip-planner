import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { subscribeToDeepLinks, takeDeepLink } from './queue'
import { getDeepLinkHandoff, subscribeToDeepLinkVault } from './vault'

/** Bridges native URLs only after auth has reached a conclusive state. */
export function DeepLinkBridge() {
  const { isInitializing } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [version, setVersion] = useState(0)
  const inFlightTarget = useRef<{ target: string; handoffId?: string } | undefined>(undefined)

  useEffect(() => subscribeToDeepLinks(() => setVersion((version) => version + 1)), [])
  useEffect(() => subscribeToDeepLinkVault(() => setVersion((version) => version + 1)), [])

  useEffect(() => {
    if (isInitializing) return
    if (inFlightTarget.current) {
      const inFlight = inFlightTarget.current
      if (inFlight.handoffId && getDeepLinkHandoff(inFlight.handoffId)) return
      if (!inFlight.handoffId && location.pathname === inFlight.target) return
      if (inFlight.handoffId || location.pathname !== inFlight.target) {
        inFlightTarget.current = undefined
        setVersion((current) => current + 1)
      }
      return
    }
    const link = takeDeepLink()
    if (link) {
      inFlightTarget.current = link
      navigate(link.target, { replace: true })
    }
  }, [isInitializing, location.pathname, navigate, version])

  return null
}
