import type { AxiosError } from 'axios'
import { backendBaseUrl } from '../api/baseUrl'

export type OutageKind =
  | 'server'
  | 'server-unreachable'
  | 'database'
  | 'connectivity'

type ProbeResult = OutageKind | null | undefined

type Listener = (outage: OutageKind | null) => void

let outage: OutageKind | null = null
let probePromise: Promise<OutageKind | null> | null = null
const listeners = new Set<Listener>()

export const HEALTH_PROBE_TIMEOUT_MS = 10_000

function healthUrl(path: string): string {
  return `${backendBaseUrl}${path}`
}

function setOutage(next: OutageKind | null): void {
  if (outage === next && next === null) return
  outage = next
  listeners.forEach((listener) => listener(outage))
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

async function fetchHealth(path: string): Promise<Response> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), HEALTH_PROBE_TIMEOUT_MS)
  try {
    return await fetch(healthUrl(path), {
      cache: 'no-store',
      signal: controller.signal,
    })
  } finally {
    window.clearTimeout(timeout)
  }
}

async function probeHealth(): Promise<ProbeResult> {
  if (isOffline()) return 'connectivity'

  let liveness: Response
  try {
    liveness = await fetchHealth('/actuator/health/liveness')
  } catch {
    return 'server-unreachable'
  }
  if (liveness.status >= 500 && liveness.status < 600) return 'server'
  if (!liveness.ok) return 'server-unreachable'

  try {
    const database = await fetchHealth('/actuator/health/database')
    if (database.status === 503) return 'database'
    return database.ok ? null : undefined
  } catch {
    return undefined
  }
}

export function reportAmbiguousBackendFailure(error?: AxiosError): void {
  const status = error?.response?.status
  if (status !== undefined && status < 500) return
  void checkHealth()
}

export function checkHealth(): Promise<OutageKind | null> {
  if (probePromise === null) {
    probePromise = probeHealth()
      .then((result) => {
        // An indeterminate database probe fails open on first detection and
        // preserves an already-visible incident during a manual retry.
        if (result !== undefined) setOutage(result)
        return result === undefined ? outage : result
      })
      .finally(() => {
        probePromise = null
      })
  }
  return probePromise
}

export function subscribeToOutage(listener: Listener): () => void {
  listeners.add(listener)
  listener(outage)
  return () => listeners.delete(listener)
}

export function __resetOutageMonitorForTests(): void {
  outage = null
  probePromise = null
  listeners.clear()
}
