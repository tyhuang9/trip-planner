import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MockAdapter from 'axios-mock-adapter'
import axios from 'axios'
import {
  __resetRefreshSingletonForTests,
  API_REQUEST_TIMEOUT_MS,
  apiClient,
  AuthCoordinationUnavailableError,
  AuthResolutionPendingError,
  AUTH_COOKIE_ACTION_HEADER,
  AUTH_COOKIE_ACTION_VALUE,
  refreshSession,
  withAuthSessionLock,
} from './client'
import { useAuthStore } from '../auth/authStore'
import {
  clearPendingLogoutIntent,
  persistPendingLogoutIntent,
} from '../auth/logoutIntent'

/**
 * The interceptor calls the refresh endpoint with a fresh axios instance
 * instead of `apiClient` to keep the refresh path out of its own retry loop.
 * So we mount TWO adapters: one on `apiClient` for the original requests,
 * and one on the global `axios` default for the refresh call.
 */
let apiMock: MockAdapter
let refreshMock: MockAdapter

const SAMPLE_USER = {
  id: 7,
  email: 'q@r.com',
  displayName: 'Q',
  emailVerified: true,
}
let originalLocksDescriptor: PropertyDescriptor | undefined

beforeEach(() => {
  clearPendingLogoutIntent()
  originalLocksDescriptor = Object.getOwnPropertyDescriptor(
    globalThis.navigator,
    'locks',
  )
  __resetRefreshSingletonForTests()
  useAuthStore.getState().clearSession()
  apiMock = new MockAdapter(apiClient)
  refreshMock = new MockAdapter(axios)
})

