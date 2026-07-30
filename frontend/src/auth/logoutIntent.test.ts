import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearPendingLogoutIntent,
  getPendingLogoutIntent,
  getPendingLogoutPersistence,
  hasPendingLogoutIntent,
  PENDING_LOGOUT_STORAGE_KEY,
  persistPendingLogoutIntent,
  subscribePendingLogoutIntent,
} from './logoutIntent'

beforeEach(() => {
  localStorage.clear()
  clearPendingLogoutIntent()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('pending logout intent', () => {
  it('persists only versioned revocation metadata', () => {
    persistPendingLogoutIntent()

    expect(hasPendingLogoutIntent()).toBe(true)
    expect(getPendingLogoutIntent()).toEqual({
      version: 1,
      createdAt: expect.any(Number),
    })
    const raw = localStorage.getItem(PENDING_LOGOUT_STORAGE_KEY)
    expect(raw).not.toContain('token')
    expect(raw).not.toContain('cookie')
    expect(raw).not.toContain('email')
  })

  it('treats a malformed stored marker conservatively as pending', () => {
    localStorage.setItem(PENDING_LOGOUT_STORAGE_KEY, '{not-json')

    expect(getPendingLogoutIntent()).toEqual({ version: 1, createdAt: 0 })
    expect(hasPendingLogoutIntent()).toBe(true)
  })

  it('clears the marker only after revocation is confirmed', () => {
    persistPendingLogoutIntent()

    expect(clearPendingLogoutIntent()).toBe(true)
    expect(hasPendingLogoutIntent()).toBe(false)
    expect(localStorage.getItem(PENDING_LOGOUT_STORAGE_KEY)).toBeNull()
  })

  it('observes a marker cleared by another browser context', () => {
    persistPendingLogoutIntent()
    localStorage.removeItem(PENDING_LOGOUT_STORAGE_KEY)

    expect(hasPendingLogoutIntent()).toBe(false)
  })

  it('reports when storage failure leaves only a running-app fallback', () => {
    vi.spyOn(Object.getPrototypeOf(localStorage), 'setItem').mockImplementation(() => {
      throw new DOMException('Storage quota exceeded', 'QuotaExceededError')
    })

    expect(persistPendingLogoutIntent()).toBe('memory-only')
    expect(hasPendingLogoutIntent()).toBe(true)
    expect(getPendingLogoutPersistence()).toBe('memory-only')
    expect(localStorage.getItem(PENDING_LOGOUT_STORAGE_KEY)).toBeNull()
  })

  it('keeps a durable snapshot when storage refuses to remove its marker', () => {
    persistPendingLogoutIntent()
    const listener = vi.fn()
    const unsubscribe = subscribePendingLogoutIntent(listener)
    vi.spyOn(Object.getPrototypeOf(localStorage), 'removeItem').mockImplementation(() => {
      throw new DOMException('Storage blocked', 'SecurityError')
    })

    expect(clearPendingLogoutIntent()).toBe(false)
    expect(hasPendingLogoutIntent()).toBe(true)
    expect(getPendingLogoutPersistence()).toBe('durable')
    expect(localStorage.getItem(PENDING_LOGOUT_STORAGE_KEY)).not.toBeNull()
    expect(listener).toHaveBeenCalledOnce()

    unsubscribe()
  })

  it('notifies same-context subscribers when pending logout changes', () => {
    const listener = vi.fn()
    const unsubscribe = subscribePendingLogoutIntent(listener)

    persistPendingLogoutIntent()
    expect(listener).toHaveBeenCalledTimes(1)

    clearPendingLogoutIntent()
    expect(listener).toHaveBeenCalledTimes(2)

    unsubscribe()
    persistPendingLogoutIntent()
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('subscribes to only the pending-logout key from another context', () => {
    const listener = vi.fn()
    const unsubscribe = subscribePendingLogoutIntent(listener)

    window.dispatchEvent(new StorageEvent('storage', { key: 'unrelated' }))
    expect(listener).not.toHaveBeenCalled()

    window.dispatchEvent(new StorageEvent('storage', {
      key: PENDING_LOGOUT_STORAGE_KEY,
    }))
    expect(listener).toHaveBeenCalledOnce()

    unsubscribe()
  })
})
