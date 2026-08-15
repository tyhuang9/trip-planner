import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import MockAdapter from 'axios-mock-adapter'
import axios from 'axios'
import {
  __resetRefreshSingletonForTests,
  API_REQUEST_TIMEOUT_MS,
  REFRESH_LOCK_DEADLINE_MS,
  apiClient,
  AUTH_COOKIE_ACTION_HEADER,
  AUTH_COOKIE_ACTION_VALUE,
  refreshSession,
} from './client'
import { useAuthStore } from '../auth/authStore'

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
const REFRESH_LOCK_STORAGE_KEY = 'dupert:auth-refresh-lock'
let originalLocksDescriptor: PropertyDescriptor | undefined

function readStorageLock() {
  const raw = localStorage.getItem(REFRESH_LOCK_STORAGE_KEY)
  return raw ? (JSON.parse(raw) as { owner: string; expiresAt: number }) : null
}

beforeEach(() => {
  originalLocksDescriptor = Object.getOwnPropertyDescriptor(
    globalThis.navigator,
    'locks',
  )
  Reflect.deleteProperty(globalThis.navigator, 'locks')
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
  localStorage.removeItem(REFRESH_LOCK_STORAGE_KEY)
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
    expect(request.mock.calls[0][1]).toMatchObject({ mode: 'exclusive' })
    expect(refreshMock.history.post).toHaveLength(0)

    releaseLock?.()

    await expect(pending).resolves.toMatchObject({
      accessToken: 'web-lock-tok',
    })
    expect(refreshMock.history.post).toHaveLength(1)
    expect(refreshMock.history.post[0].withCredentials).toBe(true)
  })

  it('bounds a never-granted Web Lock acquisition', async () => {
    vi.useFakeTimers()
    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable: true,
      value: { request: vi.fn(() => new Promise(() => undefined)) },
    })
    const pending = refreshSession()
    const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(REFRESH_LOCK_DEADLINE_MS)
    await assertion
    expect(refreshMock.history.post).toHaveLength(0)
  })

  it('keeps the single refresh alive when a Web Lock is granted just before its acquisition deadline', async () => {
    vi.useFakeTimers()
    const request = vi.fn((_name: string, _options: unknown, callback: () => Promise<unknown>) => new Promise((resolve, reject) => {
      setTimeout(() => { callback().then(resolve, reject) }, REFRESH_LOCK_DEADLINE_MS - 1)
    }))
    Object.defineProperty(globalThis.navigator, 'locks', { configurable: true, value: { request } })
    let settleRefresh: ((value: [number, object]) => void) | undefined
    refreshMock.onPost('/api/auth/refresh').reply(() => new Promise((resolve) => { settleRefresh = resolve }))
    const first = refreshSession()
    await vi.advanceTimersByTimeAsync(REFRESH_LOCK_DEADLINE_MS)
    const second = refreshSession()
    expect(second).toBe(first)
    expect(refreshMock.history.post).toHaveLength(1)
    settleRefresh?.([200, { accessToken: 'late-grant-tok', tokenType: 'Bearer', expiresInSeconds: 900, user: SAMPLE_USER }])
    await expect(first).resolves.toMatchObject({ accessToken: 'late-grant-tok' })
    expect(refreshMock.history.post).toHaveLength(1)
    expect(useAuthStore.getState().accessToken).toBe('late-grant-tok')
  })

  it('waits on the localStorage lease fallback without storing secrets', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T12:00:00Z'))
    localStorage.setItem(
      REFRESH_LOCK_STORAGE_KEY,
      JSON.stringify({ owner: 'other-tab', expiresAt: Date.now() + 5_000 }),
    )
    refreshMock.onPost('/api/auth/refresh').reply(200, {
      accessToken: 'storage-lock-tok',
      tokenType: 'Bearer',
      expiresInSeconds: 900,
      user: SAMPLE_USER,
    })

    const pending = refreshSession()

    await vi.advanceTimersByTimeAsync(49)
    expect(refreshMock.history.post).toHaveLength(0)
    expect(localStorage.getItem(REFRESH_LOCK_STORAGE_KEY)).not.toContain('tok')

    localStorage.removeItem(REFRESH_LOCK_STORAGE_KEY)
    await vi.advanceTimersByTimeAsync(1)

    await expect(pending).resolves.toMatchObject({
      accessToken: 'storage-lock-tok',
    })
    expect(refreshMock.history.post).toHaveLength(1)
    expect(localStorage.getItem(REFRESH_LOCK_STORAGE_KEY)).toBeNull()
  })

  it('does not bypass an active localStorage lease after a long wait', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T12:00:00Z'))
    localStorage.setItem(
      REFRESH_LOCK_STORAGE_KEY,
      JSON.stringify({ owner: 'other-tab', expiresAt: Date.now() + 30_000 }),
    )
    refreshMock.onPost('/api/auth/refresh').reply(200, {
      accessToken: 'after-wait-tok',
      tokenType: 'Bearer',
      expiresInSeconds: 900,
      user: SAMPLE_USER,
    })

    const pending = refreshSession()

    await vi.advanceTimersByTimeAsync(20_000)
    expect(refreshMock.history.post).toHaveLength(0)

    localStorage.removeItem(REFRESH_LOCK_STORAGE_KEY)
    await vi.advanceTimersByTimeAsync(50)

    await expect(pending).resolves.toMatchObject({
      accessToken: 'after-wait-tok',
    })
    expect(refreshMock.history.post).toHaveLength(1)
  })

  it('bounds a continuously-held localStorage lease', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T12:00:00Z'))
    localStorage.setItem(REFRESH_LOCK_STORAGE_KEY, JSON.stringify({ owner: 'other-tab', expiresAt: Date.now() + REFRESH_LOCK_DEADLINE_MS + 10_000 }))
    const pending = refreshSession()
    const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' })
    await vi.advanceTimersByTimeAsync(REFRESH_LOCK_DEADLINE_MS)
    await assertion
    expect(refreshMock.history.post).toHaveLength(0)
  })

  it('renews the localStorage lease while a slow refresh is pending', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T12:00:00Z'))
    refreshMock.onPost('/api/auth/refresh').reply(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve([
              200,
              {
                accessToken: 'slow-refresh-tok',
                tokenType: 'Bearer',
                expiresInSeconds: 900,
                user: SAMPLE_USER,
              },
            ])
          }, 12_000)
        }),
    )

    const pending = refreshSession()
    const initialLock = readStorageLock()
    expect(initialLock).not.toBeNull()
    expect(localStorage.getItem(REFRESH_LOCK_STORAGE_KEY)).not.toContain('tok')

    await vi.advanceTimersByTimeAsync(5_000)
    const renewedLock = readStorageLock()
    expect(renewedLock?.owner).toBe(initialLock?.owner)
    expect(renewedLock?.expiresAt).toBeGreaterThan(
      initialLock?.expiresAt ?? 0,
    )

    await vi.advanceTimersByTimeAsync(7_000)

    await expect(pending).resolves.toMatchObject({
      accessToken: 'slow-refresh-tok',
    })
    expect(localStorage.getItem(REFRESH_LOCK_STORAGE_KEY)).toBeNull()
  })
})
