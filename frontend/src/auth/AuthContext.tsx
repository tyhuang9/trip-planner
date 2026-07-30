import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react'
import * as authApi from '../api/auth'
import {
  isConfirmedUnauthenticated,
  refreshSession,
  waitForRefreshToSettle,
  withAuthSessionLock,
} from '../api/client'
import { useQueryClient } from '@tanstack/react-query'
import { useAuthStore, useIsAuthenticated, useUser } from './authStore'
import { AuthContext, type AuthContextValue } from './authContextValue'
import { markPerformance } from '../performance/timing'
import type {
  EmailVerificationResendRequest,
  LoginRequest,
  RegisterRequest,
} from '../types/auth'
import {
  clearPendingLogoutIntent,
  hasPendingLogoutIntent,
  PENDING_LOGOUT_CHANGED_EVENT,
  PENDING_LOGOUT_STORAGE_KEY,
  persistPendingLogoutIntent,
} from './logoutIntent'

interface AuthProviderProps {
  children: ReactNode
}

const PROACTIVE_REFRESH_LEAD_MS = 60_000
let logoutRevocationPromise: Promise<void> | null = null

function shouldRefreshSessionSoon(expiresAt: number): boolean {
  return Date.now() >= expiresAt - PROACTIVE_REFRESH_LEAD_MS
}

function revokePendingLogout(): Promise<void> {
  if (!hasPendingLogoutIntent()) return Promise.resolve()
  if (logoutRevocationPromise !== null) return logoutRevocationPromise

  logoutRevocationPromise = (async () => {
    await waitForRefreshToSettle()
    await withAuthSessionLock(async () => {
      try {
        await authApi.logout()
      } catch (error) {
        if (!isConfirmedUnauthenticated(error)) throw error
      }
    })
    if (!clearPendingLogoutIntent()) {
      throw new Error('Could not clear the pending logout marker.')
    }
  })().finally(() => {
    logoutRevocationPromise = null
  })

  return logoutRevocationPromise
}

/**
 * Wraps the app and exposes the auth API. On first mount, attempts a
 * silent `/auth/refresh` — the refresh cookie may exist from a prior
 * session and the user expects to stay logged in across reloads. If
 * refresh fails the user simply lands logged-out; the failure is not
 * surfaced because "no prior session" looks identical to "expired".
 */
