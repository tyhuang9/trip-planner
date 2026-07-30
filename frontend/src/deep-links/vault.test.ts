import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetDeepLinkVaultForTests, clearDeepLinkHandoff, consumeDeepLinkHandoff, findDeepLinkHandoff, getDeepLinkHandoff, putDeepLinkHandoff, subscribeToDeepLinkVault, wasDeepLinkRecentlyConsumed } from './vault'

beforeEach(() => __resetDeepLinkVaultForTests())

describe('deep-link vault', () => {
  it('deduplicates secret links without exposing a token in the handoff id', () => {
    const first = putDeepLinkHandoff({ kind: 'share', token: 'secret-token' })
    expect(putDeepLinkHandoff({ kind: 'share', token: 'secret-token' })).toBe(first)
    expect(first).not.toContain('secret-token')
    expect(findDeepLinkHandoff({ kind: 'share', token: 'secret-token' })).toBe(first)
  })

  it('expires entries and bounds memory to the newest sixteen handoffs', () => {
    vi.useFakeTimers()
    const ids = Array.from({ length: 17 }, (_, index) => putDeepLinkHandoff({ kind: 'share', token: `secret-${index}` }))
    expect(getDeepLinkHandoff(ids[0])).toBeUndefined()
    expect(getDeepLinkHandoff(ids[16])).toEqual({ kind: 'share', token: 'secret-16' })
    vi.advanceTimersByTime(10 * 60_000 + 1)
    expect(getDeepLinkHandoff(ids[16])).toBeUndefined()
    expect(findDeepLinkHandoff({ kind: 'share', token: 'secret-16' })).toBeUndefined()
    const renewed = putDeepLinkHandoff({ kind: 'share', token: 'secret-16' })
    expect(renewed).not.toBe(ids[16])
    expect(getDeepLinkHandoff(renewed)).toEqual({ kind: 'share', token: 'secret-16' })
    vi.useRealTimers()
  })

  it('notifies subscribers for clears and expiry, and honors unsubscribe', () => {
    vi.useFakeTimers()
    const listener = vi.fn()
    const unsubscribe = subscribeToDeepLinkVault(listener)
    const id = putDeepLinkHandoff({ kind: 'share', token: 'secret-token' })
    clearDeepLinkHandoff(id)
    expect(listener).toHaveBeenCalledTimes(2)
    const expiringId = putDeepLinkHandoff({ kind: 'share', token: 'expiring-token' })
    vi.advanceTimersByTime(10 * 60_000 + 1)
    getDeepLinkHandoff(expiringId)
    expect(listener).toHaveBeenCalledTimes(4)
    unsubscribe()
    putDeepLinkHandoff({ kind: 'share', token: 'after-unsubscribe' })
    expect(listener).toHaveBeenCalledTimes(4)
    vi.useRealTimers()
  })

  it('tracks successful consumption without blocking a direct web handoff', () => {
    vi.useFakeTimers()
    const link = { kind: 'share' as const, token: 'consumed-secret' }
    const first = putDeepLinkHandoff(link)
    consumeDeepLinkHandoff(first)
    expect(getDeepLinkHandoff(first)).toBeUndefined()
    expect(wasDeepLinkRecentlyConsumed(link)).toBe(true)
    const direct = putDeepLinkHandoff(link)
    expect(direct).not.toBe(first)
    expect(getDeepLinkHandoff(direct)).toEqual(link)
    vi.advanceTimersByTime(5_001)
    expect(wasDeepLinkRecentlyConsumed(link)).toBe(false)
    vi.useRealTimers()
  })

  it('does not tombstone an ordinary clear used after a retryable failure', () => {
    const link = { kind: 'reset-password' as const, token: 'retry-secret' }
    const first = putDeepLinkHandoff(link)
    clearDeepLinkHandoff(first)
    const retry = putDeepLinkHandoff(link)
    expect(retry).not.toBe(first)
    expect(getDeepLinkHandoff(retry)).toEqual(link)
  })
})
