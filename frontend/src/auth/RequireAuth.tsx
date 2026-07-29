import { Navigate, Outlet, useLocation } from 'react-router'
import { useAuth } from './useAuth'
import { AuthBootstrapShell } from './AuthBootstrapShell'

/**
 * Route guard: renders the matched child route when the visitor is
 * authenticated, otherwise redirects to `/login` with the current path
 * preserved as the `return` query param. While the AuthProvider is
 * still resolving its silent-refresh probe, renders an app-shaped loading
 * surface instead of a blank page.
 */
export function RequireAuth() {
  const { isAuthenticated, isInitializing } = useAuth()
  const location = useLocation()

  if (isInitializing) {
    return <AuthBootstrapShell />
  }

  if (!isAuthenticated) {
    const returnTo = `${location.pathname}${location.search}`
    const search = `?return=${encodeURIComponent(returnTo)}`
    return <Navigate to={`/login${search}`} replace />
  }

  return <Outlet />
}