export function AuthProvider({ children }: AuthProviderProps) {
  const queryClient = useQueryClient()
  const user = useUser()
  const isAuthenticated = useIsAuthenticated()
  const authStatus = useAuthStore((s) => s.authStatus)
  const expiresAt = useAuthStore((s) => s.expiresAt)
  const setSession = useAuthStore((s) => s.setSession)
  const setUser = useAuthStore((s) => s.setUser)
  const setAuthStatus = useAuthStore((s) => s.setAuthStatus)
  const clearSession = useAuthStore((s) => s.clearSession)
  const isInitializing =
    authStatus === 'restoring' ||
    authStatus === 'clearing-session' ||
    authStatus === 'offline-unknown'
  const identityCacheSnapshot = useMemo(() => {
    if (
      authStatus !== 'clearing-session' &&
      authStatus !== 'offline-unknown' &&
      authStatus !== 'unauthenticated'
    ) {
      return null
    }
    return {
      queryHashes: new Set(
        queryClient
          .getQueryCache()
          .getAll()
          .filter(
            (query) =>
              query.state.data !== undefined ||
              query.state.fetchStatus === 'fetching' ||
              query.state.status === 'error',
          )
          .map((query) => query.queryHash),
      ),
      mutations: queryClient.getMutationCache().getAll(),
    }
  }, [authStatus, queryClient])
  // Guard against StrictMode double-invoke: useEffect runs twice in dev,
  // we don't want two refresh probes on cold start. `probedRef` blocks
  // the second run; `cancelledRef` is shared across both runs so that
  // the synthetic StrictMode cleanup (which runs between the two
  // invocations) doesn't poison the in-flight promise's state updates.
  const probedRef = useRef(false)
  const cancelledRef = useRef(false)

  const syncPendingLogout = useCallback(async () => {
    if (!hasPendingLogoutIntent()) return
    clearSession('offline-unknown')
    try {
      await revokePendingLogout()
      clearSession('unauthenticated')
    } catch {
      clearSession('offline-unknown')
      throw new Error('Logout revocation is still pending.')
    }
  }, [clearSession])

  useEffect(() => {
    if (probedRef.current) return
    probedRef.current = true

    if (hasPendingLogoutIntent()) {
      void syncPendingLogout().catch(() => undefined)
      return
    }

    if (useAuthStore.getState().accessToken !== null) {
      // Session was pre-seeded; setSession already marked it authenticated.
      return
    }

    setAuthStatus('restoring')

    // `refreshSession()` is the single funnel for `/auth/refresh` calls
    // — same code path the response interceptor uses on 401, deduped by
    // a shared in-flight singleton. It already writes into the auth
    // store, but we re-invoke `setSession` here so the provider's mount
    // probe owns the visible state transition for testability.
    refreshSession()
      .then((res) => {
        if (cancelledRef.current) return
        setSession({
          accessToken: res.accessToken,
          expiresInSeconds: res.expiresInSeconds,
          user: res.user,
        })
      })
      .catch(() => {
        // refreshSession classifies 401 as confirmed unauthenticated and
        // ambiguous transport/server failures as offline-unknown.
      })
  }, [setAuthStatus, setSession, syncPendingLogout])

  useEffect(() => {
    const retryPendingLogout = () => {
      if (hasPendingLogoutIntent()) {
        void syncPendingLogout().catch(() => undefined)
      }
    }
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== PENDING_LOGOUT_STORAGE_KEY) return
      if (hasPendingLogoutIntent()) {
        retryPendingLogout()
      } else {
        clearSession('unauthenticated')
      }
    }
    const handleFocus = () => {
      if (navigator.onLine !== false) retryPendingLogout()
    }

    window.addEventListener('online', retryPendingLogout)
    window.addEventListener('focus', handleFocus)
    window.addEventListener('storage', handleStorage)
    window.addEventListener(PENDING_LOGOUT_CHANGED_EVENT, retryPendingLogout)
    return () => {
      window.removeEventListener('online', retryPendingLogout)
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('storage', handleStorage)
      window.removeEventListener(PENDING_LOGOUT_CHANGED_EVENT, retryPendingLogout)
    }
  }, [clearSession, syncPendingLogout])

  useEffect(() => {
    if (identityCacheSnapshot === null) return

    // Existing query keys are not partitioned by identity. Remove the queries
    // and mutations captured before children rendered this auth boundary, so a
    // prior member's protected workspace cannot remain visible offline while
    // a newly enabled guest query is allowed to start normally.
    queryClient.removeQueries({
      predicate: (query) =>
        identityCacheSnapshot.queryHashes.has(query.queryHash),
    })
    for (const mutation of identityCacheSnapshot.mutations) {
      queryClient.getMutationCache().remove(mutation)
    }
    if (authStatus === 'clearing-session') {
      clearSession('unauthenticated')
    }
  }, [authStatus, clearSession, identityCacheSnapshot, queryClient])

  useEffect(() => {
    if (authStatus === 'authenticated' || authStatus === 'unauthenticated') {
      markPerformance('auth-restored')
    }
  }, [authStatus])

  // Real-unmount guard: flip cancel only on a true unmount. StrictMode
  // dev double-invokes ALL effects (mount → cleanup → mount); resetting
  // `cancelledRef.current` to `false` at the top of each setup ensures
  // the synthetic mid-mount cleanup doesn't permanently poison the
  // in-flight probe. On real unmount the body never re-runs, so the
  // flag stays true and the dangling promise's state updates short-circuit.
  useEffect(() => {
    cancelledRef.current = false
    return () => {
      cancelledRef.current = true
    }
  }, [])

  useEffect(() => {
    if (user === null || expiresAt === null) {
      return
    }

    const refreshIfDue = () => {
      if (!shouldRefreshSessionSoon(expiresAt)) {
        return
      }
      refreshSession().catch(() => {
        // refreshSession clears local auth state on failure.
      })
    }
    const refreshDelayMs = Math.max(
      0,
      expiresAt - Date.now() - PROACTIVE_REFRESH_LEAD_MS,
    )
    const refreshTimer = window.setTimeout(refreshIfDue, refreshDelayMs)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refreshIfDue()
      }
    }

    window.addEventListener('focus', refreshIfDue)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    if (document.visibilityState === 'visible') {
      refreshIfDue()
    }

    return () => {
      window.clearTimeout(refreshTimer)
      window.removeEventListener('focus', refreshIfDue)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [expiresAt, user])

  const login = useCallback(
    async (body: LoginRequest) => {
      const res = await authApi.login(body)
      setSession({
        accessToken: res.accessToken,
        expiresInSeconds: res.expiresInSeconds,
        user: res.user,
      })
      return res.user
    },
    [setSession],
  )

  const retryAuthResolution = useCallback(async () => {
    if (hasPendingLogoutIntent()) {
      try {
        await syncPendingLogout()
      } catch {
        // Keep the explicit pending-logout state visible.
      }
      return
    }
    setAuthStatus('restoring')
    try {
      await refreshSession()
    } catch {
      // refreshSession owns the resulting unauthenticated/offline state.
    }
  }, [setAuthStatus, syncPendingLogout])

  const register = useCallback(
    async (body: RegisterRequest) => {
      return authApi.register(body)
    },
    [],
  )

  const logout = useCallback(async () => {
    persistPendingLogoutIntent()
    clearSession('offline-unknown')
    try {
      await syncPendingLogout()
    } catch {
      // The tombstone keeps this device locally signed out and blocks
      // restoration until reconnect can finish server-side revocation.
    }
  }, [clearSession, syncPendingLogout])

  const updateProfile = useCallback(
    async (body: { displayName: string }) => {
      const updatedUser = await authApi.updateProfile(body)
      setUser(updatedUser)
      return updatedUser
    },
    [setUser],
  )

  const changePassword = useCallback(
    async (body: { currentPassword: string; newPassword: string }) => {
      await authApi.changePassword(body)
    },
    [],
  )

  const requestPasswordReset = useCallback(
    async (body: { email: string }) => {
      await authApi.requestPasswordReset(body)
    },
    [],
  )

  const resendEmailVerification = useCallback(
    async (body: EmailVerificationResendRequest) => {
      await authApi.resendEmailVerification(body)
    },
    [],
  )

  const deleteAccount = useCallback(async () => {
    await authApi.deleteMe()
    clearSession('clearing-session')
  }, [clearSession])

  const value = useMemo<AuthContextValue>(
    () => ({
      authStatus,
      user,
      isAuthenticated,
      isInitializing,
      retryAuthResolution,
      login,
      register,
      updateProfile,
      changePassword,
      requestPasswordReset,
      resendEmailVerification,
      logout,
      deleteAccount,
    }),
    [
      user,
      authStatus,
      isAuthenticated,
      isInitializing,
      retryAuthResolution,
      login,
      register,
      updateProfile,
      changePassword,
      requestPasswordReset,
      resendEmailVerification,
      logout,
      deleteAccount,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
