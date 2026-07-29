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
    expect(screen.getByRole('button', { name: /reset password/i })).toBeDisabled()
    expect(authMocks.confirmPasswordReset).not.toHaveBeenCalled()
  })
})
