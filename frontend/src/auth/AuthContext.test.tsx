import { StrictMode, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  act,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
} from '@testing-library/react'
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from '@tanstack/react-query'
import MockAdapter from 'axios-mock-adapter'
import axios from 'axios'
import { AuthProvider } from './AuthContext'
import { useAuth } from './useAuth'
import { useAuthStore } from './authStore'
import {
  __resetRefreshSingletonForTests,
  apiClient,
  refreshSession,
} from '../api/client'
import {
  clearPendingLogoutIntent,
  hasPendingLogoutIntent,
  PENDING_LOGOUT_STORAGE_KEY,
  persistPendingLogoutIntent,
} from './logoutIntent'

const SAMPLE_USER = {
  id: 11,
  email: 'm@n.com',
  displayName: 'M',
  emailVerified: true,
}

let refreshMock: MockAdapter
let apiMock: MockAdapter
let queryClient: QueryClient

function render(ui: ReactElement) {
  return rtlRender(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  )
}

function Probe() {
  const { authStatus, isInitializing, isAuthenticated, logout, user } = useAuth()
  return (
    <div>
      <span data-testid="status">{authStatus}</span>
      <span data-testid="initializing">{String(isInitializing)}</span>
      <span data-testid="authenticated">{String(isAuthenticated)}</span>
      <span data-testid="email">{user?.email ?? 'none'}</span>
      <button type="button" onClick={() => void logout()}>
        Log out
      </button>
    </div>
  )
}

function GuestQueryProbe({ queryFn }: { queryFn: () => Promise<string> }) {
  const { authStatus } = useAuth()
  const query = useQuery({
    queryKey: ['guest', 'bootstrap'],
    queryFn,
    enabled: authStatus === 'unauthenticated',
  })
  return <span data-testid="guest-query">{query.data ?? 'none'}</span>
}

function PrivateWorkspaceProbe() {
  const query = useQuery({
    queryKey: ['trips', 'detail', 'private-trip'],
    queryFn: async () => 'private-refetched',
  })
  return <span>{String(query.data ?? 'private-loading')}</span>
}

function GuestWorkspaceProbe({ queryFn }: { queryFn: () => Promise<string> }) {
  const query = useQuery({
    queryKey: ['guest', 'workspace'],
    queryFn,
  })
  return <span data-testid="guest-workspace">{query.data ?? 'guest-loading'}</span>
}

function SessionBoundaryProbe({
  guestQuery,
}: {
  guestQuery: () => Promise<string>
}) {
  const { authStatus, isInitializing } = useAuth()
  if (isInitializing) return <span data-testid="session-boundary">Clearing</span>
  if (authStatus === 'unauthenticated') {
    return <GuestWorkspaceProbe queryFn={guestQuery} />
  }
  return <PrivateWorkspaceProbe />
}

beforeEach(() => {
  clearPendingLogoutIntent()
  __resetRefreshSingletonForTests()
  useAuthStore.getState().clearSession('restoring')
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  // The provider's silent-refresh path goes through `refreshSession()`,
  // which uses a fresh axios instance instead of the shared `apiClient` so it
  // bypasses the response interceptor. Mount the mock on the same global axios,
  // the same approach `client.test.ts` takes for the interceptor's refresh.
  refreshMock = new MockAdapter(axios)
  apiMock = new MockAdapter(apiClient)
})

afterEach(() => {
  refreshMock.restore()
  apiMock.restore()
  clearPendingLogoutIntent()
  vi.useRealTimers()
})

