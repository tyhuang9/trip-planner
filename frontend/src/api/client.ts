import axios, {
  AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios'
import { backendApiBaseUrl, buildApiUrl } from './baseUrl'
import { useAuthStore } from '../auth/authStore'
import type { AuthResponse } from '../types/auth'
import { reportAmbiguousBackendFailure } from '../outage/outageMonitor'

export const AUTH_COOKIE_ACTION_HEADER = 'X-Dupert-Auth-Cookie-Action'
export const AUTH_COOKIE_ACTION_VALUE = '1'
export const API_REQUEST_TIMEOUT_MS = 60_000

/**
 * Single shared axios instance for every backend call.
 *
 * - `baseURL` defaults to `/api` so Vite can proxy requests locally. When
 *   `VITE_BACKEND_API_URL` is set, it is treated as the backend base URL and
 *   the shared URL helper appends `/api`.
 * - `withCredentials: true` — required so the browser sends the
 *   `refresh_token` HttpOnly cookie on `/auth/refresh` and `/auth/logout`.
 *
 * The interceptor logic below implements transparent silent-refresh on
 * 401: a single in-flight refresh promise is shared across concurrent
 * 401s so we never fire more than one refresh.
 */
export const apiClient = axios.create({
  baseURL: backendApiBaseUrl,
  withCredentials: true,
  timeout: API_REQUEST_TIMEOUT_MS,
})

/** Endpoints that must NOT carry a bearer token. */
const PUBLIC_PATHS = new Set<string>([
  '/auth/login',
  '/auth/register',
  '/auth/password-reset/request',
  '/auth/password-reset/confirm',
  '/auth/email/verify',
  '/auth/email/resend',
  '/auth/refresh',
])

const GUEST_WRITE_HEADER = 'X-Dupert-Guest-Write'

/** True when the URL points at one of the unauthenticated/cookie-only endpoints. */
function isPublicPath(url: string | undefined): boolean {
  if (!url) return false
  // Strip query string. URL may be relative (`/auth/login`) or include the
  // baseURL prefix (`/api/auth/login`) depending on the caller — normalize
  // by trimming `/api` so we can do an exact match. Suffix-matching is
  // dangerous here: `/admin/audit-auth/login` must NOT be treated public.
  const withoutQuery = url.split('?')[0]
  const path = withoutQuery.startsWith('/api')
    ? withoutQuery.slice('/api'.length)
    : withoutQuery
  return PUBLIC_PATHS.has(path)
}

function normalizedPath(url: string | undefined): string {
  if (!url) return ''
  const withoutQuery = url.split('?')[0]
  return withoutQuery.startsWith('/api')
    ? withoutQuery.slice('/api'.length)
    : withoutQuery
}

function shouldSendGuestWriteHeader(config: InternalAxiosRequestConfig): boolean {
  const method = config.method?.toUpperCase()
  if (!method || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return false
  }
  const path = normalizedPath(config.url)
  return path.startsWith('/trips/') || path.startsWith('/activities/')
}

/**
 * Module-scoped singleton: while a refresh is in flight, all other
 * 401s wait on the same promise instead of each kicking off their own.
 * Reset back to null when the refresh settles (success OR failure).
 */
let refreshPromise: Promise<AuthResponse> | null = null

const REFRESH_LOCK_NAME = 'dupert:auth-refresh'
const REFRESH_LOCK_STORAGE_KEY = 'dupert:auth-refresh-lock'
const REFRESH_LOCK_TTL_MS = 10_000
const REFRESH_LOCK_POLL_MS = 50

interface LockManagerLike {
  request<T>(
    name: string,
    options: { mode: 'exclusive' },
    callback: () => T | Promise<T>,
  ): Promise<T>
}

interface RefreshLockLease {
  owner: string
  expiresAt: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function createLockOwner(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `owner-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
}

function parseRefreshLockLease(raw: string | null): RefreshLockLease | null {
  if (raw === null) {
    return null
  }
  try {
    const value = JSON.parse(raw) as Partial<RefreshLockLease>
    if (typeof value.owner !== 'string' || typeof value.expiresAt !== 'number') {
      return null
    }
    return { owner: value.owner, expiresAt: value.expiresAt }
  } catch {
    return null
  }
}

function getWebLocks(): LockManagerLike | null {
  const locks = (globalThis.navigator as { locks?: LockManagerLike } | undefined)
    ?.locks
  return locks?.request ? locks : null
}

function getRefreshLockStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function tryAcquireStorageRefreshLock(storage: Storage, owner: string): boolean {
  const now = Date.now()
  const current = parseRefreshLockLease(
    storage.getItem(REFRESH_LOCK_STORAGE_KEY),
  )
  if (current !== null && current.owner !== owner && current.expiresAt > now) {
    return false
  }

  const next: RefreshLockLease = {
    owner,
    expiresAt: now + REFRESH_LOCK_TTL_MS,
  }
  storage.setItem(REFRESH_LOCK_STORAGE_KEY, JSON.stringify(next))

  return (
    parseRefreshLockLease(storage.getItem(REFRESH_LOCK_STORAGE_KEY))?.owner ===
    owner
  )
}

function renewStorageRefreshLock(storage: Storage, owner: string): boolean {
  const current = parseRefreshLockLease(
    storage.getItem(REFRESH_LOCK_STORAGE_KEY),
  )
  if (current?.owner !== owner) {
    return false
  }

  const next: RefreshLockLease = {
    owner,
    expiresAt: Date.now() + REFRESH_LOCK_TTL_MS,
  }
  storage.setItem(REFRESH_LOCK_STORAGE_KEY, JSON.stringify(next))
  return true
}

function releaseStorageRefreshLock(storage: Storage, owner: string): void {
  const current = parseRefreshLockLease(
    storage.getItem(REFRESH_LOCK_STORAGE_KEY),
  )
  if (current?.owner === owner) {
    storage.removeItem(REFRESH_LOCK_STORAGE_KEY)
  }
}

async function withStorageRefreshLock<T>(callback: () => Promise<T>): Promise<T> {
  const storage = getRefreshLockStorage()
  if (storage === null) {
    return callback()
  }

  const owner = createLockOwner()

  while (true) {
    let acquired: boolean
    try {
      acquired = tryAcquireStorageRefreshLock(storage, owner)
    } catch {
      return callback()
    }

    if (acquired) {
      const renewTimer = window.setInterval(() => {
        try {
          renewStorageRefreshLock(storage, owner)
        } catch {
          window.clearInterval(renewTimer)
        }
      }, REFRESH_LOCK_TTL_MS / 2)
      try {
        return await callback()
      } finally {
        window.clearInterval(renewTimer)
        try {
          releaseStorageRefreshLock(storage, owner)
        } catch {
          // If storage becomes unavailable mid-refresh, the short lease
          // expires by itself and contains no auth material.
        }
      }
    }

    await sleep(REFRESH_LOCK_POLL_MS)
  }
}

function refreshWithCrossTabLock(): Promise<AuthResponse> {
  const locks = getWebLocks()
  if (locks !== null) {
    return locks.request(REFRESH_LOCK_NAME, { mode: 'exclusive' }, () =>
      performRefresh(),
    )
  }

  return withStorageRefreshLock(() => performRefresh())
}

/**
 * POSTs `/auth/refresh` via a bare `axios.post` (NOT through `apiClient`)
 * so it can never be caught by `apiClient`'s own response interceptor —
 * a 401 from refresh must surface directly to the caller, not trigger a
 * recursive refresh.
 *
 * On success, writes the new session into the auth store; on failure
 * clears the store and rethrows.
 *
 * IMPORTANT: this is the ONLY function in the frontend that should hit the
 * refresh endpoint. Both the response interceptor (on 401) and the
 * `AuthProvider` mount probe go through here so refresh is funneled
 * through a single code path with a single dedupe singleton.
 *
 * Defined here (rather than in `api/auth.ts`) to avoid an import cycle:
 * `api/auth.ts` imports `apiClient` from this module, and the
 * interceptor needs the refresh primitive. Keep them split.
 */
async function performRefresh(): Promise<AuthResponse> {
  const accessTokenAtStart = useAuthStore.getState().accessToken
  try {
    const response = await axios.post<AuthResponse>(
      buildApiUrl('/auth/refresh'),
      undefined,
      {
        withCredentials: true,
        timeout: API_REQUEST_TIMEOUT_MS,
        headers: { [AUTH_COOKIE_ACTION_HEADER]: AUTH_COOKIE_ACTION_VALUE },
      },
    )
    const { accessToken, expiresInSeconds, user } = response.data
    useAuthStore.getState().setSession({ accessToken, expiresInSeconds, user })
    return response.data
  } catch (err) {
    reportAmbiguousBackendFailure(err as AxiosError)
    if (useAuthStore.getState().accessToken === accessTokenAtStart) {
      useAuthStore.getState().clearSession()
    }
    throw err
  }
}

/**
 * Public refresh helper — dedupes concurrent refresh calls behind a
 * single in-flight promise so the response interceptor and the
 * AuthProvider mount probe never race two `/auth/refresh` requests.
 *
 * This is the only function callers should use to hit `/auth/refresh`.
 */
export function refreshSession(): Promise<AuthResponse> {
  if (refreshPromise === null) {
    refreshPromise = refreshWithCrossTabLock().finally(() => {
      refreshPromise = null
    })
  }
  return refreshPromise
}

type RetryableConfig = InternalAxiosRequestConfig & { _retry?: boolean }

function hasLocalSessionCandidate(): boolean {
  const { accessToken, expiresAt, user } = useAuthStore.getState()
  return accessToken !== null && expiresAt !== null && user !== null
}

// ---------------------------------------------------------------------------
// Request interceptor — attach Authorization header when we have a usable token.
// ---------------------------------------------------------------------------
apiClient.interceptors.request.use(async (config) => {
  if (isPublicPath(config.url)) {
    return config
  }

  const startedWithSessionCandidate = hasLocalSessionCandidate()
  let token = useAuthStore.getState().getAccessToken()

  if (!token && startedWithSessionCandidate) {
    try {
      await refreshSession()
      token = useAuthStore.getState().getAccessToken()
    } catch {
      const retryableConfig = config as RetryableConfig
      retryableConfig._retry = true
    }
  }

  if (token) {
    config.headers.set('Authorization', `Bearer ${token}`)
  } else if (!startedWithSessionCandidate && shouldSendGuestWriteHeader(config)) {
    config.headers.set(GUEST_WRITE_HEADER, '1')
  }
  return config
})

/**
 * Marker on the request config so we don't loop. Set after the first
 * 401 + refresh + retry; if the retried request 401s again we let it
 * propagate instead of triggering another refresh round.
 */
// ---------------------------------------------------------------------------
// Response interceptor — single-flight silent refresh on 401, then retry once.
// ---------------------------------------------------------------------------
apiClient.interceptors.response.use(
  (response: AxiosResponse) => response,
  async (error: AxiosError) => {
    reportAmbiguousBackendFailure(error)
    const original = error.config as RetryableConfig | undefined
    const status = error.response?.status

    // Only intercept 401s on requests we know about, and never retry a
    // refresh-itself failure (would loop). Public paths (login, register,
    // refresh) bubble the 401 straight to the caller.
    if (
      status !== 401 ||
      !original ||
      original._retry ||
      isPublicPath(original.url)
    ) {
      return Promise.reject(error)
    }

    original._retry = true

    try {
      await refreshSession()
    } catch {
      // refreshSession already cleared the store on failure; surface the
      // original 401 so the caller sees the shape it expects.
      return Promise.reject(error)
    }

    // Refresh succeeded — re-issue the original request with the new
    // access token. The request interceptor will pick it up again from
    // the store, but we set it explicitly here to guarantee consistency
    // even if another tab has rotated meanwhile.
    const newToken = useAuthStore.getState().getAccessToken()
    if (newToken && original.headers) {
      original.headers.set('Authorization', `Bearer ${newToken}`)
    }
    return apiClient.request(original)
  },
)

/**
 * Test-only escape hatch: reset the in-flight refresh singleton between
 * cases. Importing this from production code is a smell — keep it inside
 * the test suite.
 */
export function __resetRefreshSingletonForTests(): void {
  refreshPromise = null
  getRefreshLockStorage()?.removeItem(REFRESH_LOCK_STORAGE_KEY)
}
