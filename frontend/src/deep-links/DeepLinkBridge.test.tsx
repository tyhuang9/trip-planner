import { useEffect, useState } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeepLinkBridge } from './DeepLinkBridge'
import { enqueueDeepLink, __resetDeepLinkQueueForTests } from './queue'
import { __resetDeepLinkVaultForTests } from './vault'

let isInitializing = false
vi.mock('../auth/useAuth', () => ({
  useAuth: () => ({ isInitializing }),
}))

function LocationLog() {
  const location = useLocation()
  const navigate = useNavigate()
  const [paths, setPaths] = useState<string[]>([])
  useEffect(() => setPaths((current) => [...current, location.pathname]), [location.pathname])
  return <><div data-testid="paths">{paths.join(',')}</div><button type="button" onClick={() => navigate('/ready')}>Acknowledge</button></>
}

beforeEach(() => {
  isInitializing = false
  __resetDeepLinkQueueForTests()
  __resetDeepLinkVaultForTests()
})

describe('DeepLinkBridge', () => {
  it('waits for auth resolution and holds the next FIFO link until the first arrival is acknowledged', async () => {
    isInitializing = true
    enqueueDeepLink({ kind: 'trip', publicId: 'first' })
    enqueueDeepLink({ kind: 'trip', publicId: 'second' })
    const view = render(<MemoryRouter><DeepLinkBridge /><LocationLog /></MemoryRouter>)
    expect(screen.getByTestId('paths')).toHaveTextContent('/')

    isInitializing = false
    view.rerender(<MemoryRouter><DeepLinkBridge /><LocationLog /></MemoryRouter>)
    await waitFor(() => expect(screen.getByTestId('paths')).toHaveTextContent('/,/trips/first'))
    expect(screen.getByTestId('paths')).not.toHaveTextContent('/trips/second')
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }))
    await waitFor(() => expect(screen.getByTestId('paths')).toHaveTextContent('/ready,/trips/second'))
  })

  it('drains a warm notification after the bridge is already ready', async () => {
    render(<MemoryRouter><DeepLinkBridge /><LocationLog /></MemoryRouter>)
    act(() => enqueueDeepLink({ kind: 'trip', publicId: 'warm123' }))
    await waitFor(() => expect(screen.getByTestId('paths')).toHaveTextContent('/,/trips/warm123'))
  })
})
