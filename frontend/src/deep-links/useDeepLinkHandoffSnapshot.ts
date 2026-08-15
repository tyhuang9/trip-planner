import { useState } from 'react'
import { getDeepLinkHandoff } from './vault'

interface HandoffSnapshot {
  handoffId: string | undefined
  handoff: ReturnType<typeof getDeepLinkHandoff>
}

/**
 * Keeps one vault lookup stable for the current route identity. Ordinary page
 * rerenders cannot lose an in-use token when its vault TTL elapses, while a new
 * handoff route receives a fresh snapshot even if React Router reuses the page.
 */
export function useDeepLinkHandoffSnapshot(handoffId: string | undefined) {
  const [snapshot, setSnapshot] = useState<HandoffSnapshot>(() => ({
    handoffId,
    handoff: getDeepLinkHandoff(handoffId),
  }))
  if (snapshot.handoffId !== handoffId) {
    const nextSnapshot = {
      handoffId,
      handoff: getDeepLinkHandoff(handoffId),
    }
    setSnapshot(nextSnapshot)
    return nextSnapshot.handoff
  }
  return snapshot.handoff
}
