import { useEffect, type ReactNode } from 'react'
import { Navigate, useLocation, useNavigate, useParams } from 'react-router'
import { deepLinkTarget, parseDeepLinkPath } from './policy'
import { putDeepLinkHandoff, getDeepLinkHandoff } from './vault'
import { requestDeepLinkRouteFocus } from './DeepLinkRouteFocus'
import { RouteLoadingFallback } from '../components/RouteLoadingFallback'

function targetFor(link: NonNullable<ReturnType<typeof parseDeepLinkPath>>) {
  if (link.kind === 'trip') return deepLinkTarget(link)
  return `${deepLinkTarget(link)}/${putDeepLinkHandoff(link)}`
}

/** Replaces web deep-link URLs before any page can issue an API request. */
export function DeepLinkScrubber() {
  const location = useLocation()
  const navigate = useNavigate()
  useEffect(() => {
    const link = parseDeepLinkPath(location.pathname, location.search)
    const destination = link
      ? targetFor(link)
      : location.pathname === '/verify-email'
        ? '/link-invalid/verify-email'
        : location.pathname === '/reset-password'
          ? '/link-invalid/reset-password'
          : '/404'
    requestDeepLinkRouteFocus(destination)
    navigate(destination, { replace: true })
  }, [location.pathname, location.search, navigate])
  return <RouteLoadingFallback kind="auth" />
}

export function DeepLinkHandoffRoute({
  acceptInvite,
  guestOnboarding,
  emailVerification,
  passwordReset,
}: {
  acceptInvite: ReactNode
  guestOnboarding: ReactNode
  emailVerification: ReactNode
  passwordReset: ReactNode
}) {
  const { handoffId } = useParams()
  const location = useLocation()
  const link = getDeepLinkHandoff(handoffId)
  if (!link) return <Navigate to="/404" replace />
  const basePath = `/link/${handoffId}`
  const isBase = location.pathname === basePath
  const isGuest = location.pathname === `${basePath}/guest`
  if (link.kind === 'share' && isBase) return acceptInvite
  if ((link.kind === 'share' || link.kind === 'share-guest') && isGuest) return guestOnboarding
  if (link.kind === 'share-guest' && isBase) return guestOnboarding
  if (link.kind === 'verify-email' && isBase) return emailVerification
  if (link.kind === 'reset-password' && isBase) return passwordReset
  return <Navigate to="/404" replace />
}
