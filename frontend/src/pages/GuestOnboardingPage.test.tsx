import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router'
import {
  __resetDeepLinkVaultForTests,
  putDeepLinkHandoff,
} from '../deep-links/vault'
import GuestOnboardingPage from './GuestOnboardingPage'

const shareMocks = vi.hoisted(() => ({
  mutateAsync: vi.fn(),
}))

vi.mock('../hooks/useShareLinks', () => ({
  useAcceptGuestShareLink: () => ({
    mutateAsync: shareMocks.mutateAsync,
    isPending: false,
    error: null,
  }),
}))

beforeEach(() => {
  shareMocks.mutateAsync.mockReset()
  __resetDeepLinkVaultForTests()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function RouteChangeButton({ to }: { to: string }) {
  const navigate = useNavigate()
  return <button type="button" onClick={() => navigate(to)}>Open next invite</button>
}

describe('<GuestOnboardingPage>', () => {
  it('keeps the handoff token while form rerenders continue after vault expiry', async () => {
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    shareMocks.mutateAsync.mockResolvedValue({
      publicId: 'abc234def567',
      role: 'VIEWER',
    })
    const handoffId = putDeepLinkHandoff({
      kind: 'share-guest',
      token: 'stable-guest-token',
    })
    render(
      <MemoryRouter initialEntries={[`/link/${handoffId}/guest`]}>
        <Routes>
          <Route path="/link/:handoffId/guest" element={<GuestOnboardingPage />} />
          <Route path="/trips/:publicId" element={<div>Shared trip</div>} />
        </Routes>
      </MemoryRouter>,
    )

    now += 10 * 60_000 + 1
    await userEvent.type(screen.getByRole('textbox', { name: 'Display name' }), 'Traveler')

    const joinButton = screen.getByRole('button', { name: 'Join as guest' })
    expect(joinButton).toBeEnabled()
    await userEvent.click(joinButton)
    expect(shareMocks.mutateAsync).toHaveBeenCalledWith({
      token: 'stable-guest-token',
      body: { displayName: 'Traveler' },
    })
  })

  it('uses the new raw route token when the router preserves the form instance', async () => {
    shareMocks.mutateAsync.mockResolvedValue({
      publicId: 'abc234def567',
      role: 'VIEWER',
    })
    render(
      <MemoryRouter initialEntries={['/share/first-token/guest']}>
        <RouteChangeButton to="/share/second-token/guest" />
        <Routes>
          <Route path="/share/:token/guest" element={<GuestOnboardingPage />} />
          <Route path="/trips/:publicId" element={<div>Shared trip</div>} />
        </Routes>
      </MemoryRouter>,
    )
    const nameInput = screen.getByRole('textbox', { name: 'Display name' })
    await userEvent.type(nameInput, 'Traveler')

    await userEvent.click(screen.getByRole('button', { name: 'Open next invite' }))
    expect(nameInput).toHaveValue('Traveler')
    await userEvent.click(screen.getByRole('button', { name: 'Join as guest' }))

    expect(shareMocks.mutateAsync).toHaveBeenCalledWith({
      token: 'second-token',
      body: { displayName: 'Traveler' },
    })
  })
})
