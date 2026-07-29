import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { AuthContext, type AuthContextValue } from '../auth/authContextValue'
import AcceptInvitePage from './AcceptInvitePage'

const shareMocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
}))

vi.mock('../hooks/useShareLinks', () => ({
  useAcceptShareLink: () => ({
    mutateAsync: shareMocks.mutateAsync,
    isPending: false,
    error: null,
  }),
}))

function makeAuth(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    user: null,
    isAuthenticated: false,
    isInitializing: false,
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

function renderInvite(ctx: AuthContextValue) {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={['/share/raw-token']}>
        <Routes>
          <Route path="/share/:token" element={<AcceptInvitePage />} />
          <Route
            path="/trips/:publicId"
            element={<div data-testid="shared-trip">Shared trip</div>}
          />
          <Route path="/login" element={<div>Login</div>} />
          <Route path="/register" element={<div>Register</div>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  )
}

beforeEach(() => {
  shareMocks.mutateAsync.mockReset()
})

describe('<AcceptInvitePage>', () => {
  it('auto-accepts the invite for an authenticated user', async () => {
    shareMocks.mutateAsync.mockResolvedValue({
      publicId: 'abc234def567',
      role: 'EDITOR',
    })

    renderInvite(makeAuth({ isAuthenticated: true }))

    await waitFor(() => {
      expect(shareMocks.mutateAsync).toHaveBeenCalledWith('raw-token')
    })
    expect(await screen.findByTestId('shared-trip')).toBeInTheDocument()
  })

  it('preserves the share path in login and register links', () => {
    renderInvite(makeAuth())

    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute(
      'href',
      '/login?return=%2Fshare%2Fraw-token',
    )
    expect(screen.getByRole('link', { name: /create account/i })).toHaveAttribute(
      'href',
      '/register?return=%2Fshare%2Fraw-token',
    )
  })
})