describe('<AuthProvider> silent refresh on mount', () => {
  it('populates the session when the refresh cookie is valid', async () => {
    refreshMock.onPost('/api/auth/refresh').reply(200, {
      accessToken: 'fresh-tok',
      tokenType: 'Bearer',
      expiresInSeconds: 900,
      user: SAMPLE_USER,
    })

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )

    // Starts initializing.
    expect(screen.getByTestId('initializing').textContent).toBe('true')

    await waitFor(() => {
      expect(screen.getByTestId('initializing').textContent).toBe('false')
    })

    expect(screen.getByTestId('authenticated').textContent).toBe('true')
    expect(screen.getByTestId('email').textContent).toBe('m@n.com')
    expect(refreshMock.history.post).toHaveLength(1)
  })

  it('settles as logged-out when the refresh probe fails', async () => {
    refreshMock.onPost('/api/auth/refresh').reply(401, { error: 'unauthenticated' })

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('initializing').textContent).toBe('false')
    })

    expect(screen.getByTestId('authenticated').textContent).toBe('false')
    expect(screen.getByTestId('status').textContent).toBe('unauthenticated')
    expect(screen.getByTestId('email').textContent).toBe('none')
    expect(useAuthStore.getState().accessToken).toBeNull()
  })

  it('does not discard a guest query started after unauthenticated resolution', async () => {
    const guestQuery = vi.fn(async () => 'guest-ready')
    refreshMock.onPost('/api/auth/refresh').reply(401, { error: 'unauthenticated' })

    render(
      <AuthProvider>
        <Probe />
        <GuestQueryProbe queryFn={guestQuery} />
      </AuthProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('guest-query')).toHaveTextContent('guest-ready')
    })
    expect(guestQuery).toHaveBeenCalledOnce()
    expect(queryClient.getQueryData(['guest', 'bootstrap'])).toBe('guest-ready')
  })

  it('unmounts private workspace data before guest access resumes after refresh rejection', async () => {
    useAuthStore.getState().setSession({
      accessToken: 'member-token',
      expiresInSeconds: 900,
      user: SAMPLE_USER,
    })
    queryClient.setQueryData(
      ['trips', 'detail', 'private-trip'],
      'private-cached',
    )
    refreshMock.onPost('/api/auth/refresh').reply(401, { error: 'unauthenticated' })
    const guestQuery = vi.fn(async () => {
      expect(screen.queryByText('private-cached')).not.toBeInTheDocument()
      return 'guest-ready'
    })

    render(
      <AuthProvider>
        <button
          type="button"
          onClick={() => void refreshSession().catch(() => undefined)}
        >
          Refresh session
        </button>
        <SessionBoundaryProbe guestQuery={guestQuery} />
      </AuthProvider>,
    )

    expect(screen.getByText('private-cached')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh session' }))

    await waitFor(() => {
      expect(screen.getByTestId('guest-workspace')).toHaveTextContent(
        'guest-ready',
      )
    })
    expect(screen.queryByText('private-cached')).not.toBeInTheDocument()
    expect(
      queryClient.getQueryData(['trips', 'detail', 'private-trip']),
    ).toBeUndefined()
    expect(guestQuery).toHaveBeenCalledOnce()
  })

  it('keeps auth unresolved when the refresh probe cannot reach the server', async () => {
    queryClient.setQueryData(['trips', 'detail', 'private-trip'], {
      name: 'Private cached trip',
    })
    queryClient.setQueryData(['activities', 'private-trip'], [
      { id: 1, title: 'Private cached activity' },
    ])
    refreshMock.onPost('/api/auth/refresh').networkError()

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('offline-unknown')
    })

    expect(screen.getByTestId('initializing').textContent).toBe('true')
    expect(screen.getByTestId('authenticated').textContent).toBe('false')
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
  })

  it('keeps auth unresolved when the refresh server fails', async () => {
    refreshMock.onPost('/api/auth/refresh').reply(503, { error: 'unavailable' })

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('offline-unknown')
    })
  })

  it('keeps auth unresolved when the refresh request times out', async () => {
    refreshMock.onPost('/api/auth/refresh').timeout()

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('offline-unknown')
    })
  })

  it('only fires a single refresh probe per mount (StrictMode safe)', async () => {
    refreshMock.onPost('/api/auth/refresh').reply(200, {
      accessToken: 'fresh-tok',
      tokenType: 'Bearer',
      expiresInSeconds: 900,
      user: SAMPLE_USER,
    })

    // Wrap in <StrictMode> so React actually double-invokes effects in
    // dev — without this the assertion is vacuous (probedRef alone would
    // hold even with a single invocation).
    render(
      <StrictMode>
        <AuthProvider>
          <Probe />
        </AuthProvider>
      </StrictMode>,
    )

    await waitFor(() => {
      expect(screen.getByTestId('initializing').textContent).toBe('false')
    })

    expect(refreshMock.history.post).toHaveLength(1)
  })

  it('refreshes proactively before the access token expires', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T12:00:00Z'))
    useAuthStore.getState().setSession({
      accessToken: 'soon-expiring-tok',
      expiresInSeconds: 90,
      user: SAMPLE_USER,
    })
    refreshMock.onPost('/api/auth/refresh').reply(200, {
      accessToken: 'proactive-tok',
      tokenType: 'Bearer',
      expiresInSeconds: 900,
      user: SAMPLE_USER,
    })

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )

    expect(screen.getByTestId('initializing').textContent).toBe('false')
    expect(refreshMock.history.post).toHaveLength(0)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999)
    })
    expect(refreshMock.history.post).toHaveLength(0)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })

    expect(refreshMock.history.post).toHaveLength(1)
    expect(useAuthStore.getState().accessToken).toBe('proactive-tok')
  })

  it('checks refresh on focus after browser sleep skips the timer window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-05T12:00:00Z'))
    useAuthStore.getState().setSession({
      accessToken: 'sleepy-tok',
      expiresInSeconds: 120,
      user: SAMPLE_USER,
    })
    refreshMock.onPost('/api/auth/refresh').reply(200, {
      accessToken: 'focus-refresh-tok',
      tokenType: 'Bearer',
      expiresInSeconds: 900,
      user: SAMPLE_USER,
    })

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )

    expect(refreshMock.history.post).toHaveLength(0)
    vi.setSystemTime(Date.now() + 70_000)

    await act(async () => {
      window.dispatchEvent(new Event('focus'))
      await Promise.resolve()
    })

    expect(refreshMock.history.post).toHaveLength(1)
    expect(useAuthStore.getState().accessToken).toBe('focus-refresh-tok')
  })

  it('keeps an offline logout durable and blocks local restoration', async () => {
    useAuthStore.getState().setSession({
      accessToken: 'member-token',
      expiresInSeconds: 900,
      user: SAMPLE_USER,
    })
    queryClient.setQueryData(['trips', 'detail', 'private-trip'], {
      name: 'Private cached trip',
    })
    queryClient.setQueryData(['activities', 'private-trip'], [
      { id: 1, title: 'Private cached activity' },
    ])
    apiMock.onPost('/auth/logout').networkError()

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }))

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('offline-unknown')
    })
    expect(hasPendingLogoutIntent()).toBe(true)
    expect(localStorage.getItem(PENDING_LOGOUT_STORAGE_KEY)).not.toContain(
      'member-token',
    )
    expect(useAuthStore.getState().accessToken).toBeNull()
    expect(useAuthStore.getState().user).toBeNull()
    expect(queryClient.getQueryCache().getAll()).toHaveLength(0)
  })

  it('retries a pending logout on launch without probing refresh', async () => {
    persistPendingLogoutIntent()
    apiMock.onPost('/auth/logout').networkError()

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )

    await waitFor(() => expect(apiMock.history.post).toHaveLength(1))
    expect(refreshMock.history.post).toHaveLength(0)
    expect(screen.getByTestId('status').textContent).toBe('offline-unknown')
    expect(hasPendingLogoutIntent()).toBe(true)
  })

  it('clears a pending logout after reconnect confirms revocation', async () => {
    persistPendingLogoutIntent()
    apiMock.onPost('/auth/logout').networkErrorOnce()
    apiMock.onPost('/auth/logout').reply(204)

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )

    await waitFor(() => expect(apiMock.history.post).toHaveLength(1))
    window.dispatchEvent(new Event('online'))

    await waitFor(() => {
      expect(hasPendingLogoutIntent()).toBe(false)
      expect(screen.getByTestId('status').textContent).toBe('unauthenticated')
    })
    expect(apiMock.history.post).toHaveLength(2)
  })

  it('clears a pending logout when the server confirms no valid session', async () => {
    persistPendingLogoutIntent()
    apiMock.onPost('/auth/logout').reply(401, { error: 'unauthenticated' })

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )

    await waitFor(() => {
      expect(hasPendingLogoutIntent()).toBe(false)
      expect(screen.getByTestId('status').textContent).toBe('unauthenticated')
    })
    expect(refreshMock.history.post).toHaveLength(0)
  })

  it('accepts a pending logout cleared by another browser context', async () => {
    persistPendingLogoutIntent()
    apiMock.onPost('/auth/logout').networkError()

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => expect(apiMock.history.post).toHaveLength(1))

    act(() => {
      localStorage.removeItem(PENDING_LOGOUT_STORAGE_KEY)
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: PENDING_LOGOUT_STORAGE_KEY,
          newValue: null,
        }),
      )
    })

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('unauthenticated')
    })
  })

  it('does not let a stale refresh restore auth after logout starts', async () => {
    let resolveRefresh:
      | ((value: [number, Record<string, unknown>]) => void)
      | undefined
    refreshMock.onPost('/api/auth/refresh').reply(
      () =>
        new Promise((resolve) => {
          resolveRefresh = resolve
        }),
    )
    apiMock.onPost('/auth/logout').reply(204)

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => expect(refreshMock.history.post).toHaveLength(1))
    fireEvent.click(screen.getByRole('button', { name: 'Log out' }))

    await act(async () => {
      resolveRefresh?.([
        200,
        {
          accessToken: 'stale-restored-token',
          tokenType: 'Bearer',
          expiresInSeconds: 900,
          user: SAMPLE_USER,
        },
      ])
    })

    await waitFor(() => {
      expect(screen.getByTestId('status').textContent).toBe('unauthenticated')
    })
    expect(useAuthStore.getState().accessToken).toBeNull()
    expect(hasPendingLogoutIntent()).toBe(false)
    expect(apiMock.history.post).toHaveLength(1)
  })
})
