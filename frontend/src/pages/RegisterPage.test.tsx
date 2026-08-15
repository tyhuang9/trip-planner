import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { AxiosError, AxiosHeaders } from 'axios'
import { RegisterPage } from './RegisterPage'
import { AuthContext, type AuthContextValue } from '../auth/authContextValue'
import { useAuthStore } from '../auth/authStore'
import styles from './AuthForm.module.css'

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

function renderRegister(ctx: AuthContextValue, initialPath = '/register') {
  return render(
    <AuthContext.Provider value={ctx}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/register" element={<RegisterPage />} />
          <Route
            path="/trips"
            element={<div data-testid="post-register">POST REGISTER</div>}
          />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
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

describe('<RegisterPage>', () => {
  it('shows a page shell while auth restoration is pending', () => {
    renderRegister(makeAuth({ isInitializing: true }))
    expect(screen.getByRole('heading', { name: /preparing your trip planner/i })).toBeInTheDocument()
  })

  it('renders the email, password, and display name fields', () => {
    renderRegister(makeAuth())
    expect(screen.getByLabelText(/email/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^password$/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/display name/i)).toBeInTheDocument()
  })

  it('shows a length error when the password is too short on submit', async () => {
    const ctx = makeAuth()
    renderRegister(ctx)

    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/email/i), 'me@example.com')
    await user.type(screen.getByLabelText(/^password$/i), 'short1')
    await user.type(screen.getByLabelText(/display name/i), 'Me')
    await user.click(screen.getByRole('button', { name: /create account/i }))

    expect(
      await screen.findByText(/password must be at least 12 characters/i),
    ).toBeInTheDocument()
    expect(ctx.register).not.toHaveBeenCalled()
  })

  it('flags a password without a digit', async () => {
    const ctx = makeAuth()
    renderRegister(ctx)

    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/email/i), 'me@example.com')
    await user.type(
      screen.getByLabelText(/^password$/i),
      'no-digits-here-just-letters',
    )
    await user.type(screen.getByLabelText(/display name/i), 'Me')
    await user.click(screen.getByRole('button', { name: /create account/i }))

    expect(
      await screen.findByText(/password must include a letter and a digit/i),
    ).toBeInTheDocument()
    expect(ctx.register).not.toHaveBeenCalled()
  })

  it('flags a password without a letter', async () => {
    const ctx = makeAuth()
    renderRegister(ctx)

    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/email/i), 'me@example.com')
    await user.type(screen.getByLabelText(/^password$/i), '123456789012345')
    await user.type(screen.getByLabelText(/display name/i), 'Me')
    await user.click(screen.getByRole('button', { name: /create account/i }))

    expect(
      await screen.findByText(/password must include a letter and a digit/i),
    ).toBeInTheDocument()
    expect(ctx.register).not.toHaveBeenCalled()
  })

  it('submits a valid form and shows the check-email state', async () => {
    const ctx = makeAuth({
      register: vi.fn(async () => ({
        status: 'verification_required' as const,
        email: 'me@example.com',
      })),
    })
    renderRegister(ctx)

    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/email/i), 'me@example.com')
    await user.type(screen.getByLabelText(/^password$/i), 'super-secret-1234')
    await user.type(screen.getByLabelText(/display name/i), 'Me')
    await user.click(screen.getByRole('button', { name: /create account/i }))

    expect(ctx.register).toHaveBeenCalledWith({
      email: 'me@example.com',
      password: 'super-secret-1234',
      displayName: 'Me',
      returnPath: undefined,
    })
    expect(
      await screen.findByRole('heading', { name: /check your email/i }),
    ).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(
      /verification link to me@example.com/i,
    )
    expect(screen.queryByTestId('post-register')).not.toBeInTheDocument()
  })

  it('uses Creating account as the only pending submit label', async () => {
    let finishRegistration:
      | ((result: { status: 'verification_required'; email: string }) => void)
      | undefined
    const registerMock = vi.fn(
      () =>
        new Promise<{ status: 'verification_required'; email: string }>((resolve) => {
          finishRegistration = resolve
        }),
    )
    const ctx = makeAuth({ register: registerMock })
    renderRegister(ctx)

    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/email/i), 'me@example.com')
    await user.type(screen.getByLabelText(/^password$/i), 'super-secret-1234')
    await user.type(screen.getByLabelText(/display name/i), 'Me')
    await user.click(screen.getByRole('button', { name: /create account/i }))

    const button = screen.getByRole('button', { name: /creating account/i })
    expect(button).toHaveTextContent(/^Creating account\.\.\.$/)
    expect(button).not.toHaveTextContent(/loading/i)

    finishRegistration?.({
      status: 'verification_required',
      email: 'me@example.com',
    })
    expect(
      await screen.findByRole('heading', { name: /check your email/i }),
    ).toBeInTheDocument()
  })

  it('can resend verification from the check-email state', async () => {
    const ctx = makeAuth({
      register: vi.fn(async () => ({
        status: 'verification_required' as const,
        email: 'me@example.com',
      })),
      resendEmailVerification: vi.fn(async () => {}),
    })
    renderRegister(ctx)

    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/email/i), 'me@example.com')
    await user.type(screen.getByLabelText(/^password$/i), 'super-secret-1234')
    await user.type(screen.getByLabelText(/display name/i), 'Me')
    await user.click(screen.getByRole('button', { name: /create account/i }))
    await screen.findByRole('heading', { name: /check your email/i })

    await user.click(
      screen.getByRole('button', { name: /resend verification email/i }),
    )

    expect(ctx.resendEmailVerification).toHaveBeenCalledWith({
      email: 'me@example.com',
      returnPath: undefined,
    })
    expect(await screen.findAllByRole('status')).toHaveLength(2)
    const resendNotice = screen.getByText(/verification email is on the way/i)
    expect(resendNotice).toBeInTheDocument()
    expect(resendNotice).toHaveClass(styles.centeredNotice)
  })

  it('passes the safe return path to register and resend verification', async () => {
    const ctx = makeAuth({
      register: vi.fn(async () => ({
        status: 'verification_required' as const,
        email: 'me@example.com',
      })),
      resendEmailVerification: vi.fn(async () => {}),
    })
    renderRegister(ctx, `/register?return=${encodeURIComponent('/share/raw-token')}`)

    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/email/i), 'me@example.com')
    await user.type(screen.getByLabelText(/^password$/i), 'super-secret-1234')
    await user.type(screen.getByLabelText(/display name/i), 'Me')
    await user.click(screen.getByRole('button', { name: /create account/i }))
    await screen.findByRole('heading', { name: /check your email/i })

    expect(ctx.register).toHaveBeenCalledWith({
      email: 'me@example.com',
      password: 'super-secret-1234',
      displayName: 'Me',
      returnPath: '/share/raw-token',
    })

    await user.click(
      screen.getByRole('button', { name: /resend verification email/i }),
    )

    expect(ctx.resendEmailVerification).toHaveBeenCalledWith({
      email: 'me@example.com',
      returnPath: '/share/raw-token',
    })
  })

  it('shows a field error on email when the server returns email_taken', async () => {
    const ctx = makeAuth({
      register: vi.fn(async () => {
        throw makeAxiosError(409, { error: 'email_taken' })
      }),
    })
    renderRegister(ctx)

    const user = userEvent.setup()
    await user.type(screen.getByLabelText(/email/i), 'me@example.com')
    await user.type(screen.getByLabelText(/^password$/i), 'super-secret-1234')
    await user.type(screen.getByLabelText(/display name/i), 'Me')
    await user.click(screen.getByRole('button', { name: /create account/i }))

    expect(
      await screen.findByText(/account with this email already exists/i),
    ).toBeInTheDocument()
  })

  it('caps display name input at 50 characters via maxLength', () => {
    renderRegister(makeAuth())
    const input = screen.getByLabelText(/display name/i) as HTMLInputElement
    expect(input.maxLength).toBe(50)
  })
})
