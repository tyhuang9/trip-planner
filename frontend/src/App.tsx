import { lazy, Suspense } from 'react'
import { BrowserRouter, Link, Navigate, Route, Routes } from 'react-router'
import './App.css'
import { RequireAuth } from './auth/RequireAuth'
import { SkipLink } from './components/SkipLink'
import { RouteAnnouncer } from './components/RouteAnnouncer'
import { RouteLoadingFallback } from './components/RouteLoadingFallback'

const AcceptInvitePage = lazy(() => import('./pages/AcceptInvitePage'))
const EmailVerificationPage = lazy(() => import('./pages/EmailVerificationPage').then(({ EmailVerificationPage: Page }) => ({ default: Page })))
const GuestOnboardingPage = lazy(() => import('./pages/GuestOnboardingPage'))
const LoginPage = lazy(() => import('./pages/LoginPage').then(({ LoginPage: Page }) => ({ default: Page })))
const MembersPage = lazy(() => import('./pages/MembersPage'))
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

function NotFoundPage() {
  return (
    <main style={{ maxWidth: 640, margin: '4rem auto', padding: '0 1rem' }}>
      <h1>404 — Not found</h1>
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
      <Routes>
        {/* Public routes — auth pages and share-accept landing flows */}
        <Route path="/login" element={<LazyRoute kind="auth"><LoginPage /></LazyRoute>} />
        <Route path="/register" element={<LazyRoute kind="auth"><RegisterPage /></LazyRoute>} />
        <Route path="/verify-email" element={<LazyRoute kind="auth"><EmailVerificationPage /></LazyRoute>} />
        <Route path="/reset-password" element={<LazyRoute kind="auth"><PasswordResetPage /></LazyRoute>} />
        <Route path="/share/:token" element={<LazyRoute kind="auth"><AcceptInvitePage /></LazyRoute>} />
        <Route path="/share/:token/guest" element={<LazyRoute kind="auth"><GuestOnboardingPage /></LazyRoute>} />
        <Route path="/404" element={<NotFoundPage />} />
        <Route path="/403" element={<ForbiddenPage />} />
        <Route path="/trips/:publicId" element={<LazyRoute kind="workspace"><TripWorkspacePage /></LazyRoute>} />
        <Route path="/trips/:publicId/d/:day" element={<LazyRoute kind="workspace"><TripWorkspacePage /></LazyRoute>} />

        {/* Authenticated routes — wrapped in RequireAuth */}
        <Route element={<RequireAuth />}>
          <Route path="/" element={<Navigate to="/trips" replace />} />
          <Route path="/trips" element={<LazyRoute kind="trips"><TripsPage /></LazyRoute>} />
          <Route path="/trips/new" element={<LazyRoute kind="trips"><NewTripPage /></LazyRoute>} />
          <Route path="/trips/:publicId/members" element={<LazyRoute kind="members"><MembersPage /></LazyRoute>} />
        </Route>

        {/* Catch-all */}
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </BrowserRouter>
  )
}
