import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { AxiosError, AxiosHeaders } from 'axios'
import { LoginPage } from './LoginPage'
import { AuthContext, type AuthContextValue } from '../auth/authContextValue'
import { useAuthStore } from '../auth/authStore'

vi.mock('../api/trips', async () => {
  const actual = await vi.importActual<typeof import('../api/trips')>('../api/trips')
  return {
    ...actual,
    listTrips: vi.fn(async () => []),
  }
})

function makeAuth(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    authStatus: 'unauthenticated',
    user: null,
    isAuthenticated: false,
    isInitializing: false,
    retryAuthResolution: vi.fn(async () => {}),
    login: vi.fn(async () => ({
      id: 1,
      email: 'a@b.com',
      displayName: 'A',
      emailVerified: true,
    })),
    register: vi.fn(async () => ({
      status: 'verification_required' as const,
      email: 'a@b.com',
    })),
    updateProfile: vi.fn(async () => ({
      id: 1,
      email: 'a@b.com',
      displayName: 'A',
      emailVerified: true,
    })),
    changePassword: vi.fn(async () => {}),
    requestPasswordReset: vi.fn(async () => {}),
    resendEmailVerification: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    deleteAccount: vi.fn(async () => {}),
    ...overrides,
  }
}

function renderLogin(
  ctx: AuthContextValue,
  initialPath = '/login',
  postLoginElement: React.ReactNode = (
    <div data-testid="post-login">POST LOGIN</div>
  ),
) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={ctx}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/trips" element={postLoginElement} />
            <Route
              path="/trips/abc"
              element={<div data-testid="trip-deep">TRIP DEEP</div>}
            />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  )
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
  useAuthStore.getState().clearSession()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('<LoginPage>', () => {
  it('opens the password reset request state from a recovery link', () => {
    renderLogin(makeAuth(), '/login?mode=password-reset')
    expect(screen.getByRole('heading', { name: 'Reset password' })).toBeInTheDocument()
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument()
    expect(document.title).toBe('Request password reset – Dupert')
  })

  it('keeps explicit password-reset mode available to an authenticated user', () => {
    useAuthStore.getState().setSession({
      accessToken: 'existing-token',
      expiresInSeconds: 900,
      user: { id: 1, email: 'signed-in@example.com', displayName: 'Signed In', emailVerified: true },
    })
    renderLogin(makeAuth({ isAuthenticated: true, authStatus: 'authenticated' }), '/login?mode=password-reset')
    expect(screen.getByRole('heading', { name: 'Reset password' })).toBeInTheDocument()
    expect(screen.queryByTestId('post-login')).not.toBeInTheDocument()
    expect(document.title).toBe('Request password reset – Dupert')
  })
  it('shows a page shell while auth restoration is pending', () => {
    renderLogin(makeAuth({ isInitializing: true }))
    expect(screen.getByRole('heading', { name: /preparing your trip planner/i })).toBeInTheDocument()
  })

  it('renders the email and password fields with proper labels', () => {
    renderLogin(makeAuth())
    expect(screen.getByLabelText('Email')).toBeInTheDocument()
    expect(screen.getByLabelText('Email')).not.toHaveFocus()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /dev reset password/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /update password/i })).not.toBeInTheDocument()
  })

  it('calls auth.login on submit and navigates to /trips by default', async () => {
    const ctx = makeAuth()
    renderLogin(ctx)

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Email'), 'me@example.com')
    await user.type(screen.getByLabelText('Password'), 'super-secret-1')
    await user.click(screen.getByRole('button', { name: /sign in/i }))

    expect(ctx.login).toHaveBeenCalledWith({
      email: 'me@example.com',
      password: 'super-secret-1',
    })
    await waitFor(() => {
      expect(screen.getByTestId('post-login')).toBeInTheDocument()
    })
  })

  it('honors the return query param after a successful login', async () => {
    const ctx = makeAuth()
    renderLogin(
      ctx,
      `/login?return=${encodeURIComponent('/trips/abc')}`,
    )

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Email'), 'me@example.com')
    await user.type(screen.getByLabelText('Password'), 'super-secret-1')
    await user.click(screen.getByRole('button', { name: /sign in/i }))

    await waitFor(() => {
      expect(screen.getByTestId('trip-deep')).toBeInTheDocument()
    })
  })

  it('shows the invalid_credentials banner with role="alert" on a 401', async () => {
    const ctx = makeAuth({
      login: vi.fn(async () => {
        throw makeAxiosError(401, { error: 'invalid_credentials' })
      }),
    })
    renderLogin(ctx)

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Email'), 'me@example.com')
    await user.type(screen.getByLabelText('Password'), 'wrong-password-12')
    await user.click(screen.getByRole('button', { name: /sign in/i }))

    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent(/email or password is incorrect/i)
  })

  it('shows the email_unverified banner and can resend verification', async () => {
    const ctx = makeAuth({
      login: vi.fn(async () => {
        throw makeAxiosError(403, { error: 'email_unverified' })
      }),
      resendEmailVerification: vi.fn(async () => {}),
    })
    renderLogin(ctx, `/login?return=${encodeURIComponent('/share/raw-token')}`)

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Email'), 'me@example.com')
    await user.type(screen.getByLabelText('Password'), 'super-secret-1')
    await user.click(screen.getByRole('button', { name: /sign in/i }))

    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent(/verify your account before signing in/i)
    await user.click(
      screen.getByRole('button', { name: /resend verification email/i }),
    )

    expect(ctx.resendEmailVerification).toHaveBeenCalledWith({
      email: 'me@example.com',
      returnPath: '/share/raw-token',
    })
    expect(await screen.findByRole('status')).toHaveTextContent(
      /verification email is on the way/i,
    )
  })

  it('shows resend verification rate limits from an unverified login state', async () => {
    const ctx = makeAuth({
      login: vi.fn(async () => {
        throw makeAxiosError(403, { error: 'email_unverified' })
      }),
      resendEmailVerification: vi.fn(async () => {
        throw makeAxiosError(429, { error: 'rate_limited' })
      }),
    })
    renderLogin(ctx)

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Email'), 'me@example.com')
    await user.type(screen.getByLabelText('Password'), 'super-secret-1')
    await user.click(screen.getByRole('button', { name: /sign in/i }))
    await screen.findByRole('button', { name: /resend verification email/i })

    await user.click(
      screen.getByRole('button', { name: /resend verification email/i }),
    )

    const alerts = await screen.findAllByRole('alert')
    expect(alerts.at(-1)).toHaveTextContent(/too many attempts/i)
  })

  it('shows rate limits when password reset requests are throttled', async () => {
    const ctx = makeAuth({
      requestPasswordReset: vi.fn(async () => {
        throw makeAxiosError(429, { error: 'rate_limited' })
      }),
    })
    renderLogin(ctx)

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /forgot password/i }))
    await user.type(screen.getByLabelText('Email'), 'me@example.com')
    await user.click(screen.getByRole('button', { name: /send reset email/i }))

    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent(/too many attempts/i)
  })

  it('renders per-field errors from a 400 validation response', async () => {
    const ctx = makeAuth({
      login: vi.fn(async () => {
        throw makeAxiosError(400, {
          error: 'validation_failed',
          fieldErrors: [
            { field: 'email', message: 'must be a well-formed email address' },
          ],
        })
      }),
    })
    renderLogin(ctx)

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Email'), 'me')
    await user.type(screen.getByLabelText('Password'), 'whatever-12345')
    await user.click(screen.getByRole('button', { name: /sign in/i }))

    expect(
      await screen.findByText(/well-formed email address/i),
    ).toBeInTheDocument()
    const emailInput = screen.getByLabelText('Email')
    expect(emailInput.getAttribute('aria-invalid')).toBe('true')
  })

  it('redirects already-logged-in users immediately', () => {
    useAuthStore.getState().setSession({
      accessToken: 'live-tok',
      expiresInSeconds: 900,
      user: { id: 1, email: 'a@b.com', displayName: 'A', emailVerified: true },
    })
    renderLogin(
      makeAuth({
        isAuthenticated: true,
        user: {
          id: 1,
          email: 'a@b.com',
          displayName: 'A',
          emailVerified: true,
        },
      }),
    )
    expect(screen.getByTestId('post-login')).toBeInTheDocument()
  })

  it('switches forgot password to a reset-only view seeded with the sign-in email', async () => {
    const ctx = makeAuth()
    renderLogin(ctx)

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Email'), 'me@example.com')
    await user.click(screen.getByRole('button', { name: /forgot password/i }))

    expect(
      screen.getByRole('heading', { name: /reset password/i }),
    ).toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^sign in$/i })).not.toBeInTheDocument()
    expect(screen.getByLabelText('Email')).toHaveValue('me@example.com')

    await user.click(screen.getByRole('button', { name: /back to sign in/i }))
    expect(screen.getByRole('heading', { name: /sign in/i })).toBeInTheDocument()
    expect(screen.getByLabelText('Password')).toBeInTheDocument()
  })

  it('returns to sign in by pointer without submitting preserved credentials', async () => {
    const ctx = makeAuth()
    renderLogin(ctx)

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Email'), 'me@example.com')
    await user.type(screen.getByLabelText('Password'), 'super-secret-1')
    await user.click(screen.getByRole('button', { name: /forgot password/i }))

    const resetForm = screen.getByLabelText('Email').closest('form')
    const backButton = screen.getByRole('button', { name: /back to sign in/i })
    await user.click(backButton)

    const signInEmail = screen.getByLabelText('Email')
    const signInForm = signInEmail.closest('form')
    const signInButton = screen.getByRole('button', { name: /^sign in$/i })
    expect(ctx.login).not.toHaveBeenCalled()
    expect(signInEmail).toHaveValue('me@example.com')
    expect(screen.getByLabelText('Password')).toHaveValue('super-secret-1')
    expect(signInEmail).toHaveFocus()
    expect(signInForm).not.toBe(resetForm)
    expect(signInButton).not.toBe(backButton)

    await user.click(signInButton)
    expect(ctx.login).toHaveBeenCalledOnce()
  })

  it('returns to sign in by Enter without submitting preserved credentials', async () => {
    const ctx = makeAuth()
    renderLogin(ctx)

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Email'), 'me@example.com')
    await user.type(screen.getByLabelText('Password'), 'super-secret-1')
    await user.click(screen.getByRole('button', { name: /forgot password/i }))

    const backButton = screen.getByRole('button', { name: /back to sign in/i })
    backButton.focus()
    await user.keyboard('{Enter}')

    expect(ctx.login).not.toHaveBeenCalled()
    expect(screen.getByLabelText('Email')).toHaveValue('me@example.com')
    expect(screen.getByLabelText('Password')).toHaveValue('super-secret-1')
    expect(screen.getByLabelText('Email')).toHaveFocus()
  })

  it('submits a password reset request with Enter', async () => {
    const ctx = makeAuth()
    renderLogin(ctx)

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /forgot password/i }))
    await user.type(screen.getByLabelText('Email'), 'me@example.com')
    await user.keyboard('{Enter}')

    expect(ctx.requestPasswordReset).toHaveBeenCalledWith({
      email: 'me@example.com',
    })
    expect(await screen.findByRole('status')).toHaveTextContent(
      /reset email is on the way/i,
    )
  })

  it('submits valid sign-in credentials with Enter', async () => {
    const ctx = makeAuth()
    renderLogin(ctx)

    const user = userEvent.setup()
    await user.type(screen.getByLabelText('Email'), 'me@example.com')
    await user.type(screen.getByLabelText('Password'), 'super-secret-1')
    await user.keyboard('{Enter}')

    expect(ctx.login).toHaveBeenCalledWith({
      email: 'me@example.com',
      password: 'super-secret-1',
    })
  })
})
