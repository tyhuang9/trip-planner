import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import { AuthContext, type AuthContextValue } from '../auth/authContextValue'
import AcceptInvitePage from './AcceptInvitePage'
import {
  getDeepLinkHandoff,
  putDeepLinkHandoff,
  __resetDeepLinkVaultForTests,
} from '../deep-links/vault'
import { DeepLinkRouteFocus } from '../deep-links/DeepLinkRouteFocus'
import { __resetDeepLinkRouteFocusForTests } from '../deep-links/routeFocusRequest'

const shareMocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
  isPending: false,
}))

vi.mock('../hooks/useShareLinks', () => ({
  useAcceptShareLink: () => ({
    mutateAsync: shareMocks.mutateAsync,
    isPending: shareMocks.isPending,
    error: null,
  }),
}))

function makeAuth(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    authStatus: 'unauthenticated',
    user: null,
    isAuthenticated: false,
    isInitializing: false,
    retryAuthResolution: vi.fn(),
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
        <DeepLinkRouteFocus />
        <Routes>
          <Route path="/share/:token" element={<AcceptInvitePage />} />
          <Route
            path="/trips/:publicId"
            element={<main id="main" data-testid="shared-trip"><h1>Shared trip</h1></main>}
          />
          <Route path="/login" element={<div>Login</div>} />
          <Route path="/register" element={<div>Register</div>} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  )
}

function RouteChangeButton({ to }: { to: string }) {
  const navigate = useNavigate()
  return <button type="button" onClick={() => navigate(to)}>Open next invite</button>
}

beforeEach(() => {
  shareMocks.mutateAsync.mockReset()
  shareMocks.isPending = false
  __resetDeepLinkVaultForTests()
  __resetDeepLinkRouteFocusForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('<AcceptInvitePage>', () => {
  it('waits for an authenticated user to explicitly accept the invite', async () => {
    shareMocks.mutateAsync.mockResolvedValue({
      publicId: 'abc234def567',
      role: 'EDITOR',
    })

    renderInvite(makeAuth({ isAuthenticated: true }))

    expect(shareMocks.mutateAsync).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Accept invite' }))
    expect(shareMocks.mutateAsync).toHaveBeenCalledWith('raw-token')
    expect(await screen.findByTestId('shared-trip')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Shared trip' })).toHaveFocus())
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

  it('uses an opaque return path for a scrubbed share handoff', () => {
    const handoffId = putDeepLinkHandoff({ kind: 'share', token: 'raw-token' })
    render(
      <AuthContext.Provider value={makeAuth()}>
        <MemoryRouter initialEntries={[`/link/${handoffId}`]}>
          <Routes>
            <Route path="/link/:handoffId" element={<AcceptInvitePage />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    )

    expect(screen.getByRole('link', { name: /sign in/i })).toHaveAttribute('href', `/login?return=%2Flink%2F${handoffId}`)
    expect(screen.getByRole('link', { name: /continue as guest/i })).toHaveAttribute('href', `/link/${handoffId}/guest`)
  })

  it('keeps the handoff token after its vault entry expires during an unrelated rerender', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const handoffId = putDeepLinkHandoff({ kind: 'share', token: 'stable-token' })
    const auth = makeAuth({ isAuthenticated: true })
    const tree = () => (
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={[`/link/${handoffId}`]}>
          <Routes>
            <Route path="/link/:handoffId" element={<AcceptInvitePage />} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    )
    const view = render(tree())

    now += 10 * 60_000 + 1
    view.rerender(tree())

    const acceptButton = screen.getByRole('button', { name: 'Accept invite' })
    expect(acceptButton).toBeEnabled()
    await userEvent.click(acceptButton)
    expect(shareMocks.mutateAsync).toHaveBeenCalledWith('stable-token')
  })

  it('refreshes the snapshot when the router reuses the page for a new handoff', async () => {
    shareMocks.mutateAsync.mockResolvedValue({
      publicId: 'abc234def567',
      role: 'EDITOR',
    })
    const firstHandoffId = putDeepLinkHandoff({ kind: 'share', token: 'first-token' })
    const secondHandoffId = putDeepLinkHandoff({ kind: 'share', token: 'second-token' })
    render(
      <AuthContext.Provider value={makeAuth({ isAuthenticated: true })}>
        <MemoryRouter initialEntries={[`/link/${firstHandoffId}`]}>
          <RouteChangeButton to={`/link/${secondHandoffId}`} />
          <Routes>
            <Route path="/link/:handoffId" element={<AcceptInvitePage />} />
            <Route path="/trips/:publicId" element={<div>Shared trip</div>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    )

    await userEvent.click(screen.getByRole('button', { name: 'Open next invite' }))
    await userEvent.click(screen.getByRole('button', { name: 'Accept invite' }))

    expect(shareMocks.mutateAsync).toHaveBeenCalledWith('second-token')
    expect(getDeepLinkHandoff(firstHandoffId)).toEqual({
      kind: 'share',
      token: 'first-token',
    })
    expect(getDeepLinkHandoff(secondHandoffId)).toBeUndefined()
  })

  it('announces invite acceptance progress politely', () => {
    shareMocks.isPending = true
    shareMocks.mutateAsync.mockReturnValue(new Promise(() => undefined))
    renderInvite(makeAuth({ isAuthenticated: true }))
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent('Accepting invite...')
    expect(status).toHaveAttribute('aria-live', 'polite')
  })
})
