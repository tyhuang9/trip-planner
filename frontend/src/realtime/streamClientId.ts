import { platformRuntime } from '../platform/runtime'

const STORAGE_KEY = 'dupert.trip-stream-client.v1'
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._~-]{16,64}$/

let memoryClientId: string | null = null

export function getOrCreateStreamClientId(): string {
  const storage = streamClientStorage()
  const stored = readStoredClientId(storage)
  if (stored) return stored
  if (memoryClientId && CLIENT_ID_PATTERN.test(memoryClientId)) return memoryClientId

  const clientId = createClientId()
  memoryClientId = clientId
  try {
    storage?.setItem(STORAGE_KEY, clientId)
  } catch {
    // Storage can be unavailable in hardened/private browser contexts. The
    // in-memory identity still deduplicates this mounted application session.
  }
  return clientId
}

function streamClientStorage(): Storage | null {
  if (typeof window === 'undefined') return null
  try {
    return platformRuntime.target === 'native' ? window.localStorage : window.sessionStorage
  } catch {
    return null
  }
}

function readStoredClientId(storage: Storage | null): string | null {
  try {
    const value = storage?.getItem(STORAGE_KEY) ?? null
    return value && CLIENT_ID_PATTERN.test(value) ? value : null
  } catch {
    return null
  }
}

function createClientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = crypto.getRandomValues(new Uint8Array(16))
    const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }

  return `stream-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`
}
