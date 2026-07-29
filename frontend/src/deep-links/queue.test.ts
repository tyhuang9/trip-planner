import { beforeEach, describe, expect, it, vi } from 'vitest'
import { enqueueDeepLink, takeDeepLink, __resetDeepLinkQueueForTests } from './queue'
import { consumeDeepLinkHandoff, getDeepLinkHandoff, __resetDeepLinkVaultForTests } from './vault'

beforeEach(() => {
  __resetDeepLinkQueueForTests()
  __resetDeepLinkVaultForTests()
})

describe('deep-link queue', () => {
  it('uses FIFO ordering and opaque handoffs for secrets', () => {
    enqueueDeepLink({ kind: 'share', token: 'secret-one' })
    enqueueDeepLink({ kind: 'trip', publicId: 'abc123' })
    const first = takeDeepLink()
    expect(first?.target).toMatch(/^\/link\/dl_[a-f0-9]{32}$/)
    expect(first?.target).not.toContain('secret-one')
    expect(getDeepLinkHandoff(first?.handoffId)).toEqual({ kind: 'share', token: 'secret-one' })
    expect(takeDeepLink()).toEqual({ target: '/trips/abc123', handoffId: undefined })
  })

  it('deduplicates before allocating another secret handoff', () => {
    enqueueDeepLink({ kind: 'reset-password', token: 'reset-secret' })
    enqueueDeepLink({ kind: 'reset-password', token: 'reset-secret' })
    expect(takeDeepLink()).toBeDefined()
    expect(takeDeepLink()).toBeUndefined()
  })

  it('collapses only immediate trip replays and permits a later reopen', () => {
    vi.useFakeTimers()
    enqueueDeepLink({ kind: 'trip', publicId: 'abc123' })
    expect(takeDeepLink()).toEqual({ target: '/trips/abc123', handoffId: undefined })
    enqueueDeepLink({ kind: 'trip', publicId: 'abc123' })
    expect(takeDeepLink()).toBeUndefined()
    vi.advanceTimersByTime(5_001)
    enqueueDeepLink({ kind: 'trip', publicId: 'abc123' })
    expect(takeDeepLink()).toEqual({ target: '/trips/abc123', handoffId: undefined })
    vi.useRealTimers()
  })

  it('expires queued handoffs', () => {
    vi.useFakeTimers()
    enqueueDeepLink({ kind: 'verify-email', token: 'verify-secret', returnTo: { kind: 'route', path: '/trips' } })
    vi.advanceTimersByTime(5 * 60_000 + 1)
    expect(takeDeepLink()).toBeUndefined()
    vi.useRealTimers()
  })

  it('suppresses a delayed OS replay only during the consumed tombstone window', () => {
    vi.useFakeTimers()
    const link = { kind: 'share' as const, token: 'os-replay-secret' }
    enqueueDeepLink(link)
    const first = takeDeepLink()
    consumeDeepLinkHandoff(first?.handoffId)
    enqueueDeepLink(link)
    expect(takeDeepLink()).toBeUndefined()
    vi.advanceTimersByTime(5_001)
    enqueueDeepLink(link)
    expect(takeDeepLink()?.target).toMatch(/^\/link\/dl_/)
    vi.useRealTimers()
  })
})
