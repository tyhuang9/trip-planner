import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { AxiosError, AxiosHeaders } from 'axios'
import { EmailVerificationPage } from './EmailVerificationPage'
import { verifyEmail } from '../api/auth'
import { useAuthStore } from '../auth/authStore'
import type { AuthResponse } from '../types/auth'
import { putDeepLinkHandoff, __resetDeepLinkVaultForTests } from '../deep-links/vault'

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

function renderEmailVerification(path: string) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/verify-email" element={<EmailVerificationPage />} />
          <Route path="/login" element={<div>Sign in page</div>} />
          <Route path="/trips" element={<div data-testid="trips-page">Trips page</div>} />
          <Route path="/share/:token" element={<div data-testid="share-page">Share page</div>} />
        </Routes>
      </MemoryRouter>
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
})

describe('<EmailVerificationPage>', () => {
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
        <MemoryRouter initialEntries={[`/link/${handoffId}`]}>
          <LocationProbe />
          <Routes>
            <Route path="/link/:handoffId" element={<EmailVerificationPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    const location = await screen.findByTestId('location')
    expect(location).toHaveTextContent(/^\/link\/dl_[a-f0-9]{32}$/)
    expect(location).not.toHaveTextContent(/verify-secret|invite-secret/)
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
