import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AxiosError, AxiosHeaders } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '../auth/authContextValue'
import { ColorModeProvider } from '../theme/ColorModeProvider'
import { COLOR_MODE_STORAGE_KEY } from '../theme/colorMode'
import { AccountSettingsDialog } from './AccountSettingsDialog'

function makeAuth(): AuthContextValue {
  return {
    authStatus: 'authenticated',
    user: {
      id: 1,
      email: 'alice@example.com',
      displayName: 'Alice',
      emailVerified: true,
    },
    isAuthenticated: true,
    isInitializing: false,
    retryAuthResolution: vi.fn(async () => {}),
    login: vi.fn(async () => ({
      id: 1,
      email: 'alice@example.com',
      displayName: 'Alice',
      emailVerified: true,
    })),
    register: vi.fn(async () => ({
      status: 'verification_required' as const,
      email: 'alice@example.com',
    })),
    updateProfile: vi.fn(async () => ({
      id: 1,
      email: 'alice@example.com',
      displayName: 'Alice',
      emailVerified: true,
    })),
    changePassword: vi.fn(async () => {}),
    requestPasswordReset: vi.fn(async () => {}),
    resendEmailVerification: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    deleteAccount: vi.fn(async () => {}),
  }
}

function renderDialog(options?: {
  auth?: AuthContextValue
  onClose?: () => void
  onDeleted?: () => void
}) {
  const auth = options?.auth ?? makeAuth()
  const onClose = options?.onClose ?? vi.fn()
  const onDeleted = options?.onDeleted ?? vi.fn()
  const view = render(
    <AuthContext.Provider value={auth}>
      <ColorModeProvider>
        <AccountSettingsDialog
          onClose={onClose}
          onDeleted={onDeleted}
          user={{
            id: 1,
            email: 'alice@example.com',
            displayName: 'Alice',
            emailVerified: true,
          }}
        />
      </ColorModeProvider>
    </AuthContext.Provider>,
  )

  return { auth, onClose, onDeleted, ...view }
}

function makeAxiosError(status: number, code: string): AxiosError {
  return new AxiosError(
    `Request failed with status code ${status}`,
    String(status),
    undefined,
    {},
    {
      status,
      data: { error: code },
      statusText: '',
      headers: new AxiosHeaders(),
      config: { headers: new AxiosHeaders() },
    },
  )
}

