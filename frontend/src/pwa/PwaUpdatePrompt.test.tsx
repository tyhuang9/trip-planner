import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PwaUpdatePrompt } from './PwaUpdatePrompt'

const serviceWorkerState = vi.hoisted(() => ({
  needRefresh: false,
  offlineReady: false,
  onRegisterError: null as null | (() => void),
  setNeedRefresh: vi.fn(),
  setOfflineReady: vi.fn(),
  updateServiceWorker: vi.fn(),
}))

vi.mock('virtual:pwa-register/react', () => ({
  useRegisterSW: (options: { onRegisterError?: () => void }) => {
    serviceWorkerState.onRegisterError = options.onRegisterError ?? null
    return {
      needRefresh: [serviceWorkerState.needRefresh, serviceWorkerState.setNeedRefresh],
      offlineReady: [serviceWorkerState.offlineReady, serviceWorkerState.setOfflineReady],
      updateServiceWorker: serviceWorkerState.updateServiceWorker,
    }
  },
}))

beforeEach(() => {
  serviceWorkerState.needRefresh = false
  serviceWorkerState.offlineReady = false
  serviceWorkerState.onRegisterError = null
  serviceWorkerState.setNeedRefresh.mockReset()
  serviceWorkerState.setOfflineReady.mockReset()
  serviceWorkerState.updateServiceWorker.mockReset().mockResolvedValue(undefined)
})

describe('<PwaUpdatePrompt>', () => {
  it('stays hidden when registration needs no attention', () => {
    const { container } = render(<PwaUpdatePrompt />)
    expect(container).toBeEmptyDOMElement()
  })

  it('explains the private-data boundary when the offline shell is ready', () => {
    serviceWorkerState.offlineReady = true
    render(<PwaUpdatePrompt />)

    expect(screen.getByText('Dupert is ready offline')).toBeInTheDocument()
    expect(screen.getByText(/Trip data still requires the network/i)).toBeInTheDocument()
  })

  it('activates a waiting update only after explicit user action', () => {
    serviceWorkerState.needRefresh = true
    render(<PwaUpdatePrompt />)

    expect(serviceWorkerState.updateServiceWorker).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Reload to update' }))
    expect(serviceWorkerState.updateServiceWorker).toHaveBeenCalledWith(true)
  })

  it('dismisses both service-worker notices without activating an update', () => {
    serviceWorkerState.offlineReady = true
    render(<PwaUpdatePrompt />)

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(serviceWorkerState.setNeedRefresh).toHaveBeenCalledWith(false)
    expect(serviceWorkerState.setOfflineReady).toHaveBeenCalledWith(false)
    expect(serviceWorkerState.updateServiceWorker).not.toHaveBeenCalled()
  })

  it('surfaces service-worker registration errors', () => {
    render(<PwaUpdatePrompt />)

    act(() => serviceWorkerState.onRegisterError?.())
    expect(screen.getByText('Offline setup needs attention')).toBeInTheDocument()
    expect(screen.getByText(/could not enable offline access/i)).toBeInTheDocument()
  })
})
