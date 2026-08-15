import { StrictMode } from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '../auth/authContextValue'
import { LaunchRoute } from './LaunchRoute'

const bootstrapGuestSessionMock = vi.hoisted(() => vi.fn())

vi.mock('../api/guestSession', () => ({
  bootstrapGuestSession: bootstrapGuestSessionMock,
}))

function authValue(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
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
  }
}

function renderLaunch(
  auth: AuthContextValue = authValue(),
  { strict = false }: { strict?: boolean } = {},
) {
  const tree = (
    <AuthContext.Provider value={auth}>
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route path="/" element={<LaunchRoute />} />
          <Route path="/login" element={<div>LOGIN DESTINATION</div>} />
          <Route path="/trips" element={<div>MEMBER TRIPS</div>} />
          <Route path="/trips/:publicId" element={<div>GUEST TRIP</div>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>
  )
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree)
}

describe('<LaunchRoute>', () => {
  beforeEach(() => {
    bootstrapGuestSessionMock.mockReset()
  })

  it('waits for member bootstrap before probing the guest session', () => {
    renderLaunch(authValue({ isInitializing: true }))

    expect(screen.getByRole('heading', { name: /preparing your trip planner/i })).toBeInTheDocument()
    expect(bootstrapGuestSessionMock).not.toHaveBeenCalled()
  })

  it('sends an authenticated member to their trips without a guest probe', () => {
    renderLaunch(
      authValue({
        isAuthenticated: true,
        user: { id: 1, email: 'member@example.com', displayName: 'Member', emailVerified: true },
      }),
    )

    expect(screen.getByText('MEMBER TRIPS')).toBeInTheDocument()
    expect(bootstrapGuestSessionMock).not.toHaveBeenCalled()
  })

  it('restores a valid guest trip once under StrictMode without writing storage', async () => {
    const storageWrite = vi.spyOn(window.localStorage, 'setItem')
    bootstrapGuestSessionMock.mockResolvedValue({
      publicId: 'abc23def45gh',
      role: 'VIEWER',
      displayName: 'Guest',
    })

    renderLaunch(authValue(), { strict: true })

    expect(await screen.findByText('GUEST TRIP')).toBeInTheDocument()
    expect(bootstrapGuestSessionMock).toHaveBeenCalledTimes(1)
    expect(storageWrite).not.toHaveBeenCalled()
    storageWrite.mockRestore()
  })

  it('sends an absent or inactive guest credential to login', async () => {
    bootstrapGuestSessionMock.mockResolvedValue(null)
    renderLaunch()

    expect(await screen.findByText('LOGIN DESTINATION')).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /reopen your trip invite/i })).not.toBeInTheDocument()
    expect(bootstrapGuestSessionMock).toHaveBeenCalledTimes(1)

    await new Promise((resolve) => window.setTimeout(resolve, 0))
    expect(bootstrapGuestSessionMock).toHaveBeenCalledTimes(1)
  })

  it('keeps network failure distinct and retries only when requested', async () => {
    bootstrapGuestSessionMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({
        publicId: 'abc23def45gh',
        role: 'EDITOR',
        displayName: 'Guest',
      })
    renderLaunch()

    expect(await screen.findByRole('alert')).toHaveTextContent(/check your connection/i)
    expect(bootstrapGuestSessionMock).toHaveBeenCalledTimes(1)

    fireEvent.click(screen.getByRole('button', { name: /try again/i }))

    expect(await screen.findByText('GUEST TRIP')).toBeInTheDocument()
    await waitFor(() => expect(bootstrapGuestSessionMock).toHaveBeenCalledTimes(2))
  })
})