afterEach(() => {
  apiMock.restore()
  refreshMock.restore()
  if (originalLocksDescriptor) {
    Object.defineProperty(
      globalThis.navigator,
      'locks',
      originalLocksDescriptor,
    )
  } else {
    Reflect.deleteProperty(globalThis.navigator, 'locks')
  }
  clearPendingLogoutIntent()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('apiClient request interceptor', () => {
  it('defaults to the same-origin API base URL', () => {
    expect(apiClient.defaults.baseURL).toBe('/api')
  })

  it('sends cookies with apiClient requests', () => {
    expect(apiClient.defaults.withCredentials).toBe(true)
  })

  it('uses a bounded timeout that still allows a cold backend start', () => {
    expect(API_REQUEST_TIMEOUT_MS).toBe(60_000)
    expect(apiClient.defaults.timeout).toBe(API_REQUEST_TIMEOUT_MS)
  })

  it('attaches Authorization header when a token is present', async () => {
    useAuthStore.getState().setSession({
      accessToken: 'live-tok',
      expiresInSeconds: 900,
      user: SAMPLE_USER,
    })

    apiMock.onGet('/probe').reply((cfg) => {
      const auth = cfg.headers?.['Authorization'] ?? cfg.headers?.['authorization']
      return [200, { ok: true, auth }]
    })

    const res = await apiClient.get('/probe')
    expect(res.data.auth).toBe('Bearer live-tok')
  })

  it('does not attach Authorization on auth public paths', async () => {
    useAuthStore.getState().setSession({
      accessToken: 'live-tok',
      expiresInSeconds: 900,
      user: SAMPLE_USER,
    })

    apiMock.onPost('/auth/login').reply((cfg) => {
      const auth = cfg.headers?.['Authorization'] ?? cfg.headers?.['authorization']
      return [200, { auth: auth ?? null }]
    })

    const { data } = await apiClient.post('/auth/login', { email: 'x', password: 'y' })
    expect(data.auth).toBeNull()

    apiMock.onPost('/auth/email/verify').reply((cfg) => {
      const auth = cfg.headers?.['Authorization'] ?? cfg.headers?.['authorization']
      return [204, { auth: auth ?? null }]
    })

    const verification = await apiClient.post('/auth/email/verify', {
      token: 'verification-token',
    })
    expect(verification.data.auth).toBeNull()
  })

  it('allows cookie-only logout while revocation is pending', async () => {
    useAuthStore.getState().setSession({
      accessToken: 'live-tok',
      expiresInSeconds: 900,
      user: SAMPLE_USER,
    })
    persistPendingLogoutIntent()
    apiMock.onPost('/auth/logout').reply((config) => [
      204,
      {
        auth:
          config.headers?.['Authorization'] ??
          config.headers?.['authorization'] ??
          null,
      },
    ])

    const response = await apiClient.post('/auth/logout')
    expect(response.data.auth).toBeNull()
  })

  it('blocks protected requests while authentication is unresolved', async () => {
    useAuthStore.getState().clearSession('offline-unknown')

    await expect(apiClient.get('/protected')).rejects.toBeInstanceOf(
      AuthResolutionPendingError,
    )
    expect(apiMock.history.get).toHaveLength(0)
  })

  it('keeps the guest bootstrap cookie-only even when member state is present', async () => {
    useAuthStore.getState().setSession({
      accessToken: 'live-tok',
      expiresInSeconds: 900,
      user: SAMPLE_USER,
    })

    apiMock.onGet('/guest-session/bootstrap').reply((cfg) => {
      const auth = cfg.headers?.['Authorization'] ?? cfg.headers?.['authorization']
      return [204, { auth: auth ?? null }]
    })

    const response = await apiClient.get('/guest-session/bootstrap')
    expect(response.data.auth).toBeNull()
  })

  it('keeps public guest share acceptance cookie-only when member state is present', async () => {
    useAuthStore.getState().setSession({
      accessToken: 'live-tok',
      expiresInSeconds: 900,
      user: SAMPLE_USER,
    })

    apiMock.onPost('/share/guest').reply((cfg) => {
      const auth = cfg.headers?.['Authorization'] ?? cfg.headers?.['authorization']
      return [200, { auth: auth ?? null }]
    })

    const response = await apiClient.post('/share/guest', {
      token: 'share-token',
      displayName: 'Guest Alice',
    })
    expect(response.data.auth).toBeNull()
  })

  it('does NOT treat suffix matches like /admin/audit-auth/login as public (regression)', async () => {
    // The previous `path.endsWith(p)` check would have wrongly classified
    // this URL as public and stripped the bearer header. Exact-match
    // against the public path set guards against that.
    useAuthStore.getState().setSession({
      accessToken: 'live-tok',
      expiresInSeconds: 900,
      user: SAMPLE_USER,
    })

    apiMock.onPost('/admin/audit-auth/login').reply((cfg) => {
      const auth = cfg.headers?.['Authorization'] ?? cfg.headers?.['authorization']
      return [200, { auth: auth ?? null }]
    })

    const { data } = await apiClient.post('/admin/audit-auth/login', {})
    expect(data.auth).toBe('Bearer live-tok')
  })

  it('adds the guest write header on trip writes when no bearer token is present', async () => {
    apiMock.onPost('/trips/abc234def567/activities').reply((cfg) => {
      const guestWrite =
        cfg.headers?.['X-Dupert-Guest-Write'] ??
        cfg.headers?.['x-dupert-guest-write']
      const auth = cfg.headers?.['Authorization'] ?? cfg.headers?.['authorization']
      return [200, { guestWrite, auth: auth ?? null }]
    })

    const { data } = await apiClient.post('/trips/abc234def567/activities', {})
    expect(data.guestWrite).toBe('1')
    expect(data.auth).toBeNull()
  })

  it('does not add the guest write header when a bearer token is present', async () => {
    useAuthStore.getState().setSession({
      accessToken: 'live-tok',
      expiresInSeconds: 900,
      user: SAMPLE_USER,
    })

    apiMock.onPost('/trips/abc234def567/activities').reply((cfg) => {
      const guestWrite =
        cfg.headers?.['X-Dupert-Guest-Write'] ??
        cfg.headers?.['x-dupert-guest-write']
      const auth = cfg.headers?.['Authorization'] ?? cfg.headers?.['authorization']
      return [200, { guestWrite: guestWrite ?? null, auth }]
    })

    const { data } = await apiClient.post('/trips/abc234def567/activities', {})
    expect(data.guestWrite).toBeNull()
    expect(data.auth).toBe('Bearer live-tok')
  })

  it('refreshes a signed-in skewed token before trip writes instead of sending a guest write', async () => {
    useAuthStore.getState().setSession({
      accessToken: 'skewed-tok',
      expiresInSeconds: 20,
      user: SAMPLE_USER,
    })
    refreshMock.onPost('/api/auth/refresh').reply(200, {
      accessToken: 'fresh-write-tok',
      tokenType: 'Bearer',
      expiresInSeconds: 900,
      user: SAMPLE_USER,
    })
    apiMock.onPost('/trips/abc234def567/activities').reply((cfg) => {
      const guestWrite =
        cfg.headers?.['X-Dupert-Guest-Write'] ??
        cfg.headers?.['x-dupert-guest-write']
      const auth = cfg.headers?.['Authorization'] ?? cfg.headers?.['authorization']
      return [200, { guestWrite: guestWrite ?? null, auth: auth ?? null }]
    })

    const { data } = await apiClient.post('/trips/abc234def567/activities', {})

    expect(refreshMock.history.post).toHaveLength(1)
    expect(data.guestWrite).toBeNull()
    expect(data.auth).toBe('Bearer fresh-write-tok')
  })

  it('does not downgrade a signed-in skewed write to a guest write when refresh fails', async () => {
    useAuthStore.getState().setSession({
      accessToken: 'skewed-tok',
      expiresInSeconds: 20,
      user: SAMPLE_USER,
    })
    refreshMock.onPost('/api/auth/refresh').reply(401, { error: 'unauthenticated' })
    apiMock.onPost('/trips/abc234def567/activities').reply((cfg) => {
      const guestWrite =
        cfg.headers?.['X-Dupert-Guest-Write'] ??
        cfg.headers?.['x-dupert-guest-write']
      const auth = cfg.headers?.['Authorization'] ?? cfg.headers?.['authorization']
      return [401, { guestWrite: guestWrite ?? null, auth: auth ?? null }]
    })

    await expect(
      apiClient.post('/trips/abc234def567/activities', {}),
    ).rejects.toMatchObject({
      response: { status: 401 },
    })

    expect(refreshMock.history.post).toHaveLength(1)
    expect(apiMock.history.post[0].headers?.['X-Dupert-Guest-Write']).toBe(
      undefined,
    )
    expect(apiMock.history.post[0].headers?.['Authorization']).toBe(undefined)
  })
})

describe('apiClient response interceptor — refresh on 401', () => {
  it('on 401 calls /auth/refresh once, retries with new token, succeeds', async () => {
    // First call to /protected returns 401; the retry returns 200.
    let protectedCalls = 0
    apiMock.onGet('/protected').reply((cfg) => {
      protectedCalls += 1
      if (protectedCalls === 1) return [401, { error: 'unauthenticated' }]
      const auth = cfg.headers?.['Authorization'] ?? cfg.headers?.['authorization']
      return [200, { ok: true, auth }]
    })

    refreshMock.onPost('/api/auth/refresh').reply(200, {
      accessToken: 'rotated-tok',
      tokenType: 'Bearer',
      expiresInSeconds: 900,
      user: SAMPLE_USER,
    })

    const { data } = await apiClient.get('/protected')

    expect(protectedCalls).toBe(2)
    expect(refreshMock.history.post).toHaveLength(1)
    expect(data.auth).toBe('Bearer rotated-tok')
    expect(useAuthStore.getState().accessToken).toBe('rotated-tok')
  })

  it('clears the auth store and propagates the original 401 if refresh itself fails', async () => {
    useAuthStore.getState().setSession({
      accessToken: 'stale-tok',
      expiresInSeconds: 900,
      user: SAMPLE_USER,
    })

    apiMock.onGet('/protected').reply(401, { error: 'unauthenticated' })
    refreshMock.onPost('/api/auth/refresh').reply(401, { error: 'unauthenticated' })

    await expect(apiClient.get('/protected')).rejects.toMatchObject({
      response: { status: 401 },
    })
    expect(useAuthStore.getState().accessToken).toBeNull()
    expect(useAuthStore.getState().user).toBeNull()
    expect(useAuthStore.getState().authStatus).toBe('clearing-session')
  })

  it.each([
    ['network failure', () => refreshMock.onPost('/api/auth/refresh').networkError()],
    ['server failure', () => refreshMock.onPost('/api/auth/refresh').reply(503)],
  ])('marks auth unresolved after a %s during refresh', async (_label, arrangeFailure) => {
    useAuthStore.getState().setSession({
      accessToken: 'stale-tok',
      expiresInSeconds: 900,
      user: SAMPLE_USER,
    })
    apiMock.onGet('/protected').reply(401, { error: 'unauthenticated' })
    arrangeFailure()

    await expect(apiClient.get('/protected')).rejects.toBeDefined()

    expect(useAuthStore.getState().accessToken).toBeNull()
    expect(useAuthStore.getState().authStatus).toBe('offline-unknown')
  })

  it('does not retry the same request more than once (no infinite loop)', async () => {
    let protectedCalls = 0
    apiMock.onGet('/protected').reply(() => {
      protectedCalls += 1
      return [401, { error: 'unauthenticated' }]
    })

    // Refresh succeeds, but /protected keeps returning 401 — the retry must
    // give up on the second 401 instead of triggering another refresh.
    let refreshCalls = 0
    refreshMock.onPost('/api/auth/refresh').reply(() => {
      refreshCalls += 1
      return [
        200,
        {
          accessToken: 'rotated-tok',
          tokenType: 'Bearer',
          expiresInSeconds: 900,
          user: SAMPLE_USER,
        },
      ]
    })

    await expect(apiClient.get('/protected')).rejects.toMatchObject({
      response: { status: 401 },
    })

    // First attempt + one retry = 2 protected calls; refresh happens exactly once.
    expect(protectedCalls).toBe(2)
    expect(refreshCalls).toBe(1)
  })

  it('coalesces concurrent 401s into a single refresh call', async () => {
    let protectedACalls = 0
    let protectedBCalls = 0
    apiMock.onGet('/a').reply(() => {
      protectedACalls += 1
      return protectedACalls === 1 ? [401, {}] : [200, { who: 'a' }]
    })
    apiMock.onGet('/b').reply(() => {
      protectedBCalls += 1
      return protectedBCalls === 1 ? [401, {}] : [200, { who: 'b' }]
    })

    let refreshCalls = 0
    refreshMock.onPost('/api/auth/refresh').reply(() => {
      refreshCalls += 1
      return [
        200,
        {
          accessToken: 'rotated-tok',
          tokenType: 'Bearer',
          expiresInSeconds: 900,
          user: SAMPLE_USER,
        },
      ]
    })

    const [a, b] = await Promise.all([apiClient.get('/a'), apiClient.get('/b')])
    expect(a.data.who).toBe('a')
    expect(b.data.who).toBe('b')
    expect(refreshCalls).toBe(1)
  })
})

describe('refreshSession cross-tab coordination', () => {
  it('serializes delayed refresh work before another tab can revoke the session', async () => {
    let lockTail = Promise.resolve<unknown>(undefined)
    const request = vi.fn(
      <T,>(
        _name: string,
        _options: { mode: 'exclusive' },
        callback: () => T | Promise<T>,
      ): Promise<T> => {
        const run = lockTail.then(callback)
        lockTail = run.then(
          () => undefined,
          () => undefined,
        )
        return run
      },
    )
    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable: true,
      value: { request },
    })

    let resolveRefresh:
      | ((value: [number, Record<string, unknown>]) => void)
      | undefined
    refreshMock.onPost('/api/auth/refresh').reply(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve
        }),
    )

    const refreshResult = refreshSession().then(
      () => 'resolved' as const,
      () => 'rejected' as const,
    )
    await vi.waitFor(() => expect(refreshMock.history.post).toHaveLength(1))

    persistPendingLogoutIntent()
    const revoke = vi.fn(async () => undefined)
    const logoutWork = withAuthSessionLock(revoke)
    await Promise.resolve()

    expect(revoke).not.toHaveBeenCalled()
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[0][0]).toBe(request.mock.calls[1][0])

    resolveRefresh?.([
      200,
      {
        accessToken: 'must-not-survive',
        tokenType: 'Bearer',
        expiresInSeconds: 900,
        user: SAMPLE_USER,
      },
    ])

    await expect(refreshResult).resolves.toBe('rejected')
    await logoutWork
    expect(revoke).toHaveBeenCalledOnce()
    expect(useAuthStore.getState().accessToken).toBeNull()
  })

  it('does not refresh while logout revocation is pending', async () => {
    persistPendingLogoutIntent()

    await expect(refreshSession()).rejects.toBeInstanceOf(
      AuthResolutionPendingError,
    )
    expect(refreshMock.history.post).toHaveLength(0)
    expect(useAuthStore.getState().authStatus).toBe('offline-unknown')
  })

  it('coalesces direct in-tab refresh callers', async () => {
    let refreshCalls = 0
    refreshMock.onPost('/api/auth/refresh').reply(() => {
      refreshCalls += 1
      return [
        200,
        {
          accessToken: 'coalesced-tok',
          tokenType: 'Bearer',
          expiresInSeconds: 900,
          user: SAMPLE_USER,
        },
      ]
    })

    const [first, second] = await Promise.all([refreshSession(), refreshSession()])

    expect(refreshCalls).toBe(1)
    expect(refreshMock.history.post[0].headers?.[AUTH_COOKIE_ACTION_HEADER]).toBe(
      AUTH_COOKIE_ACTION_VALUE,
    )
    expect(refreshMock.history.post[0].timeout).toBe(API_REQUEST_TIMEOUT_MS)
    expect(first.accessToken).toBe('coalesced-tok')
    expect(second.accessToken).toBe('coalesced-tok')
  })

  it('does not clear a newer session when an older refresh fails', async () => {
    refreshMock.onPost('/api/auth/refresh').reply(() => {
      useAuthStore.getState().setSession({
        accessToken: 'verified-after-refresh-started',
        expiresInSeconds: 900,
        user: SAMPLE_USER,
      })
      return [401, { error: 'unauthenticated' }]
    })

    await expect(refreshSession()).rejects.toMatchObject({
      response: { status: 401 },
    })

    expect(useAuthStore.getState().accessToken).toBe(
      'verified-after-refresh-started',
    )
  })

  it('waits for Web Lock acquisition before refreshing', async () => {
    let releaseLock: (() => void) | undefined
    const request = vi.fn(
      (
        _name: string,
        _options: { mode: 'exclusive' },
        callback: () => Promise<unknown>,
      ) =>
        new Promise((resolve, reject) => {
          releaseLock = () => {
            callback().then(resolve, reject)
          }
        }),
    )
    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable: true,
      value: { request },
    })
    refreshMock.onPost('/api/auth/refresh').reply(200, {
      accessToken: 'web-lock-tok',
      tokenType: 'Bearer',
      expiresInSeconds: 900,
      user: SAMPLE_USER,
    })

    const pending = refreshSession()
    await Promise.resolve()

    expect(request).toHaveBeenCalledTimes(1)
    expect(request.mock.calls[0][0]).toBe('dupert:auth-refresh')
    expect(request.mock.calls[0][1]).toEqual({ mode: 'exclusive' })
    expect(refreshMock.history.post).toHaveLength(0)

    releaseLock?.()

    await expect(pending).resolves.toMatchObject({
      accessToken: 'web-lock-tok',
    })
    expect(refreshMock.history.post).toHaveLength(1)
    expect(refreshMock.history.post[0].withCredentials).toBe(true)
  })

  it('fails closed when secure cross-tab coordination is unavailable', async () => {
    Reflect.deleteProperty(globalThis.navigator, 'locks')
    useAuthStore.getState().clearSession('restoring')

    await expect(refreshSession()).rejects.toBeInstanceOf(
      AuthCoordinationUnavailableError,
    )
    expect(refreshMock.history.post).toHaveLength(0)
    expect(useAuthStore.getState().authStatus).toBe('offline-unknown')
  })
})
