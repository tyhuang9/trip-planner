import { describe, expect, it, vi, beforeEach } from 'vitest'
import { StrictMode, useState, type ReactNode } from 'react'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import { AxiosError, AxiosHeaders } from 'axios'
import { EmailVerificationPage } from './EmailVerificationPage'
import { verifyEmail } from '../api/auth'
import { useAuthStore } from '../auth/authStore'
import type { AuthResponse } from '../types/auth'
import { getDeepLinkHandoff, putDeepLinkHandoff, __resetDeepLinkVaultForTests, wasDeepLinkRecentlyConsumed } from '../deep-links/vault'
import { DeepLinkRouteFocus } from '../deep-links/DeepLinkRouteFocus'
import { __resetDeepLinkRouteFocusForTests } from '../deep-links/routeFocusRequest'
import { AuthContext, type AuthContextValue } from '../auth/authContextValue'

vi.mock('../api/auth', () => ({
  verifyEmail: vi.fn(),
}))

vi.mock('../api/trips', async () => {
  const actual = await vi.importActual<typeof import('../api/trips')>('../api/trips')
  return {
    ...actual,
    listTrips: vi.fn(async () => []),
  }
})

const verifyEmailMock = vi.mocked(verifyEmail)

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, reject, resolve }
}

function makeAuth(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    authStatus: 'unauthenticated',
    user: null,
    isAuthenticated: false,
    isInitializing: false,
    retryAuthResolution: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    updateProfile: vi.fn(),
    changePassword: vi.fn(),
    requestPasswordReset: vi.fn(),
    resendEmailVerification: vi.fn(),
    logout: vi.fn(),
    deleteAccount: vi.fn(),
    ...overrides,
  } as AuthContextValue
}

function renderEmailVerification(path: string, auth = makeAuth()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={[path]}>
          <DeepLinkRouteFocus />
          <Routes>
            <Route path="/verify-email" element={<EmailVerificationPage />} />
            <Route path="/login" element={<div>Sign in page</div>} />
            <Route path="/trips" element={<main id="main" data-testid="trips-page"><h1>Trips page</h1></main>} />
            <Route path="/share/:token" element={<div data-testid="share-page">Share page</div>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  )
}

const AUTH_RESPONSE: AuthResponse = {
  accessToken: 'verified-access-token',
  tokenType: 'Bearer',
  expiresInSeconds: 900,
  user: {
    id: 7,
    email: 'verified@example.com',
    displayName: 'Verified User',
    emailVerified: true,
  },
}

function authResponse(email: string, accessToken: string): AuthResponse {
  return {
    ...AUTH_RESPONSE,
    accessToken,
    user: { ...AUTH_RESPONSE.user, email },
  }
}

function makeAxiosError(status: number, data: unknown): AxiosError {
  return new AxiosError('err', String(status), undefined, {}, {
    status,
    data,
    statusText: '',
    headers: new AxiosHeaders(),
    config: { headers: new AxiosHeaders() },
  })
}

beforeEach(() => {
  verifyEmailMock.mockReset()
  useAuthStore.getState().clearSession()
  __resetDeepLinkVaultForTests()
  __resetDeepLinkRouteFocusForTests()
})

