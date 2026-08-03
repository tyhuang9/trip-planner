import axios from 'axios'
import { backendBaseUrl } from '../api/baseUrl'

export type OutageKind =
  | 'server'
  | 'server-unreachable'
  | 'database'
  | 'connectivity'

type ProbeResult = OutageKind | null

type Listener = (outage: OutageKind | null) => void

let outage: OutageKind | null = null
let healthProbePromise: Promise<OutageKind | null> | null = null
const listeners = new Set<Listener>()

export const HEALTH_PROBE_TIMEOUT_MS = 1_500

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

function fetchHealth(path: string, signal: AbortSignal): Promise<Response> {
  return fetch(healthUrl(path), {
    cache: 'no-store',
    signal,
  })
}

async function probeHealth(timeoutMs: number): Promise<ProbeResult> {
  if (isOffline()) return 'connectivity'

  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const [livenessResult, databaseResult] = await Promise.allSettled([
      fetchHealth('/actuator/health/liveness', controller.signal),
      fetchHealth('/actuator/health/database', controller.signal),
    ])

    if (livenessResult.status === 'rejected') return 'server-unreachable'
    const liveness = livenessResult.value
    if (liveness.status >= 500 && liveness.status < 600) return 'server'
    if (!liveness.ok) return 'server-unreachable'

    // A healthy liveness response proves the server is reachable. The database
    // endpoint can still lose the race to our shorter client deadline while its
    // pool waits for a connection, so a rejected probe is a database outage.
    if (databaseResult.status === 'rejected') return 'database'
    const database = databaseResult.value
    if (database.status === 503) return 'database'
    return database.ok ? null : 'database'
  } finally {
    window.clearTimeout(timeout)
  }
}

export function reportAmbiguousBackendFailure(error?: unknown): void {
  if (error !== undefined) {
    if (!axios.isAxiosError(error)) return
    const status = error.response?.status
    if (status !== undefined && status < 500) return
  }
  void checkHealth()
}

export function checkHealth(): Promise<OutageKind | null> {
  if (healthProbePromise === null) {
    healthProbePromise = probeHealth(HEALTH_PROBE_TIMEOUT_MS)
      .then((result) => {
        setOutage(result)
        return result
      })
      .finally(() => {
        healthProbePromise = null
      })
  }
  return healthProbePromise
}

export function checkStartupHealth(): Promise<OutageKind | null> {
  return checkHealth()
}

export function subscribeToOutage(listener: Listener): () => void {
  listeners.add(listener)
  listener(outage)
  return () => listeners.delete(listener)
}

export function __resetOutageMonitorForTests(): void {
  outage = null
  healthProbePromise = null
  listeners.clear()
}
