import type { DeepLink } from './policy'

const TTL_MS = 10 * 60_000
const CAPACITY = 16
const handoffs = new Map<string, { link: Exclude<DeepLink, { kind: 'trip' }>; expiresAt: number }>()
const handoffIdsByLink = new Map<string, string>()
let listeners = new Set<() => void>()

function handoffId(): string {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return `dl_${Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')}`
}

export function putDeepLinkHandoff(link: Exclude<DeepLink, { kind: 'trip' }>): string {
  pruneDeepLinkHandoffs()
  const existing = handoffIdsByLink.get(JSON.stringify(link))
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
  return handoffIdsByLink.get(JSON.stringify(link))
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

export function pruneDeepLinkHandoffs() {
  const now = Date.now()
  for (const [id, handoff] of handoffs) if (handoff.expiresAt <= now) clearDeepLinkHandoff(id)
}

export function subscribeToDeepLinkVault(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function __resetDeepLinkVaultForTests() {
  handoffs.clear()
  handoffIdsByLink.clear()
  listeners = new Set()
}