describe('<EmailVerificationPage>', () => {
  it('requires explicit logout before replacing an authenticated session', async () => {
    const order: string[] = []
    let resolveLogout!: () => void
    verifyEmailMock.mockImplementation(async () => {
      order.push('verify')
      return AUTH_RESPONSE
    })
    useAuthStore.getState().setSession({
      accessToken: 'existing-token',
      expiresInSeconds: 900,
      user: { ...AUTH_RESPONSE.user, email: 'existing@example.com' },
    })
    const handoffId = putDeepLinkHandoff({
      kind: 'verify-email',
      token: 'switch-token',
      returnTo: { kind: 'route', path: '/trips' },
    })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    function AuthHarness({ children }: { children: ReactNode }) {
      const [authenticated, setAuthenticated] = useState(true)
      return (
        <AuthContext.Provider value={makeAuth({
          authStatus: authenticated ? 'authenticated' : 'unauthenticated',
          isAuthenticated: authenticated,
          user: authenticated ? { ...AUTH_RESPONSE.user, email: 'existing@example.com' } : null,
          logout: () => {
            order.push('logout')
            useAuthStore.getState().clearSession()
            setAuthenticated(false)
            return new Promise<void>((resolve) => { resolveLogout = resolve })
          },
        })}>
          {children}
        </AuthContext.Provider>
      )
    }
    render(
      <QueryClientProvider client={queryClient}>
        <AuthHarness>
          <MemoryRouter initialEntries={[`/verify/${handoffId}`]}>
            <Routes><Route path="/verify/:handoffId" element={<EmailVerificationPage />} /><Route path="/trips" element={<div>Trips</div>} /></Routes>
          </MemoryRouter>
        </AuthHarness>
      </QueryClientProvider>,
    )

    expect(verifyEmailMock).not.toHaveBeenCalled()
    expect(useAuthStore.getState().user?.email).toBe('existing@example.com')
    expect(screen.getByRole('alert')).toHaveTextContent(/may belong to a different account/i)
    await userEvent.click(screen.getByRole('button', { name: /sign out and verify this email/i }))
    expect(screen.getByRole('button', { name: /signing out/i })).toBeDisabled()
    expect(verifyEmailMock).not.toHaveBeenCalled()
    await act(async () => resolveLogout())
    await vi.waitFor(() => expect(verifyEmailMock).toHaveBeenCalledWith({ token: 'switch-token' }))
    expect(order).toEqual(['logout', 'verify'])
    expect(useAuthStore.getState().user?.email).toBe('verified@example.com')
  })

  it('keeps the authenticated session and releases the handoff when requested', async () => {
    const logout = vi.fn()
    useAuthStore.getState().setSession({
      accessToken: 'existing-token',
      expiresInSeconds: 900,
      user: { ...AUTH_RESPONSE.user, email: 'existing@example.com' },
    })
    const link = {
      kind: 'verify-email' as const,
      token: 'ignored-switch-token',
      returnTo: { kind: 'route' as const, path: '/trips' },
    }
    const handoffId = putDeepLinkHandoff(link)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={makeAuth({
          authStatus: 'authenticated',
          isAuthenticated: true,
          user: { ...AUTH_RESPONSE.user, email: 'existing@example.com' },
          logout,
        })}>
          <MemoryRouter initialEntries={[`/verify/${handoffId}`]}>
            <DeepLinkRouteFocus />
            <Routes>
              <Route path="/verify/:handoffId" element={<EmailVerificationPage />} />
              <Route path="/trips" element={<main id="main"><h1>Trips</h1></main>} />
            </Routes>
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>,
    )

    expect(screen.queryByRole('link', { name: /back to sign in/i })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /keep current session/i }))
    expect(verifyEmailMock).not.toHaveBeenCalled()
    expect(logout).not.toHaveBeenCalled()
    expect(useAuthStore.getState().user?.email).toBe('existing@example.com')
    expect(getDeepLinkHandoff(handoffId)).toBeUndefined()
    expect(wasDeepLinkRecentlyConsumed(link)).toBe(true)
    await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'Trips' })).toHaveFocus())
  })

  it('verifies the token from the verify-email URL', async () => {
    verifyEmailMock.mockResolvedValue(AUTH_RESPONSE)

    renderEmailVerification(
      '/verify-email?token=0nh2PQj6NG-Kwqc-gx8mfbKs3KuEd8OjBVu_q29qSAs',
    )

    expect(verifyEmailMock).toHaveBeenCalledWith({
      token: '0nh2PQj6NG-Kwqc-gx8mfbKs3KuEd8OjBVu_q29qSAs',
    })
    expect(await screen.findByTestId('trips-page')).toBeInTheDocument()
    expect(useAuthStore.getState().user?.email).toBe('verified@example.com')
  })

  it('does not re-submit a consumed token when a session appears during verification', async () => {
    const verification = deferred<AuthResponse>()
    const logout = vi.fn()
    verifyEmailMock.mockReturnValue(verification.promise)

    function AuthRaceHarness({ children }: { children: ReactNode }) {
      const [authenticated, setAuthenticated] = useState(false)
      logout.mockImplementation(async () => {
        useAuthStore.getState().clearSession()
        setAuthenticated(false)
      })
      return (
        <>
          <button
            type="button"
            onClick={() => {
              useAuthStore.getState().setSession({
                accessToken: 'existing-token',
                expiresInSeconds: 900,
                user: { ...AUTH_RESPONSE.user, email: 'existing@example.com' },
              })
              setAuthenticated(true)
            }}
          >
            Establish another session
          </button>
          <AuthContext.Provider value={makeAuth({
            authStatus: authenticated ? 'authenticated' : 'unauthenticated',
            isAuthenticated: authenticated,
            user: authenticated ? { ...AUTH_RESPONSE.user, email: 'existing@example.com' } : null,
            logout,
          })}>
            {children}
          </AuthContext.Provider>
        </>
      )
    }

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <AuthRaceHarness>
          <MemoryRouter initialEntries={['/verify-email?token=single-use-token']}>
            <Routes>
              <Route path="/verify-email" element={<EmailVerificationPage />} />
              <Route path="/login" element={<div>Sign in page</div>} />
            </Routes>
          </MemoryRouter>
        </AuthRaceHarness>
      </QueryClientProvider>,
    )

    await vi.waitFor(() => expect(verifyEmailMock).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByRole('button', { name: /establish another session/i }))
    await act(async () => verification.resolve(AUTH_RESPONSE))

    expect(useAuthStore.getState().user?.email).toBe('existing@example.com')
    expect(screen.getByRole('heading', { name: /email verified/i })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/current signed-in session was not changed/i)
    await userEvent.click(screen.getByRole('button', { name: /sign out and sign in with the verified account/i }))
    expect(await screen.findByText('Sign in page')).toBeInTheDocument()
    expect(logout).toHaveBeenCalledTimes(1)
    expect(verifyEmailMock).toHaveBeenCalledTimes(1)
  })

  it('lets only token B update auth and navigate after the URL switches from token A', async () => {
    const verificationA = deferred<AuthResponse>()
    const verificationB = deferred<AuthResponse>()
    verifyEmailMock.mockImplementation(({ token }) => (
      token === 'token-a' ? verificationA.promise : verificationB.promise
    ))

    function NavigationHarness() {
      const navigate = useNavigate()
      const location = useLocation()
      return (
        <>
          <button
            type="button"
            onClick={() => navigate('/verify-email?token=token-b&return=%2Fdestination-b')}
          >
            Switch to token B
          </button>
          <div data-testid="location">{location.pathname}{location.search}</div>
        </>
      )
    }

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={makeAuth()}>
          <MemoryRouter initialEntries={['/verify-email?token=token-a&return=%2Fdestination-a']}>
            <NavigationHarness />
            <Routes>
              <Route path="/verify-email" element={<EmailVerificationPage />} />
              <Route path="/destination-a" element={<div>Destination A</div>} />
              <Route path="/destination-b" element={<div>Destination B</div>} />
            </Routes>
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>,
    )

    await vi.waitFor(() => expect(verifyEmailMock).toHaveBeenCalledWith({ token: 'token-a' }))
    await userEvent.click(screen.getByRole('button', { name: /switch to token b/i }))
    await vi.waitFor(() => expect(verifyEmailMock).toHaveBeenCalledWith({ token: 'token-b' }))

    await act(async () => verificationA.resolve(authResponse('token-a@example.com', 'token-a-access')))
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/verify-email\?token=token-b/)
    expect(screen.getByRole('status')).toHaveTextContent(/verifying your email/i)
    expect(useAuthStore.getState().user).toBeNull()

    await act(async () => verificationB.resolve(authResponse('token-b@example.com', 'token-b-access')))
    expect(await screen.findByText('Destination B')).toBeInTheDocument()
    expect(screen.queryByText('Destination A')).not.toBeInTheDocument()
    expect(useAuthStore.getState().user?.email).toBe('token-b@example.com')
  })

  it('ignores token A rejection after the URL switches to token B', async () => {
    const verificationA = deferred<AuthResponse>()
    const verificationB = deferred<AuthResponse>()
    verifyEmailMock.mockImplementation(({ token }) => (
      token === 'token-a' ? verificationA.promise : verificationB.promise
    ))

    function NavigationHarness() {
      const navigate = useNavigate()
      return (
        <button type="button" onClick={() => navigate('/verify-email?token=token-b')}>
          Switch to token B
        </button>
      )
    }

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={makeAuth()}>
          <MemoryRouter initialEntries={['/verify-email?token=token-a']}>
            <NavigationHarness />
            <Routes><Route path="/verify-email" element={<EmailVerificationPage />} /></Routes>
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>,
    )

    await vi.waitFor(() => expect(verifyEmailMock).toHaveBeenCalledWith({ token: 'token-a' }))
    await userEvent.click(screen.getByRole('button', { name: /switch to token b/i }))
    await vi.waitFor(() => expect(verifyEmailMock).toHaveBeenCalledWith({ token: 'token-b' }))
    await act(async () => verificationA.reject(makeAxiosError(400, { error: 'invalid_verification_token' })))

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(/verifying your email/i)
    expect(useAuthStore.getState().user).toBeNull()
  })

  it('ignores verification completion after the page unmounts', async () => {
    const verification = deferred<AuthResponse>()
    verifyEmailMock.mockReturnValue(verification.promise)

    function UnmountHarness() {
      const [showVerification, setShowVerification] = useState(true)
      const location = useLocation()
      return (
        <>
          <button type="button" onClick={() => setShowVerification(false)}>
            Close verification
          </button>
          <div data-testid="location">{location.pathname}{location.search}</div>
          {showVerification ? <EmailVerificationPage /> : <div>Verification closed</div>}
        </>
      )
    }

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={makeAuth()}>
          <MemoryRouter initialEntries={['/verify-email?token=unmounted-token']}>
            <UnmountHarness />
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>,
    )

    await vi.waitFor(() => expect(verifyEmailMock).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByRole('button', { name: /close verification/i }))
    await act(async () => verification.resolve(AUTH_RESPONSE))

    expect(screen.getByText('Verification closed')).toBeInTheDocument()
    expect(screen.getByTestId('location')).toHaveTextContent(/^\/verify-email\?token=unmounted-token$/)
    expect(useAuthStore.getState().user).toBeNull()
  })

  it('submits each verification token only once under StrictMode effect replay', async () => {
    const verification = deferred<AuthResponse>()
    verifyEmailMock.mockReturnValue(verification.promise)
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

    render(
      <StrictMode>
        <QueryClientProvider client={queryClient}>
          <AuthContext.Provider value={makeAuth()}>
            <MemoryRouter initialEntries={['/verify-email?token=strict-token']}>
              <Routes>
                <Route path="/verify-email" element={<EmailVerificationPage />} />
                <Route path="/trips" element={<div>Trips after verification</div>} />
              </Routes>
            </MemoryRouter>
          </AuthContext.Provider>
        </QueryClientProvider>
      </StrictMode>,
    )

    await vi.waitFor(() => expect(verifyEmailMock).toHaveBeenCalledTimes(1))
    await act(async () => verification.resolve(AUTH_RESPONSE))
    expect(await screen.findByText('Trips after verification')).toBeInTheDocument()
    expect(verifyEmailMock).toHaveBeenCalledTimes(1)
  })

  it('redirects to a safe return path after verification', async () => {
    verifyEmailMock.mockResolvedValue(AUTH_RESPONSE)

    renderEmailVerification('/verify-email?token=token&return=%2Fshare%2Fraw-token')

    expect(await screen.findByTestId('share-page')).toBeInTheDocument()
  })

  it('continues a verified invite through opaque handoffs only', async () => {
    verifyEmailMock.mockResolvedValue(AUTH_RESPONSE)
    const handoffId = putDeepLinkHandoff({
      kind: 'verify-email',
      token: 'verify-secret',
      returnTo: { kind: 'share', token: 'invite-secret' },
    })
    function LocationProbe() {
      const location = useLocation()
      return <div data-testid="location">{location.pathname}{location.search}</div>
    }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={makeAuth()}>
          <MemoryRouter initialEntries={[`/verify/${handoffId}`]}>
            <LocationProbe />
            <DeepLinkRouteFocus />
            <Routes>
              <Route path="/verify/:handoffId" element={<EmailVerificationPage />} />
              <Route path="/link/:handoffId" element={<main id="main"><h1>Accept invite</h1></main>} />
            </Routes>
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>,
    )

    const location = screen.getByTestId('location')
    await vi.waitFor(() => expect(location).toHaveTextContent(/^\/link\/dl_[a-f0-9]{32}$/))
    expect(location).not.toHaveTextContent(/verify-secret|invite-secret/)
    await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'Accept invite' })).toHaveFocus())
  })

  it('does not call the verify API when the token is missing', () => {
    renderEmailVerification('/verify-email')

    expect(verifyEmailMock).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toHaveTextContent(
      /verification link is invalid or expired/i,
    )
    expect(screen.getByRole('link', { name: /back to sign in/i })).toBeInTheDocument()
  })

  it('lets an authenticated user return to trips from an invalid link', async () => {
    useAuthStore.getState().setSession({
      accessToken: 'existing-token',
      expiresInSeconds: 900,
      user: { ...AUTH_RESPONSE.user, email: 'existing@example.com' },
    })
    renderEmailVerification('/verify-email', makeAuth({
      authStatus: 'authenticated',
      isAuthenticated: true,
      user: { ...AUTH_RESPONSE.user, email: 'existing@example.com' },
    }))

    expect(verifyEmailMock).not.toHaveBeenCalled()
    expect(screen.queryByRole('link', { name: /back to sign in/i })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /return to trips/i }))
    expect(useAuthStore.getState().user?.email).toBe('existing@example.com')
    await vi.waitFor(() => expect(screen.getByRole('heading', { name: 'Trips page' })).toHaveFocus())
  })

  it('shows the invalid-link message when the token is rejected', async () => {
    verifyEmailMock.mockRejectedValue(
      makeAxiosError(400, { error: 'invalid_verification_token' }),
    )

    renderEmailVerification('/verify-email?token=expired-token')

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /verification link is invalid or expired/i,
    )
  })
})
