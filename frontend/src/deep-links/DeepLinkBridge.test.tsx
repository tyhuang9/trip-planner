import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeepLinkBridge } from './DeepLinkBridge'
import { enqueueDeepLink, __resetDeepLinkQueueForTests } from './queue'
import { clearDeepLinkHandoff, __resetDeepLinkVaultForTests } from './vault'
import { DeepLinkRouteFocus, __resetDeepLinkRouteFocusForTests } from './DeepLinkRouteFocus'

let isInitializing = false
vi.mock('../auth/useAuth', () => ({
  useAuth: () => ({ isInitializing }),
}))

function LocationLog() {
  const location = useLocation()
  const navigate = useNavigate()
  return <><div data-testid="paths">{location.pathname}</div><main id="main"><h1 key={location.key}>{location.pathname}</h1></main><button type="button" onClick={() => navigate('/ready')}>Acknowledge</button><button type="button" onClick={() => navigate(`${location.pathname}/guest`)}>Guest</button></>
}

beforeEach(() => {
  isInitializing = false
  __resetDeepLinkQueueForTests()
  __resetDeepLinkVaultForTests()
  __resetDeepLinkRouteFocusForTests()
})

describe('DeepLinkBridge', () => {
  it('waits for auth resolution and holds the next FIFO link until the first arrival is acknowledged', async () => {
    isInitializing = true
    enqueueDeepLink({ kind: 'trip', publicId: 'first' })
    enqueueDeepLink({ kind: 'trip', publicId: 'second' })
    const view = render(<MemoryRouter><DeepLinkBridge /><DeepLinkRouteFocus /><LocationLog /></MemoryRouter>)
    expect(screen.getByTestId('paths')).toHaveTextContent('/')

    isInitializing = false
    view.rerender(<MemoryRouter><DeepLinkBridge /><DeepLinkRouteFocus /><LocationLog /></MemoryRouter>)
    await waitFor(() => expect(screen.getByTestId('paths')).toHaveTextContent('/trips/first'))
    await waitFor(() => expect(screen.getByRole('heading', { name: '/trips/first' })).toHaveFocus())
    expect(screen.getByTestId('paths')).not.toHaveTextContent('/trips/second')
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }))
    await waitFor(() => expect(screen.getByTestId('paths')).toHaveTextContent('/trips/second'))
  })

  it('drains a warm notification after the bridge is already ready', async () => {
    render(<MemoryRouter><DeepLinkBridge /><DeepLinkRouteFocus /><LocationLog /></MemoryRouter>)
    const sourceHeading = screen.getByRole('heading', { name: '/' })
    const sourceFocus = vi.spyOn(sourceHeading, 'focus')
    act(() => enqueueDeepLink({ kind: 'trip', publicId: 'warm123' }))
    await waitFor(() => expect(screen.getByTestId('paths')).toHaveTextContent('/trips/warm123'))
    expect(sourceFocus).not.toHaveBeenCalled()
    await waitFor(() => expect(screen.getByRole('heading', { name: '/trips/warm123' })).toHaveFocus())
  })

  it('keeps later links queued while a share continuation remains in the vault', async () => {
    enqueueDeepLink({ kind: 'share', token: 'first-secret' })
    enqueueDeepLink({ kind: 'share', token: 'second-secret' })
    render(<MemoryRouter><DeepLinkBridge /><LocationLog /></MemoryRouter>)
    await waitFor(() => expect(screen.getByTestId('paths')).toHaveTextContent(/^\/link\/dl_/))
    const firstId = screen.getByTestId('paths').textContent?.split('/').pop()
    fireEvent.click(screen.getByRole('button', { name: 'Guest' }))
    expect(screen.getByTestId('paths')).toHaveTextContent(`/link/${firstId}/guest`)
    clearDeepLinkHandoff(firstId)
    await waitFor(() => expect(screen.getByTestId('paths')).not.toHaveTextContent(firstId ?? ''))
    expect(screen.getByTestId('paths')).toHaveTextContent(/^\/link\/dl_/)
  })
})
