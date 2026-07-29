import { parseDeepLink } from './policy'
import { enqueueDeepLink } from './queue'

/** Deliberately drops invalid URLs without retaining or logging their contents. */
export function captureDeepLink(rawUrl: string | undefined) {
  if (!rawUrl) return
  const link = parseDeepLink(rawUrl)
  if (link) enqueueDeepLink(link)
}
