import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import PasswordResetPage from './PasswordResetPage'

const authMocks = vi.hoisted(() => ({
  confirmPasswordReset: vi.fn(),
}))

vi.mock('../api/auth', () => ({
  confirmPasswordReset: authMocks.confirmPasswordReset,
}))

function renderResetPage(path: string) {
  function LocationProbe() {
    const location = useLocation()
    return <div data-testid="current-search">{location.search}</div>
  }

  return render(
    <MemoryRouter initialEntries={[path]}>
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
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  authMocks.confirmPasswordReset.mockReset()
})

describe('<PasswordResetPage>', () => {
  it('hides the reset token field, strips token from the URL, and submits the captured token', async () => {
    authMocks.confirmPasswordReset.mockResolvedValue(undefined)

    renderResetPage('/reset-password?token=secret-reset-token&next=ignored')

    expect(screen.queryByLabelText(/reset code/i)).not.toBeInTheDocument()
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
    expect(password).toHaveAttribute('aria-describedby', alert.id)
    expect(confirmation).toHaveAttribute('aria-describedby', alert.id)
  })
})
