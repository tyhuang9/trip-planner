import { lazy, Suspense, useEffect, useRef } from 'react'
import { BrowserRouter, Link, Route, Routes } from 'react-router'
import './App.css'
import { RequireAuth } from './auth/RequireAuth'
import { SkipLink } from './components/SkipLink'
import { RouteAnnouncer } from './components/RouteAnnouncer'
import { RouteLoadingFallback } from './components/RouteLoadingFallback'
import { TripRealtimeBoundary } from './realtime/TripRealtimeBoundary'
import { LaunchRoute } from './launch/LaunchRoute'
import { DeepLinkBridge } from './deep-links/DeepLinkBridge'
import { DeepLinkHandoffRoute, DeepLinkScrubber } from './deep-links/DeepLinkRoutes'
import { DeepLinkRouteFocus } from './deep-links/DeepLinkRouteFocus'
import { usePageTitle } from './utils/usePageTitle'

const AcceptInvitePage = lazy(() => import('./pages/AcceptInvitePage'))
const EmailVerificationPage = lazy(() => import('./pages/EmailVerificationPage').then(({ EmailVerificationPage: Page }) => ({ default: Page })))
const GuestOnboardingPage = lazy(() => import('./pages/GuestOnboardingPage'))
const LoginPage = lazy(() => import('./pages/LoginPage').then(({ LoginPage: Page }) => ({ default: Page })))
const PasswordResetPage = lazy(() => import('./pages/PasswordResetPage'))
const RegisterPage = lazy(() => import('./pages/RegisterPage').then(({ RegisterPage: Page }) => ({ default: Page })))
const TripsPage = lazy(() => import('./pages/TripsPage').then(({ TripsPage: Page }) => ({ default: Page })))
const NewTripPage = lazy(() => import('./pages/NewTripPage').then(({ NewTripPage: Page }) => ({ default: Page })))
const TripWorkspacePage = lazy(() => import('./pages/TripWorkspacePage').then(({ TripWorkspacePage: Page }) => ({ default: Page })))

function LazyRoute({ kind, children }: { kind: 'auth' | 'trips' | 'workspace' | 'members'; children: React.ReactNode }) {
  return <Suspense fallback={<RouteLoadingFallback kind={kind} />}>{children}</Suspense>
}

/**
 * Router for chunk 2e. Public auth routes (`/login`, `/register`) sit
 * outside the guard; everything else nests under `<RequireAuth>` so an
 * unauthenticated visit redirects to `/login?return=...`. Most of the
 * routes inside the guard are still placeholders for Pieces 3–5.
 */

function TodoPage({ title }: { title: string }) {
  return (
    <main style={{ maxWidth: 640, margin: '4rem auto', padding: '0 1rem' }}>
      <h1>{title}</h1>
      <p>This page isn&apos;t ready yet — check back soon.</p>
    </main>
  )
}

function ForbiddenPage() {
  return <TodoPage title="403 — Forbidden" />
}

export function NotFoundPage() {
  usePageTitle('Page not found – Dupert')
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => headingRef.current?.focus(), [])

  return (
    <main id="main" style={{ maxWidth: 640, margin: '4rem auto', padding: '0 1rem' }}>
      <h1 ref={headingRef} tabIndex={-1}>404 — Not found</h1>
      <p>
        We couldn&apos;t find what you were looking for.{' '}
        <Link to="/">Go home</Link>.
      </p>
    </main>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <SkipLink />
      <RouteAnnouncer />
      <DeepLinkBridge />
      <DeepLinkRouteFocus />
      <Routes>
        {/* Public routes — auth pages and share-accept landing flows */}
        <Route path="/login" element={<LazyRoute kind="auth"><LoginPage /></LazyRoute>} />
        <Route path="/register" element={<LazyRoute kind="auth"><RegisterPage /></LazyRoute>} />
        <Route path="/verify-email" element={<DeepLinkScrubber />} />
        <Route path="/reset-password" element={<DeepLinkScrubber />} />
        <Route path="/share/:token" element={<DeepLinkScrubber />} />
        <Route path="/share/:token/guest" element={<DeepLinkScrubber />} />
        <Route path="/link-invalid/verify-email" element={<LazyRoute kind="auth"><EmailVerificationPage /></LazyRoute>} />
        <Route path="/link-invalid/reset-password" element={<LazyRoute kind="auth"><PasswordResetPage /></LazyRoute>} />
        <Route
          path="/link/:handoffId"
          element={<DeepLinkHandoffRoute
            acceptInvite={<LazyRoute kind="auth"><AcceptInvitePage /></LazyRoute>}
            guestOnboarding={<LazyRoute kind="auth"><GuestOnboardingPage /></LazyRoute>}
            emailVerification={<LazyRoute kind="auth"><EmailVerificationPage /></LazyRoute>}
            passwordReset={<LazyRoute kind="auth"><PasswordResetPage /></LazyRoute>}
          />}
        />
        <Route
          path="/link/:handoffId/guest"
          element={<DeepLinkHandoffRoute
            acceptInvite={<LazyRoute kind="auth"><AcceptInvitePage /></LazyRoute>}
            guestOnboarding={<LazyRoute kind="auth"><GuestOnboardingPage /></LazyRoute>}
            emailVerification={<LazyRoute kind="auth"><EmailVerificationPage /></LazyRoute>}
            passwordReset={<LazyRoute kind="auth"><PasswordResetPage /></LazyRoute>}
          />}
        />
        <Route path="/404" element={<NotFoundPage />} />
        <Route path="/403" element={<ForbiddenPage />} />
        <Route path="/" element={<LaunchRoute />} />
        <Route path="/trips/:publicId" element={<TripRealtimeBoundary />}>
          <Route index element={<LazyRoute kind="workspace"><TripWorkspacePage /></LazyRoute>} />
          <Route path="d/:day" element={<LazyRoute kind="workspace"><TripWorkspacePage /></LazyRoute>} />
          <Route element={<RequireAuth />}>
            <Route path="members" element={<LazyRoute kind="members"><TripWorkspacePage /></LazyRoute>} />
          </Route>
        </Route>

        {/* Authenticated routes — wrapped in RequireAuth */}
        <Route element={<RequireAuth />}>
          <Route path="/trips" element={<LazyRoute kind="trips"><TripsPage /></LazyRoute>} />
          <Route path="/trips/new" element={<LazyRoute kind="trips"><NewTripPage /></LazyRoute>} />
        </Route>

        {/* Catch-all */}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  )
}
