import { create } from 'zustand'
import type { UserSummary } from '../types/auth'

/**
 * In-memory credential store plus an explicit resolution status.
 *
 * Storage is deliberately RAM-only — no `persist` middleware, no
 * `localStorage`, no `sessionStorage`. PROJECT.md §5 mandates that an
 * XSS reading any web storage cannot steal the session, so the access
 * token never leaves React state. Durable logout intent is stored separately
 * and contains no credential material; the credential transport remains an
 * API-client concern.
 */

/**
 * Skew applied to expiry comparisons. If the token will expire within
 * this window we report it as "already expired" so the request layer
 * can refresh proactively instead of letting a request go out with a
 * token that flips expired mid-flight.
 */
export const ACCESS_TOKEN_EXPIRY_SKEW_MS = 30_000

export type AuthStatus =
  | 'restoring'
  | 'authenticated'
  | 'unauthenticated'
  | 'clearing-session'
  | 'offline-unknown'

export interface AuthState {
  authStatus: AuthStatus
  accessToken: string | null
  user: UserSummary | null
  /** Wall-clock ms when the access token expires. Null when logged out. */
  expiresAt: number | null
  setSession: (input: {
    accessToken: string
    expiresInSeconds: number
    user: UserSummary
  }) => void
  setAuthStatus: (authStatus: AuthStatus) => void
  setUser: (user: UserSummary) => void
  clearSession: (
    authStatus?: Exclude<AuthStatus, 'authenticated'>,
  ) => void
  /**
   * Returns the access token if it is still usable (i.e. not within the
   * expiry skew window). Returns null otherwise — including when no
   * session exists. Pure read, never mutates the store.
   */
  getAccessToken: () => string | null
}

export const useAuthStore = create<AuthState>((set, get) => ({
  authStatus: 'restoring',
  accessToken: null,
  user: null,
  expiresAt: null,
  setSession: ({ accessToken, expiresInSeconds, user }) => {
    set({
      authStatus: 'authenticated',
      accessToken,
      user,
      expiresAt: Date.now() + expiresInSeconds * 1000,
    })
  },
  setAuthStatus: (authStatus) => {
    set({ authStatus })
  },
  setUser: (user) => {
    set({ user })
  },
  clearSession: (authStatus = 'unauthenticated') => {
    set({ authStatus, accessToken: null, user: null, expiresAt: null })
  },
  getAccessToken: () => {
    const { accessToken, expiresAt } = get()
    if (!accessToken || expiresAt === null) {
      return null
    }
    if (Date.now() + ACCESS_TOKEN_EXPIRY_SKEW_MS >= expiresAt) {
      return null
    }
    return accessToken
  },
}))

/** Selector hooks. Thin wrappers — components shouldn't import the store directly. */
export const useUser = () => useAuthStore((s) => s.user)
export const useAccessToken = () => useAuthStore((s) => s.accessToken)
/**
 * True when this tab has a local signed-in session candidate that has
 * not actually expired. The request layer still uses `getAccessToken()`
 * for the stricter skew-aware bearer check, so near-expired tokens
 * trigger refresh instead of making protected routes bounce to `/login`
 * first.
 */
export const useIsAuthenticated = () =>
  useAuthStore((s) => {
    if (
      s.authStatus !== 'authenticated' ||
      s.accessToken === null ||
      s.user === null ||
      s.expiresAt === null
    ) {
      return false
    }
    return Date.now() < s.expiresAt
  })
