import { deepLinkTarget, type DeepLink } from './policy'
import { clearDeepLinkHandoff, findDeepLinkHandoff, putDeepLinkHandoff } from './vault'

const TTL_MS = 5 * 60_000
const TRIP_REPLAY_DEDUPE_MS = 5_000
const CAPACITY = 16
export type QueuedDeepLink = { target: string; handoffId?: string }
let pending: Array<QueuedDeepLink & { key: string; expiresAt: number }> = []
let recentTripTargets = new Map<string, number>()
let listeners = new Set<() => void>()

function prune() {
  const now = Date.now()
  pending = pending.filter((entry) => {
    if (entry.expiresAt > now) return true
    clearDeepLinkHandoff(entry.handoffId)
    return false
  })
  for (const [target, expiresAt] of recentTripTargets) if (expiresAt <= now) recentTripTargets.delete(target)
}

export function enqueueDeepLink(link: DeepLink) {
  prune()
  if (link.kind !== 'trip' && findDeepLinkHandoff(link)) return
  if (link.kind === 'trip' && recentTripTargets.has(deepLinkTarget(link))) return
  const handoffId = link.kind === 'trip' ? undefined : putDeepLinkHandoff(link)
  const target = link.kind === 'trip' ? deepLinkTarget(link) : `${deepLinkTarget(link)}/${handoffId}`
  const key = handoffId ?? target
  if (pending.some((entry) => entry.key === key)) return
  if (link.kind === 'trip') {
    recentTripTargets.set(target, Date.now() + TRIP_REPLAY_DEDUPE_MS)
    while (recentTripTargets.size > CAPACITY) {
      const oldestTarget = recentTripTargets.keys().next().value
      if (oldestTarget) recentTripTargets.delete(oldestTarget)
    }
  }
  pending.push({
    target,
    handoffId,
    key,
    expiresAt: Date.now() + TTL_MS,
  })
  while (pending.length > CAPACITY) clearDeepLinkHandoff(pending.shift()?.handoffId)
  listeners.forEach((listener) => listener())
}

export function takeDeepLink() {
  prune()
  const entry = pending.shift()
  return entry ? { target: entry.target, handoffId: entry.handoffId } : undefined
}

export function subscribeToDeepLinks(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function __resetDeepLinkQueueForTests() {
  pending = []
  recentTripTargets = new Map()
  listeners = new Set()
}
