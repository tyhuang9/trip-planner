import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { useAuth } from '../auth/useAuth'
import { subscribeToDeepLinks, takeDeepLink } from './queue'

/** Bridges native URLs only after auth has reached a conclusive state. */
export function DeepLinkBridge() {
  const { isInitializing } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [version, setVersion] = useState(0)

  useEffect(() => subscribeToDeepLinks(() => setVersion((version) => version + 1)), [])

  useEffect(() => {
    if (isInitializing) return
    const link = takeDeepLink()
    if (link) navigate(link.target, { replace: true })
  }, [isInitializing, location.key, navigate, version])

  return null
}
