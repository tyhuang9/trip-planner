import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router'
import {
  getDeepLinkHandoff,
  putDeepLinkHandoff,
  __resetDeepLinkVaultForTests,
} from '../deep-links/vault'
import PasswordResetPage from './PasswordResetPage'

const authMocks = vi.hoisted(() => ({
  confirmPasswordReset: vi.fn(),
}))

vi.mock('../api/auth', () => ({
  confirmPasswordReset: authMocks.confirmPasswordReset,
}))

function renderResetPage(path: string, nextPath?: string, finalPath?: string) {
  function LocationProbe() {
    const location = useLocation()
    return <div data-testid="current-search">{location.search}</div>
  }

  function RouteChangeButton() {
    const navigate = useNavigate()
    return (
      <>
        {nextPath && <button type="button" onClick={() => navigate(nextPath)}>Open next reset link</button>}
        {finalPath && <button type="button" onClick={() => navigate(finalPath)}>Open final reset link</button>}
      </>
    )
  }

  return render(
    <MemoryRouter initialEntries={[path]}>
      <RouteChangeButton />
      <Routes>
        <Route
          path="/reset-password"
          element={(
            <>
              <LocationProbe />
              <PasswordResetPage />
            </>
          )}
        />
        <Route path="/link/:handoffId" element={<PasswordResetPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

function deferredRequest() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  authMocks.confirmPasswordReset.mockReset()
  __resetDeepLinkVaultForTests()
})

describe('<PasswordResetPage>', () => {
  it('hides the reset token field, strips token from the URL, and submits the captured token', async () => {
    authMocks.confirmPasswordReset.mockResolvedValue(undefined)

    renderResetPage('/reset-password?token=secret-reset-token&next=ignored')

    expect(screen.queryByLabelText(/reset code/i)).not.toBeInTheDocument()
    expect(screen.getByRole('main')).not.toHaveTextContent('secret-reset-token')
    expect(screen.getByRole('heading', { name: 'Reset password' })).not.toHaveFocus()
    expect(screen.getByRole('status', { name: /password reset status/i })).toBeEmptyDOMElement()
    await waitFor(() => {
      expect(screen.getByTestId('current-search')).toHaveTextContent('?next=ignored')
    })

    await userEvent.type(screen.getByLabelText(/new password/i), 'new-password-123')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'new-password-123')
    await userEvent.click(screen.getByRole('button', { name: /reset password/i }))

    await waitFor(() => {
      expect(authMocks.confirmPasswordReset).toHaveBeenCalledWith({
        token: 'secret-reset-token',
        password: 'new-password-123',
      })
    })
    expect(await screen.findByText(/password reset complete/i)).toBeInTheDocument()
  })

  it('accepts code query params without rendering the code', async () => {
    authMocks.confirmPasswordReset.mockResolvedValue(undefined)

    renderResetPage('/reset-password?code=email-code-token')

    expect(screen.queryByLabelText(/reset code/i)).not.toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('current-search')).toHaveTextContent('')
    })

    await userEvent.type(screen.getByLabelText(/new password/i), 'new-password-123')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'new-password-123')
    await userEvent.click(screen.getByRole('button', { name: /reset password/i }))

    await waitFor(() => {
      expect(authMocks.confirmPasswordReset).toHaveBeenCalledWith({
        token: 'email-code-token',
        password: 'new-password-123',
      })
    })
  })

  it('blocks submission when the reset link has no token', async () => {
    renderResetPage('/reset-password')

    expect(screen.getByRole('alert')).toHaveTextContent(/missing or invalid/i)
    expect(screen.queryByRole('button', { name: /reset password/i })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /request a new password reset link/i })).toHaveAttribute('href', '/login?mode=password-reset')
    expect(authMocks.confirmPasswordReset).not.toHaveBeenCalled()
  })

  it('associates a password mismatch error with both password fields', async () => {
    renderResetPage('/reset-password?token=secret-reset-token')
    const password = screen.getByLabelText(/new password/i)
    const confirmation = screen.getByLabelText(/confirm password/i)
    await userEvent.type(password, 'new-password-123')
    await userEvent.type(confirmation, 'different-password-456')
    await userEvent.click(screen.getByRole('button', { name: /reset password/i }))

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('New passwords do not match.')
    expect(password).toHaveAttribute('aria-invalid', 'true')
    expect(confirmation).toHaveAttribute('aria-invalid', 'true')
    const passwordDescriptions = password.getAttribute('aria-describedby')?.split(' ')
    expect(passwordDescriptions).toContain(alert.id)
    expect(passwordDescriptions).toContain(screen.getByText('At least 12 characters with a letter and a digit.').id)
    expect(confirmation).toHaveAttribute('aria-describedby', alert.id)
  })

  it('resets direct-link state, focuses and announces the page, and submits only the newly captured code', async () => {
    authMocks.confirmPasswordReset.mockResolvedValue(undefined)
    renderResetPage(
      '/reset-password?token=first-reset-token',
      '/reset-password?code=second-reset-token',
    )
    await waitFor(() => expect(screen.getByTestId('current-search')).toHaveTextContent(''))

    await userEvent.type(screen.getByLabelText(/new password/i), 'first-password-123')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'mismatched-password-456')
    await userEvent.click(screen.getByRole('button', { name: /reset password/i }))
    expect(screen.getByRole('alert')).toHaveTextContent('New passwords do not match.')

    await userEvent.click(screen.getByRole('button', { name: /open next reset link/i }))
    await waitFor(() => expect(screen.getByTestId('current-search')).toHaveTextContent(''))
    expect(screen.getByRole('heading', { name: 'Reset password' })).toHaveFocus()
    await waitFor(() => {
      expect(screen.getByRole('status', { name: /password reset status/i })).toHaveTextContent(
        'A new password reset link was opened. Enter your new password.',
      )
    })
    expect(screen.getByLabelText(/new password/i)).toHaveValue('')
    expect(screen.getByLabelText(/confirm password/i)).toHaveValue('')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await userEvent.type(screen.getByLabelText(/new password/i), 'second-password-123')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'second-password-123')
    await userEvent.click(screen.getByRole('button', { name: /reset password/i }))
    await screen.findByText(/password reset complete/i)

    expect(authMocks.confirmPasswordReset).toHaveBeenCalledTimes(1)
    expect(authMocks.confirmPasswordReset).toHaveBeenCalledWith({
      token: 'second-reset-token',
      password: 'second-password-123',
    })
  })

  it('uses only the invalid-link alert when a warm reset owner has no token', async () => {
    renderResetPage('/reset-password?token=valid-reset-token', '/reset-password')
    await waitFor(() => expect(screen.getByTestId('current-search')).toHaveTextContent(''))

    await userEvent.click(screen.getByRole('button', { name: /open next reset link/i }))

    expect(screen.getByRole('alert')).toHaveTextContent(/missing or invalid/i)
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(screen.getByRole('heading', { name: 'Reset password' })).toHaveFocus()
    expect(screen.getByRole('status', { name: /password reset status/i })).toBeEmptyDOMElement()
    expect(screen.queryByRole('form')).not.toBeInTheDocument()
  })

  it('moves focus to the submit button before an Enter submission disables the fields', async () => {
    const request = deferredRequest()
    authMocks.confirmPasswordReset.mockReturnValue(request.promise)
    renderResetPage('/reset-password?token=keyboard-reset-token')
    await waitFor(() => expect(screen.getByTestId('current-search')).toHaveTextContent(''))

    await userEvent.type(screen.getByLabelText(/new password/i), 'keyboard-password-123')
    const confirmation = screen.getByLabelText(/confirm password/i)
    await userEvent.type(confirmation, 'keyboard-password-123')
    expect(confirmation).toHaveFocus()
    await userEvent.keyboard('{Enter}')

    const submitButton = screen.getByRole('button', { name: 'Resetting...' })
    expect(submitButton).toHaveFocus()
    expect(submitButton).toHaveAttribute('aria-disabled', 'true')
    expect(authMocks.confirmPasswordReset).toHaveBeenCalledTimes(1)
    await act(async () => request.resolve())
  })

  it('ignores obsolete direct-link success and keeps the next token independently submittable', async () => {
    const firstRequest = deferredRequest()
    authMocks.confirmPasswordReset
      .mockReturnValueOnce(firstRequest.promise)
      .mockResolvedValueOnce(undefined)
    renderResetPage(
      '/reset-password?code=first-reset-token',
      '/reset-password?token=second-reset-token',
    )
    await waitFor(() => expect(screen.getByTestId('current-search')).toHaveTextContent(''))

    await userEvent.type(screen.getByLabelText(/new password/i), 'first-password-123')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'first-password-123')
    const submitButton = screen.getByRole('button', { name: /reset password/i })
    await userEvent.click(submitButton)
    expect(submitButton).toHaveFocus()
    expect(submitButton).toBeEnabled()
    expect(submitButton).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(submitButton)
    await userEvent.keyboard('{Enter}')
    expect(authMocks.confirmPasswordReset).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('form')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('status', { name: /password reset status/i })).toHaveTextContent(
      'Resetting password. Please wait.',
    )
    expect(screen.getByRole('status', { name: /password reset status/i })).toHaveClass('sr-only')

    await userEvent.click(screen.getByRole('button', { name: /open next reset link/i }))
    expect(screen.getByRole('form')).toHaveAttribute('aria-busy', 'false')
    await act(async () => firstRequest.resolve())
    expect(screen.queryByText(/password reset complete/i)).not.toBeInTheDocument()

    await userEvent.type(screen.getByLabelText(/new password/i), 'second-password-123')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'second-password-123')
    await userEvent.click(screen.getByRole('button', { name: /reset password/i }))
    await screen.findByText(/password reset complete/i)
    expect(authMocks.confirmPasswordReset).toHaveBeenLastCalledWith({
      token: 'second-reset-token',
      password: 'second-password-123',
    })
  })

  it('ignores obsolete direct-link rejection and keeps the next token independently submittable', async () => {
    const firstRequest = deferredRequest()
    authMocks.confirmPasswordReset
      .mockReturnValueOnce(firstRequest.promise)
      .mockResolvedValueOnce(undefined)
    renderResetPage(
      '/reset-password?token=first-reset-token',
      '/reset-password?code=second-reset-token',
    )
    await waitFor(() => expect(screen.getByTestId('current-search')).toHaveTextContent(''))

    await userEvent.type(screen.getByLabelText(/new password/i), 'first-password-123')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'first-password-123')
    await userEvent.click(screen.getByRole('button', { name: /reset password/i }))
    await userEvent.click(screen.getByRole('button', { name: /open next reset link/i }))
    await act(async () => firstRequest.reject(new Error('First request failed')))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await userEvent.type(screen.getByLabelText(/new password/i), 'second-password-123')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'second-password-123')
    await userEvent.click(screen.getByRole('button', { name: /reset password/i }))
    await screen.findByText(/password reset complete/i)
    expect(authMocks.confirmPasswordReset).toHaveBeenLastCalledWith({
      token: 'second-reset-token',
      password: 'second-password-123',
    })
  })

  it('resets route-owned form state and submits only the current handoff token', async () => {
    authMocks.confirmPasswordReset.mockResolvedValue(undefined)
    const firstHandoffId = putDeepLinkHandoff({ kind: 'reset-password', token: 'first-reset-token' })
    const secondHandoffId = putDeepLinkHandoff({ kind: 'reset-password', token: 'second-reset-token' })
    const thirdHandoffId = putDeepLinkHandoff({ kind: 'reset-password', token: 'third-reset-token' })
    renderResetPage(`/link/${firstHandoffId}`, `/link/${secondHandoffId}`, `/link/${thirdHandoffId}`)

    await userEvent.type(screen.getByLabelText(/new password/i), 'first-password-123')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'mismatched-password-456')
    await userEvent.click(screen.getByRole('button', { name: /reset password/i }))
    expect(screen.getByRole('alert')).toHaveTextContent('New passwords do not match.')

    await userEvent.click(screen.getByRole('button', { name: /open next reset link/i }))
    expect(screen.getByRole('heading', { name: 'Reset password' })).toHaveFocus()
    await waitFor(() => {
      expect(screen.getByRole('status', { name: /password reset status/i })).toHaveTextContent(
        'A new password reset link was opened. Enter your new password.',
      )
    })
    expect(screen.getByLabelText(/new password/i)).toHaveValue('')
    expect(screen.getByLabelText(/confirm password/i)).toHaveValue('')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()

    await userEvent.type(screen.getByLabelText(/new password/i), 'second-password-123')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'second-password-123')
    await userEvent.click(screen.getByRole('button', { name: /reset password/i }))

    await waitFor(() => {
      expect(authMocks.confirmPasswordReset).toHaveBeenCalledWith({
        token: 'second-reset-token',
        password: 'second-password-123',
      })
    })
    expect(authMocks.confirmPasswordReset).not.toHaveBeenCalledWith(expect.objectContaining({
      token: 'first-reset-token',
    }))
    expect(await screen.findByText(/password reset complete/i)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /open final reset link/i }))
    expect(screen.getByLabelText(/new password/i)).toHaveValue('')
    expect(screen.getByLabelText(/confirm password/i)).toHaveValue('')
    expect(screen.queryByText(/password reset complete/i)).not.toBeInTheDocument()
  })

  it('ignores an obsolete successful request and leaves the next handoff independently submittable', async () => {
    const firstRequest = deferredRequest()
    authMocks.confirmPasswordReset
      .mockReturnValueOnce(firstRequest.promise)
      .mockResolvedValueOnce(undefined)
    const firstHandoffId = putDeepLinkHandoff({ kind: 'reset-password', token: 'first-reset-token' })
    const secondHandoffId = putDeepLinkHandoff({ kind: 'reset-password', token: 'second-reset-token' })
    renderResetPage(`/link/${firstHandoffId}`, `/link/${secondHandoffId}`)

    await userEvent.type(screen.getByLabelText(/new password/i), 'first-password-123')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'first-password-123')
    await userEvent.click(screen.getByRole('button', { name: /reset password/i }))
    expect(screen.getByRole('button', { name: 'Resetting...' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Resetting...' })).toHaveAttribute('aria-disabled', 'true')

    await userEvent.click(screen.getByRole('button', { name: /open next reset link/i }))
    expect(screen.getByRole('button', { name: /reset password/i })).toBeEnabled()
    await act(async () => firstRequest.resolve())
    expect(screen.queryByText(/password reset complete/i)).not.toBeInTheDocument()
    expect(getDeepLinkHandoff(firstHandoffId)).toEqual({ kind: 'reset-password', token: 'first-reset-token' })
    expect(getDeepLinkHandoff(secondHandoffId)).toEqual({ kind: 'reset-password', token: 'second-reset-token' })

    await userEvent.type(screen.getByLabelText(/new password/i), 'second-password-123')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'second-password-123')
    await userEvent.click(screen.getByRole('button', { name: /reset password/i }))
    await screen.findByText(/password reset complete/i)
    expect(getDeepLinkHandoff(secondHandoffId)).toBeUndefined()
  })

  it('ignores an obsolete rejected request and leaves the next handoff independently submittable', async () => {
    const firstRequest = deferredRequest()
    authMocks.confirmPasswordReset
      .mockReturnValueOnce(firstRequest.promise)
      .mockResolvedValueOnce(undefined)
    const firstHandoffId = putDeepLinkHandoff({ kind: 'reset-password', token: 'first-reset-token' })
    const secondHandoffId = putDeepLinkHandoff({ kind: 'reset-password', token: 'second-reset-token' })
    renderResetPage(`/link/${firstHandoffId}`, `/link/${secondHandoffId}`)

    await userEvent.type(screen.getByLabelText(/new password/i), 'first-password-123')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'first-password-123')
    await userEvent.click(screen.getByRole('button', { name: /reset password/i }))
    await userEvent.click(screen.getByRole('button', { name: /open next reset link/i }))

    await act(async () => firstRequest.reject(new Error('First request failed')))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(getDeepLinkHandoff(firstHandoffId)).toEqual({ kind: 'reset-password', token: 'first-reset-token' })

    await userEvent.type(screen.getByLabelText(/new password/i), 'second-password-123')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'second-password-123')
    await userEvent.click(screen.getByRole('button', { name: /reset password/i }))
    await screen.findByText(/password reset complete/i)
    expect(getDeepLinkHandoff(secondHandoffId)).toBeUndefined()
  })

  it('keeps the current handoff available after a parsed API error and consumes it after retry', async () => {
    authMocks.confirmPasswordReset
      .mockRejectedValueOnce(Object.assign(new Error('Rate limited'), {
        isAxiosError: true,
        response: { status: 429, data: { error: 'rate_limited' } },
      }))
      .mockResolvedValueOnce(undefined)
    const handoffId = putDeepLinkHandoff({ kind: 'reset-password', token: 'retry-reset-token' })
    renderResetPage(`/link/${handoffId}`)

    await userEvent.type(screen.getByLabelText(/new password/i), 'retry-password-123')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'retry-password-123')
    const submitButton = screen.getByRole('button', { name: /reset password/i })
    await userEvent.click(submitButton)

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many attempts. Try again in a few minutes.',
    )
    expect(screen.getByRole('form')).toHaveAttribute('aria-busy', 'false')
    expect(screen.getByRole('status', { name: /password reset status/i })).toBeEmptyDOMElement()
    expect(submitButton).toBeEnabled()
    expect(submitButton).toHaveAttribute('aria-disabled', 'false')
    expect(getDeepLinkHandoff(handoffId)).toEqual({
      kind: 'reset-password',
      token: 'retry-reset-token',
    })

    await userEvent.click(submitButton)
    expect(await screen.findByText(/password reset complete/i)).toBeInTheDocument()
    expect(authMocks.confirmPasswordReset).toHaveBeenCalledTimes(2)
    expect(getDeepLinkHandoff(handoffId)).toBeUndefined()
  })

  it.each([
    ['password', 'confirmation'],
    ['newPassword', 'confirmPassword'],
    ['newPassword', 'confirm_password'],
  ])('renders parsed %s and %s field errors with accessible associations', async (passwordField, confirmationField) => {
    authMocks.confirmPasswordReset.mockRejectedValueOnce(Object.assign(new Error('Validation failed'), {
      isAxiosError: true,
      response: {
        status: 400,
        data: {
          error: 'validation_failed',
          fieldErrors: [
            { field: passwordField, message: 'Use a stronger password.' },
            { field: confirmationField, message: 'Passwords must match.' },
          ],
        },
      },
    }))
    renderResetPage('/reset-password?token=validation-reset-token')

    const password = screen.getByLabelText(/new password/i)
    const confirmation = screen.getByLabelText(/confirm password/i)
    await userEvent.type(password, 'valid-password-123')
    await userEvent.type(confirmation, 'valid-password-123')
    await userEvent.click(screen.getByRole('button', { name: /reset password/i }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/fix the highlighted fields/i)
    const passwordError = await screen.findByText('Use a stronger password.')
    const confirmationError = await screen.findByText('Passwords must match.')
    expect(password).toHaveAttribute('aria-invalid', 'true')
    expect(confirmation).toHaveAttribute('aria-invalid', 'true')
    expect(password.getAttribute('aria-describedby')?.split(' ')).toContain(passwordError.id)
    expect(confirmation).toHaveAttribute('aria-describedby', confirmationError.id)
    await waitFor(() => expect(password).toHaveFocus())
  })

  it.each([
    ['password', 'confirmation'],
    ['newPassword', 'confirmPassword'],
    ['newPassword', 'confirm_password'],
  ])('clears %s/%s server errors on edit and stale errors on retry', async (passwordField, confirmationField) => {
    authMocks.confirmPasswordReset
      .mockRejectedValueOnce(Object.assign(new Error('Validation failed'), {
        isAxiosError: true,
        response: {
          status: 400,
          data: {
            error: 'validation_failed',
            fieldErrors: [
              { field: passwordField, message: 'Password rejected.' },
              { field: confirmationField, message: 'Confirmation rejected.' },
            ],
          },
        },
      }))
      .mockResolvedValueOnce(undefined)
    renderResetPage('/reset-password?token=retry-field-error-token')

    const password = screen.getByLabelText(/new password/i)
    const confirmation = screen.getByLabelText(/confirm password/i)
    await userEvent.type(password, 'valid-password-123')
    await userEvent.type(confirmation, 'valid-password-123')
    await userEvent.click(screen.getByRole('button', { name: /reset password/i }))
    expect(await screen.findByText('Password rejected.')).toBeInTheDocument()
    expect(screen.getByText('Confirmation rejected.')).toBeInTheDocument()
    expect(screen.getByRole('alert')).toHaveTextContent(/fix the highlighted fields/i)
    expect(password).toHaveFocus()

    await userEvent.type(password, 'x')
    expect(screen.queryByText('Password rejected.')).not.toBeInTheDocument()
    expect(screen.getByText('Confirmation rejected.')).toBeInTheDocument()
    await waitFor(() => expect(password).toHaveFocus())
    expect(screen.getByRole('alert')).toHaveTextContent(/fix the highlighted fields/i)

    await userEvent.type(confirmation, 'x')
    expect(screen.queryByText('Confirmation rejected.')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /reset password/i }))
    await screen.findByText(/password reset complete/i)
    expect(screen.queryByText('Confirmation rejected.')).not.toBeInTheDocument()
    expect(authMocks.confirmPasswordReset).toHaveBeenCalledTimes(2)
  })

  it('keeps the backend password policy as a permanent hint without rejecting locally', async () => {
    authMocks.confirmPasswordReset.mockRejectedValueOnce(Object.assign(new Error('Validation failed'), {
      isAxiosError: true,
      response: {
        status: 400,
        data: {
          error: 'validation_failed',
          fieldErrors: [
            { field: 'password', message: 'Password must be at least 12 characters.' },
          ],
        },
      },
    }))
    renderResetPage('/reset-password?token=policy-hint-token')

    expect(screen.getByText('At least 12 characters with a letter and a digit.')).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText(/new password/i), 'a1')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'a1')
    await userEvent.click(screen.getByRole('button', { name: /reset password/i }))

    expect(await screen.findByText('Password must be at least 12 characters.')).toBeInTheDocument()
    expect(authMocks.confirmPasswordReset).toHaveBeenCalledWith({
      token: 'policy-hint-token',
      password: 'a1',
    })
  })

  it.each([
    ['direct', '/reset-password?token=terminal-direct-token'],
    ['handoff', 'handoff'],
  ])('ends %s reset in a terminal success state with no resubmission', async (kind, path) => {
    authMocks.confirmPasswordReset.mockResolvedValue(undefined)
    let handoffId: string | undefined
    if (kind === 'handoff') {
      handoffId = putDeepLinkHandoff({ kind: 'reset-password', token: 'terminal-handoff-token' })
      path = `/link/${handoffId}`
    }
    renderResetPage(path)

    await userEvent.type(screen.getByLabelText(/new password/i), 'terminal-password-123')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'terminal-password-123')
    await userEvent.click(screen.getByRole('button', { name: /reset password/i }))
    await screen.findByText(/password reset complete/i)

    expect(screen.queryByRole('form')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /reset password/i })).not.toBeInTheDocument()
    expect(screen.getByText(/password reset complete/i)).toHaveFocus()
    expect(screen.getByRole('link', { name: /back to sign in/i })).toBeInTheDocument()
    await userEvent.keyboard('{Enter}')
    expect(authMocks.confirmPasswordReset).toHaveBeenCalledTimes(1)
    if (handoffId) expect(getDeepLinkHandoff(handoffId)).toBeUndefined()
  })

  it('does not consume a handoff when its request completes after unmount', async () => {
    const request = deferredRequest()
    authMocks.confirmPasswordReset.mockReturnValue(request.promise)
    const handoffId = putDeepLinkHandoff({ kind: 'reset-password', token: 'reset-token' })
    const view = renderResetPage(`/link/${handoffId}`)

    await userEvent.type(screen.getByLabelText(/new password/i), 'new-password-123')
    await userEvent.type(screen.getByLabelText(/confirm password/i), 'new-password-123')
    await userEvent.click(screen.getByRole('button', { name: /reset password/i }))
    view.unmount()
    await act(async () => request.resolve())

    expect(getDeepLinkHandoff(handoffId)).toEqual({ kind: 'reset-password', token: 'reset-token' })
  })
})
