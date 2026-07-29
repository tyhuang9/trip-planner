import type { DeepLink } from './policy'

const TTL_MS = 10 * 60_000
const CONSUMED_TTL_MS = 5_000
const CAPACITY = 16
const handoffs = new Map<string, { link: Exclude<DeepLink, { kind: 'trip' }>; expiresAt: number }>()
const handoffIdsByLink = new Map<string, string>()
let listeners = new Set<() => void>()
const consumedHandoffs = new Map<string, { id: string; expiresAt: number }>()

function handoffId(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return `dl_${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`
}

export function putDeepLinkHandoff(link: Exclude<DeepLink, { kind: 'trip' }>): string {
  pruneDeepLinkHandoffs()
  const key = JSON.stringify(link)
  const existing = handoffIdsByLink.get(key)
  if (existing && handoffs.has(existing)) return existing
  const id = handoffId()
  handoffs.set(id, { link, expiresAt: Date.now() + TTL_MS })
  handoffIdsByLink.set(JSON.stringify(link), id)
  while (handoffs.size > CAPACITY) clearDeepLinkHandoff(handoffs.keys().next().value)
  listeners.forEach((listener) => listener())
  return id
}

/** Raw secret comparison is intentionally confined to this memory-only vault. */
export function findDeepLinkHandoff(link: Exclude<DeepLink, { kind: 'trip' }>) {
  pruneDeepLinkHandoffs()
  const key = JSON.stringify(link)
  return handoffIdsByLink.get(key)
}

export function wasDeepLinkRecentlyConsumed(link: Exclude<DeepLink, { kind: 'trip' }>) {
  pruneDeepLinkHandoffs()
  return consumedHandoffs.has(JSON.stringify(link))
}

export function getDeepLinkHandoff(id: string | undefined) {
  if (!id) return undefined
  const handoff = handoffs.get(id)
  if (!handoff || handoff.expiresAt <= Date.now()) {
    clearDeepLinkHandoff(id)
    return undefined
  }
  return handoff.link
}

export function clearDeepLinkHandoff(id: string | undefined) {
  if (!id) return
  const handoff = handoffs.get(id)
  if (handoff) handoffIdsByLink.delete(JSON.stringify(handoff.link))
  handoffs.delete(id)
  listeners.forEach((listener) => listener())
}

export function consumeDeepLinkHandoff(id: string | undefined) {
  if (!id) return
  const handoff = handoffs.get(id)
  if (!handoff) return
  const key = JSON.stringify(handoff.link)
  handoffIdsByLink.delete(key)
  handoffs.delete(id)
  consumedHandoffs.set(key, { id, expiresAt: Date.now() + CONSUMED_TTL_MS })
  while (consumedHandoffs.size > CAPACITY) {
    const oldest = consumedHandoffs.keys().next().value
    if (oldest) consumedHandoffs.delete(oldest)
  }
  listeners.forEach((listener) => listener())
}

export function pruneDeepLinkHandoffs() {
  const now = Date.now()
  for (const [id, handoff] of handoffs) if (handoff.expiresAt <= now) clearDeepLinkHandoff(id)
  for (const [key, consumed] of consumedHandoffs) if (consumed.expiresAt <= now) consumedHandoffs.delete(key)
}

export function subscribeToDeepLinkVault(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function __resetDeepLinkVaultForTests() {
  handoffs.clear()
  handoffIdsByLink.clear()
  consumedHandoffs.clear()
  listeners = new Set()
}