beforeEach(() => {
  window.localStorage.clear()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      media: '(prefers-color-scheme: dark)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('<AccountSettingsDialog>', () => {
  it('uses the header close button as the only dismiss action', async () => {
    const onClose = vi.fn()
    renderDialog({ onClose })

    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: 'Close account settings' }))

    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes after account settings are saved successfully', async () => {
    const onClose = vi.fn()
    const { auth } = renderDialog({ onClose })

    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(auth.updateProfile).toHaveBeenCalledWith({ displayName: 'Alice' }))
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('stays open when saving account settings fails', async () => {
    const onClose = vi.fn()
    const auth = makeAuth()
    auth.updateProfile = vi.fn(async () => {
      throw new Error('Unable to save profile')
    })
    renderDialog({ auth, onClose })

    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Account settings' })).toBeInTheDocument()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('requires the exact confirmation and a current password', async () => {
    renderDialog()

    await userEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    const confirmation = screen.getByRole('alertdialog', {
      name: 'Delete account?',
    })
    const deleteButton = within(confirmation).getByRole('button', {
      name: 'Delete account',
    })
    const passwordInput = within(confirmation).getByLabelText('Current password')

    expect(deleteButton).toBeDisabled()
    expect(passwordInput).toHaveAttribute('autocomplete', 'current-password')

    await userEvent.type(within(confirmation).getByLabelText('Confirmation'), 'Delete')
    await userEvent.type(passwordInput, 'current-secret')
    expect(deleteButton).toBeDisabled()

    await userEvent.clear(within(confirmation).getByLabelText('Confirmation'))
    await userEvent.type(within(confirmation).getByLabelText('Confirmation'), 'delete')
    expect(deleteButton).toBeEnabled()
  })

  it('contains focus in the modal confirmation and hides account settings behind it', async () => {
    renderDialog()
    const opener = screen.getByRole('button', { name: 'Delete account' })

    await userEvent.click(opener)
    const confirmation = screen.getByRole('alertdialog', {
      name: 'Delete account?',
    })
    const accountSettings = screen.getByRole('dialog', {
      name: 'Account settings',
      hidden: true,
    })
    const confirmationInput = within(confirmation).getByLabelText('Confirmation')
    const passwordInput = within(confirmation).getByLabelText('Current password')
    const deleteButton = within(confirmation).getByRole('button', {
      name: 'Delete account',
    })

    expect(accountSettings.parentElement).toHaveAttribute('aria-hidden', 'true')
    expect(accountSettings.parentElement).toHaveAttribute('inert')
    expect(within(confirmation).getByText(/Type the exact lowercase word/)).toHaveTextContent(
      'Type the exact lowercase word delete and enter your current password to permanently remove this account.',
    )
    await waitFor(() => expect(confirmationInput).toHaveFocus())

    await userEvent.type(confirmationInput, 'delete')
    await userEvent.type(passwordInput, 'current-secret')
    confirmationInput.focus()
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true })
    expect(deleteButton).toHaveFocus()
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(confirmationInput).toHaveFocus()
  })

  it('restores focus to the opener after Escape and Cancel', async () => {
    renderDialog()
    const opener = screen.getByRole('button', { name: 'Delete account' })

    await userEvent.click(opener)
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
      expect(opener).toHaveFocus()
    })

    await userEvent.click(opener)
    await userEvent.click(
      within(screen.getByRole('alertdialog')).getByRole('button', {
        name: 'Cancel',
      }),
    )
    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
      expect(opener).toHaveFocus()
    })
  })

  it('passes the current password and reports deletion only after success', async () => {
    const onDeleted = vi.fn()
    const { auth } = renderDialog({ onDeleted })

    await userEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    const confirmation = screen.getByRole('alertdialog', {
      name: 'Delete account?',
    })
    await userEvent.type(within(confirmation).getByLabelText('Confirmation'), 'delete')
    await userEvent.type(within(confirmation).getByLabelText('Current password'), 'current-secret')
    await userEvent.click(
      within(confirmation).getByRole('button', { name: 'Delete account' }),
    )

    await waitFor(() => {
      expect(auth.deleteAccount).toHaveBeenCalledWith({
        currentPassword: 'current-secret',
      })
    })
    expect(onDeleted).toHaveBeenCalledOnce()
  })

  it('keeps the alert dialog open and refocuses an empty password after reauthentication fails', async () => {
    const auth = makeAuth()
    const onDeleted = vi.fn()
    auth.deleteAccount = vi.fn(async () => {
      throw makeAxiosError(403, 'reauthentication_failed')
    })
    renderDialog({ auth, onDeleted })

    await userEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    const confirmation = screen.getByRole('alertdialog', {
      name: 'Delete account?',
    })
    const confirmationInput = within(confirmation).getByLabelText('Confirmation')
    const passwordInput = within(confirmation).getByLabelText('Current password')
    await userEvent.type(confirmationInput, 'delete')
    await userEvent.type(passwordInput, 'incorrect-secret')
    await userEvent.click(
      within(confirmation).getByRole('button', { name: 'Delete account' }),
    )

    expect(await within(confirmation).findByRole('alert')).toHaveTextContent(
      'password you entered is incorrect',
    )
    expect(confirmation).toBeInTheDocument()
    expect(confirmationInput).toHaveValue('delete')
    expect(passwordInput).toHaveValue('')
    await waitFor(() => expect(passwordInput).toHaveFocus())
    expect(passwordInput).toHaveAttribute('aria-invalid', 'true')
    expect(passwordInput).toHaveAttribute(
      'aria-describedby',
      'delete-account-error',
    )

    await userEvent.type(confirmationInput, 'x')
    expect(within(confirmation).queryByRole('alert')).not.toBeInTheDocument()
    expect(passwordInput).not.toHaveAttribute('aria-invalid')
    expect(passwordInput).not.toHaveAttribute('aria-describedby')
    expect(onDeleted).not.toHaveBeenCalled()
  })

  it.each([
    [401, 'unauthenticated'],
    [429, 'rate_limited'],
    [503, 'unavailable'],
  ])('does not report deletion after an HTTP %i failure', async (status, code) => {
    const auth = makeAuth()
    const onDeleted = vi.fn()
    auth.deleteAccount = vi.fn(async () => {
      throw makeAxiosError(status, code)
    })
    renderDialog({ auth, onDeleted })

    await userEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    const confirmation = screen.getByRole('alertdialog', {
      name: 'Delete account?',
    })
    await userEvent.type(within(confirmation).getByLabelText('Confirmation'), 'delete')
    await userEvent.type(within(confirmation).getByLabelText('Current password'), 'current-secret')
    await userEvent.click(
      within(confirmation).getByRole('button', { name: 'Delete account' }),
    )

    expect(await within(confirmation).findByRole('alert')).toBeInTheDocument()
    expect(onDeleted).not.toHaveBeenCalled()
    expect(confirmation).toBeInTheDocument()
  })

  it('does not claim account deletion after a network failure', async () => {
    const auth = makeAuth()
    const onDeleted = vi.fn()
    auth.deleteAccount = vi.fn(async () => {
      throw new Error('offline')
    })
    renderDialog({ auth, onDeleted })

    await userEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    const confirmation = screen.getByRole('alertdialog', {
      name: 'Delete account?',
    })
    await userEvent.type(within(confirmation).getByLabelText('Confirmation'), 'delete')
    await userEvent.type(within(confirmation).getByLabelText('Current password'), 'current-secret')
    await userEvent.click(
      within(confirmation).getByRole('button', { name: 'Delete account' }),
    )

    expect(await within(confirmation).findByRole('alert')).toBeInTheDocument()
    expect(onDeleted).not.toHaveBeenCalled()
    expect(confirmation).toBeInTheDocument()
  })

  it('announces pending deletion, retains focus, and prevents duplicate submissions', async () => {
    let resolveDeletion: (() => void) | undefined
    const auth = makeAuth()
    const onDeleted = vi.fn()
    auth.deleteAccount = vi.fn(
      () => new Promise<void>((resolve) => { resolveDeletion = resolve }),
    )
    renderDialog({ auth, onDeleted })

    await userEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    const confirmation = screen.getByRole('alertdialog', {
      name: 'Delete account?',
    })
    const confirmationInput = within(confirmation).getByLabelText('Confirmation')
    const passwordInput = within(confirmation).getByLabelText('Current password')
    const cancelButton = within(confirmation).getByRole('button', { name: 'Cancel' })
    const deleteButton = within(confirmation).getByRole('button', {
      name: 'Delete account',
    })
    await userEvent.type(confirmationInput, 'delete')
    await userEvent.type(passwordInput, 'current-secret')
    await userEvent.click(deleteButton)

    expect(confirmationInput).toBeDisabled()
    expect(passwordInput).toBeDisabled()
    expect(cancelButton).toBeDisabled()
    expect(confirmation).toHaveAttribute('aria-busy', 'true')
    expect(deleteButton).not.toBeDisabled()
    expect(deleteButton).toHaveAttribute('aria-disabled', 'true')
    expect(deleteButton).toHaveAttribute('aria-busy', 'true')
    expect(deleteButton).toHaveFocus()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Deleting your account. Please wait.',
    )
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent.keyDown(window, { key: 'Tab' })
    expect(confirmation).toBeInTheDocument()
    expect(deleteButton).toHaveFocus()
    await userEvent.click(deleteButton)
    expect(auth.deleteAccount).toHaveBeenCalledOnce()

    resolveDeletion?.()
    await waitFor(() => expect(onDeleted).toHaveBeenCalledOnce())
  })

  it('applies and stores color mode choices immediately', async () => {
    renderDialog()

    await userEvent.click(screen.getByRole('button', { name: 'Dark' }))

    expect(window.localStorage.getItem(COLOR_MODE_STORAGE_KEY)).toBe('dark')
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(screen.getByRole('button', { name: 'Dark' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    await userEvent.click(screen.getByRole('button', { name: 'System' }))

    expect(window.localStorage.getItem(COLOR_MODE_STORAGE_KEY)).toBe('system')
    expect(document.documentElement.dataset.theme).toBe('light')
    expect(document.documentElement.dataset.colorMode).toBe('system')
  })
})
