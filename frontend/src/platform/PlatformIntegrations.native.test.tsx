import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PlatformIntegrations } from './PlatformIntegrations.native'
import { takeDeepLink, __resetDeepLinkQueueForTests } from '../deep-links/queue'
import { __resetDeepLinkVaultForTests } from '../deep-links/vault'

const appMocks = vi.hoisted(() => ({
  getLaunchUrl: vi.fn(),
  addListener: vi.fn(),
}))

vi.mock('@capacitor/app', () => ({ App: appMocks }))

beforeEach(() => {
  __resetDeepLinkQueueForTests()
  __resetDeepLinkVaultForTests()
  appMocks.getLaunchUrl.mockResolvedValue(undefined)
  appMocks.addListener.mockResolvedValue({ remove: vi.fn() })
})

describe('<PlatformIntegrations> native target', () => {
  it('renders application content without the browser access gate or analytics wrapper', () => {
    render(
      <PlatformIntegrations>
        <div data-testid="native-app-content">Trip app</div>
      </PlatformIntegrations>,
    )

    expect(screen.getByTestId('native-app-content')).toBeInTheDocument()
    expect(screen.queryByLabelText(/access password/i)).not.toBeInTheDocument()
  })

  it('captures a valid launch URL without storing the token in the queue target', async () => {
    appMocks.getLaunchUrl.mockResolvedValue({ url: 'https://dupert.vercel.app/share/secret-token' })
    render(<PlatformIntegrations><div /></PlatformIntegrations>)

    await waitFor(() => expect(takeDeepLink()?.target).toMatch(/^\/link\/dl_/))
  })

  it('captures cold and warm links exactly once', async () => {
    let listener: ((event: { url: string }) => void) | undefined
    appMocks.getLaunchUrl.mockResolvedValue({ url: 'https://dupert.vercel.app/trips/abc123' })
    appMocks.addListener.mockImplementation(async (_name: string, callback: (event: { url: string }) => void) => {
      listener = callback
      return { remove: vi.fn() }
    })
    render(<PlatformIntegrations><div /></PlatformIntegrations>)

    await waitFor(() => expect(takeDeepLink()).toEqual({ target: '/trips/abc123', handoffId: undefined }))
    listener?.({ url: 'https://dupert.vercel.app/trips/abc123' })
    expect(takeDeepLink()).toBeUndefined()
  })

  it('removes a listener that resolves after unmount', async () => {
    let resolveListener!: (value: { remove: ReturnType<typeof vi.fn> }) => void
    const remove = vi.fn()
    appMocks.addListener.mockReturnValue(new Promise((resolve) => { resolveListener = resolve }))
    const rendered = render(<PlatformIntegrations><div /></PlatformIntegrations>)
    rendered.unmount()
    resolveListener({ remove })
    await waitFor(() => expect(remove).toHaveBeenCalledOnce())
  })
})
