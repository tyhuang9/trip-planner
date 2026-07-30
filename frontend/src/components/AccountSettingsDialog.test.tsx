import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

  it('does not claim account deletion when the server does not confirm it', async () => {
    const auth = makeAuth()
    const onDeleted = vi.fn()
    auth.deleteAccount = vi.fn(async () => {
      throw new Error('offline')
    })
    renderDialog({ auth, onDeleted })

    await userEvent.click(screen.getByRole('button', { name: 'Delete account' }))
    await userEvent.type(screen.getByLabelText('Confirmation'), 'delete')
    const confirmation = screen.getByRole('alertdialog', {
      name: 'Delete account?',
    })
    await userEvent.click(
      within(confirmation).getByRole('button', { name: 'Delete account' }),
    )

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(onDeleted).not.toHaveBeenCalled()
    expect(
      screen.getByRole('dialog', { name: 'Account settings' }),
    ).toBeInTheDocument()
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
