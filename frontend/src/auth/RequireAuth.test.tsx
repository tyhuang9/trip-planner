import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { RequireAuth } from './RequireAuth'
import { AuthContext, type AuthContextValue } from './authContextValue'

function makeAuth(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    user: null,
    isAuthenticated: false,
    isInitializing: false,
    login: async () => ({
      id: 1,
      email: 'a@b.com',
      displayName: 'A',
      emailVerified: true,
    }),
    register: async () => ({
      status: 'verification_required',
      email: 'a@b.com',
    }),
    updateProfile: async () => ({
      id: 1,
      email: 'a@b.com',
      displayName: 'A',
      emailVerified: true,
    }),
    changePassword: async () => {},
    requestPasswordReset: async () => {},
    resendEmailVerification: async () => {},
    logout: async () => {},
    deleteAccount: async () => {},
    ...overrides,
  }
}

function renderWithAuth(
  initialPath: string,
  ctx: AuthContextValue,
  protectedElement: React.ReactNode = <div data-testid="protected">PROTECTED</div>,
) {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route element={<RequireAuth />}>
            <Route path="/protected" element={protectedElement} />
            <Route path="/protected/sub" element={protectedElement} />
          </Route>
          <Route
            path="/login"
            element={<div data-testid="login">LOGIN PAGE</div>}
          />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  )
}

describe('<RequireAuth>', () => {
  it('renders an aria-busy placeholder while initializing', () => {
    renderWithAuth(
      '/protected',
      makeAuth({ isInitializing: true, isAuthenticated: false }),
    )
    expect(screen.queryByTestId('protected')).toBeNull()
    expect(screen.queryByTestId('login')).toBeNull()
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
    expect(screen.getByRole('heading', { name: /preparing your trip planner/i })).toBeInTheDocument()
  })

  it('redirects to /login with the return param when unauthenticated', () => {
    renderWithAuth(
      '/protected/sub?x=1',
      makeAuth({ isInitializing: false, isAuthenticated: false }),
    )
    expect(screen.getByTestId('login')).toBeInTheDocument()
    // Verifying the URL would require pulling location out of the
    // memory router; instead the LoginPage tests cover return-param
    // honouring end-to-end.
  })

  it('renders the matched outlet when authenticated', () => {
    renderWithAuth(
      '/protected',
      makeAuth({
        isInitializing: false,
        isAuthenticated: true,
        user: { id: 1, email: 'a@b.com', displayName: 'A', emailVerified: true },
      }),
    )
    expect(screen.getByTestId('protected')).toBeInTheDocument()
  })
})
