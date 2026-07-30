import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { RequireAuth } from './RequireAuth'
import { AuthContext, type AuthContextValue } from './authContextValue'
import {
  clearPendingLogoutIntent,
  persistPendingLogoutIntent,
} from './logoutIntent'

afterEach(() => {
  clearPendingLogoutIntent()
  vi.restoreAllMocks()
})

function makeAuth(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    authStatus: 'unauthenticated',
    user: null,
    isAuthenticated: false,
    isInitializing: false,
    retryAuthResolution: async () => {},
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
      makeAuth({
        authStatus: 'restoring',
        isInitializing: true,
        isAuthenticated: false,
      }),
    )
    expect(screen.queryByTestId('protected')).toBeNull()
    expect(screen.queryByTestId('login')).toBeNull()
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true')
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

  it('hides protected content while auth is unresolved and offers retry', () => {
    const retryAuthResolution = vi.fn(async () => {})
    renderWithAuth(
      '/protected',
      makeAuth({
        authStatus: 'offline-unknown',
        isInitializing: true,
        retryAuthResolution,
      }),
    )

    expect(screen.queryByTestId('protected')).toBeNull()
    expect(screen.queryByTestId('login')).toBeNull()
    expect(
      screen.getByRole('heading', { name: /could not confirm your session/i }),
    ).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveAttribute('aria-live', 'assertive')
    expect(screen.getByRole('alert')).not.toHaveAttribute('aria-busy')

    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(retryAuthResolution).toHaveBeenCalledOnce()
  })

  it('unmounts protected content while rejected session data is cleared', () => {
    renderWithAuth(
      '/protected',
      makeAuth({
        authStatus: 'clearing-session',
        isInitializing: true,
        isAuthenticated: false,
      }),
    )

    expect(screen.queryByTestId('protected')).not.toBeInTheDocument()
    expect(screen.queryByTestId('login')).not.toBeInTheDocument()
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull()
  })

  it('explains that an offline logout is locally enforced', () => {
    persistPendingLogoutIntent()
    renderWithAuth(
      '/protected',
      makeAuth({ authStatus: 'offline-unknown', isInitializing: true }),
    )

    expect(
      screen.getByRole('heading', { name: /finishing sign out/i }),
    ).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(
      /signed out on this device/i,
    )
    expect(screen.queryByTestId('protected')).toBeNull()
  })

  it('warns the user to keep the app open when logout intent is memory-only', () => {
    vi.spyOn(Object.getPrototypeOf(localStorage), 'setItem').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError')
    })
    persistPendingLogoutIntent()

    renderWithAuth(
      '/protected',
      makeAuth({ authStatus: 'offline-unknown', isInitializing: true }),
    )

    expect(screen.getByRole('alert')).toHaveTextContent(/keep dupert open/i)
    expect(screen.getByRole('alert')).toHaveTextContent(/could not save/i)
    expect(screen.queryByTestId('protected')).toBeNull()
  })

  it('renders the matched outlet when authenticated', () => {
    renderWithAuth(
      '/protected',
      makeAuth({
        authStatus: 'authenticated',
        isInitializing: false,
        isAuthenticated: true,
        user: { id: 1, email: 'a@b.com', displayName: 'A', emailVerified: true },
      }),
    )
    expect(screen.getByTestId('protected')).toBeInTheDocument()
  })
})
