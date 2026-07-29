import { useEffect, useState } from 'react'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
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
  const [paths, setPaths] = useState<string[]>([])
  useEffect(() => setPaths((current) => [...current, location.pathname]), [location.pathname])
  return <div data-testid="paths">{paths.join(',')}</div>
}

beforeEach(() => {
  isInitializing = false
  __resetDeepLinkQueueForTests()
  __resetDeepLinkVaultForTests()
})

describe('DeepLinkBridge', () => {
  it('waits for auth resolution, then drains FIFO links one navigation at a time', async () => {
    isInitializing = true
    enqueueDeepLink({ kind: 'trip', publicId: 'first' })
    enqueueDeepLink({ kind: 'trip', publicId: 'second' })
    const view = render(<MemoryRouter><DeepLinkBridge /><LocationLog /></MemoryRouter>)
    expect(screen.getByTestId('paths')).toHaveTextContent('/')

    isInitializing = false
    view.rerender(<MemoryRouter><DeepLinkBridge /><LocationLog /></MemoryRouter>)
    await waitFor(() => expect(screen.getByTestId('paths')).toHaveTextContent('/,/trips/first,/trips/second'))
  })

  it('drains a warm notification after the bridge is already ready', async () => {
    render(<MemoryRouter><DeepLinkBridge /><LocationLog /></MemoryRouter>)
    enqueueDeepLink({ kind: 'trip', publicId: 'warm123' })
    await waitFor(() => expect(screen.getByTestId('paths')).toHaveTextContent('/,/trips/warm123'))
  })
})
