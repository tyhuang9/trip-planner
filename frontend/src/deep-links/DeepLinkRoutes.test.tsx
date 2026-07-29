import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeepLinkHandoffRoute, DeepLinkScrubber } from './DeepLinkRoutes'
import { __resetDeepLinkVaultForTests, putDeepLinkHandoff } from './vault'
import { parseDeepLinkPath } from './policy'

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}{location.search}</div>
}

beforeEach(() => __resetDeepLinkVaultForTests())

describe('deep-link routes', () => {
  it('replaces a direct web token URL before rendering its destination', async () => {
    expect(parseDeepLinkPath('/share/raw-token')).toEqual({ kind: 'share', token: 'raw-token' })
    render(
      <MemoryRouter initialEntries={['/share/raw-token']}>
        <Routes>
          <Route path="/share/:token" element={<DeepLinkScrubber />} />
          <Route path="*" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    )
    const location = await screen.findByTestId('location')
    expect(location).toHaveTextContent(/^\/link\/dl_[a-f0-9]{32}$/)
    expect(location).not.toHaveTextContent('raw-token')
  })

  it('dispatches only exact, valid handoff routes', () => {
    const id = putDeepLinkHandoff({ kind: 'share', token: 'invite-secret' })
    render(
      <MemoryRouter initialEntries={[`/link/${id}`]}>
        <Routes>
          <Route path="/link/:handoffId" element={<DeepLinkHandoffRoute acceptInvite={<div>invite</div>} guestOnboarding={<div>guest</div>} emailVerification={<div>verify</div>} passwordReset={<div>reset</div>} />} />
        </Routes>
      </MemoryRouter>,
    )
    expect(screen.getByText('invite')).toBeInTheDocument()
  })

  it('rejects an expired handoff', async () => {
    vi.useFakeTimers()
    const id = putDeepLinkHandoff({ kind: 'share', token: 'invite-secret' })
    vi.advanceTimersByTime(10 * 60_000 + 1)
    render(
      <MemoryRouter initialEntries={[`/link/${id}`]}>
        <Routes>
          <Route path="/link/:handoffId" element={<DeepLinkHandoffRoute acceptInvite={<div>invite</div>} guestOnboarding={<div>guest</div>} emailVerification={<div>verify</div>} passwordReset={<div>reset</div>} />} />
          <Route path="/404" element={<div>not found</div>} />
        </Routes>
      </MemoryRouter>,
    )
    vi.useRealTimers()
    expect(await screen.findByText('not found')).toBeInTheDocument()
  })

  it('rejects an unsupported handoff suffix', async () => {
    const id = putDeepLinkHandoff({ kind: 'share', token: 'invite-secret' })
    render(<MemoryRouter initialEntries={[`/link/${id}/other`]}><Routes><Route path="/link/:handoffId/other" element={<DeepLinkHandoffRoute acceptInvite={<div>invite</div>} guestOnboarding={<div>guest</div>} emailVerification={<div>verify</div>} passwordReset={<div>reset</div>} />} /><Route path="/404" element={<div>not found</div>} /></Routes></MemoryRouter>)
    expect(await screen.findByText('not found')).toBeInTheDocument()
  })
})
