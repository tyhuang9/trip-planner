import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { subscribeToDeepLinks, takeDeepLink } from './queue'

/** Bridges native URLs only after auth has reached a conclusive state. */
export function DeepLinkBridge() {
  const { isInitializing } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [version, setVersion] = useState(0)
  const inFlightTarget = useRef<string | undefined>(undefined)

  useEffect(() => subscribeToDeepLinks(() => setVersion((version) => version + 1)), [])

  useEffect(() => {
    if (isInitializing) return
    if (inFlightTarget.current) {
      if (location.pathname !== inFlightTarget.current) {
        inFlightTarget.current = undefined
        setVersion((current) => current + 1)
      }
      return
    }
    const link = takeDeepLink()
    if (link) {
      inFlightTarget.current = link.target
      navigate(link.target, { replace: true })
    }
  }, [isInitializing, location.pathname, navigate, version])

  return null
}
