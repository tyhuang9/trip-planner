import { useEffect, type ReactNode } from 'react'
import { Navigate, useLocation, useNavigate, useParams } from 'react-router'
import { deepLinkTarget, parseDeepLinkPath } from './policy'
import { putDeepLinkHandoff, getDeepLinkHandoff } from './vault'

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
    if (link) navigate(targetFor(link), { replace: true })
    else if (location.pathname === '/verify-email') navigate('/link-invalid/verify-email', { replace: true })
    else if (location.pathname === '/reset-password') navigate('/link-invalid/reset-password', { replace: true })
    else navigate('/404', { replace: true })
  }, [location.pathname, location.search, navigate])
  return null
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
