export const PENDING_LOGOUT_STORAGE_KEY = 'dupert.auth.pending-logout.v1'
export const PENDING_LOGOUT_CHANGED_EVENT = 'dupert:pending-logout-changed'

interface PendingLogoutIntent {
  version: 1
  createdAt: number
}

let memoryFallback: PendingLogoutIntent | null = null
let memoryFallbackIsOnlyCopy = false

export type PendingLogoutPersistence = 'durable' | 'memory-only'

function getStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function notifyChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(PENDING_LOGOUT_CHANGED_EVENT))
  }
}

/**
 * Reads only logout intent metadata. Unknown or malformed stored values are
 * treated conservatively as pending so a corrupted marker cannot restore a
 * session the user asked to revoke.
 */
export function getPendingLogoutIntent(): PendingLogoutIntent | null {
  const storage = getStorage()
  if (storage === null) return memoryFallback

  let raw: string | null
  try {
    raw = storage.getItem(PENDING_LOGOUT_STORAGE_KEY)
  } catch {
    return memoryFallback
  }
  if (raw === null) {
    if (memoryFallbackIsOnlyCopy) return memoryFallback
    memoryFallback = null
    return null
  }

  try {
    const parsed = JSON.parse(raw) as Partial<PendingLogoutIntent>
    if (
      parsed.version === 1 &&
      typeof parsed.createdAt === 'number' &&
      Number.isFinite(parsed.createdAt)
    ) {
      const intent = { version: 1 as const, createdAt: parsed.createdAt }
      memoryFallback = intent
      memoryFallbackIsOnlyCopy = false
      return intent
    }
  } catch {
    // Fall through to the conservative marker below.
  }
  const conservativeIntent = { version: 1 as const, createdAt: 0 }
  memoryFallback = conservativeIntent
  memoryFallbackIsOnlyCopy = false
  return conservativeIntent
}

export function hasPendingLogoutIntent(): boolean {
  return getPendingLogoutIntent() !== null
}

/**
 * Persists no credential material, only the fact that revocation is owed.
 * The return value lets the UI distinguish reload-safe intent from the
 * running-app-only fallback used when web storage is unavailable.
 */
export function persistPendingLogoutIntent(): PendingLogoutPersistence {
  const intent: PendingLogoutIntent = { version: 1, createdAt: Date.now() }
  memoryFallback = intent
  memoryFallbackIsOnlyCopy = true
  try {
    const storage = getStorage()
    if (storage !== null) {
      storage.setItem(PENDING_LOGOUT_STORAGE_KEY, JSON.stringify(intent))
      if (storage.getItem(PENDING_LOGOUT_STORAGE_KEY) !== null) {
        memoryFallbackIsOnlyCopy = false
      }
    }
  } catch {
    // The in-memory fallback still protects this running app. The UI makes
    // this degraded, non-reload-safe state explicit until revocation succeeds.
  }
  notifyChanged()
  return memoryFallbackIsOnlyCopy ? 'memory-only' : 'durable'
}

export function getPendingLogoutPersistence(): PendingLogoutPersistence | null {
  return getPendingLogoutIntent() === null
    ? null
    : memoryFallbackIsOnlyCopy
      ? 'memory-only'
      : 'durable'
}

export function clearPendingLogoutIntent(): boolean {
  let removed: boolean
  try {
    const storage = getStorage()
    storage?.removeItem(PENDING_LOGOUT_STORAGE_KEY)
    removed = storage === null || storage.getItem(PENDING_LOGOUT_STORAGE_KEY) === null
  } catch {
    removed = false
  }
  memoryFallback = removed
    ? null
    : memoryFallback ?? { version: 1, createdAt: 0 }
  memoryFallbackIsOnlyCopy = !removed
  if (removed) notifyChanged()
  return removed
}
