import { beforeEach, describe, expect, it, vi } from 'vitest'
import { __resetDeepLinkVaultForTests, findDeepLinkHandoff, getDeepLinkHandoff, putDeepLinkHandoff } from './vault'

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
})
