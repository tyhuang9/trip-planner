import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useState, type ReactNode } from 'react'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { AxiosError, AxiosHeaders } from 'axios'
import { EmailVerificationPage } from './EmailVerificationPage'
import { verifyEmail } from '../api/auth'
import { useAuthStore } from '../auth/authStore'
import type { AuthResponse } from '../types/auth'
import { putDeepLinkHandoff, __resetDeepLinkVaultForTests } from '../deep-links/vault'
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
