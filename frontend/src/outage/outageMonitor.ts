import type { AxiosError } from 'axios'
import { backendBaseUrl } from '../api/baseUrl'

export type OutageKind = 'app' | 'database' | 'connectivity'

type Listener = (outage: OutageKind | null) => void

let outage: OutageKind | null = null
let probePromise: Promise<OutageKind | null> | null = null
const listeners = new Set<Listener>()

function healthUrl(path: string): string {
  return `${backendBaseUrl}${path}`
}

function setOutage(next: OutageKind | null): void {
  if (outage === next) return
  outage = next
  listeners.forEach((listener) => listener(outage))
}

function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

function isUp(response: Response): boolean {
  return response.ok
}

async function probeHealth(): Promise<OutageKind | null> {
  if (isOffline()) return 'connectivity'

  let liveness: Response
  try {
    liveness = await fetch(healthUrl('/actuator/health/liveness'), { cache: 'no-store' })
  } catch {
    return 'app'
  }
  if (!isUp(liveness)) return 'app'

  try {
    const database = await fetch(healthUrl('/actuator/health/database'), { cache: 'no-store' })
    return isUp(database) ? null : 'database'
  } catch {
    // Liveness succeeded, so a failed dependency probe is ambiguous. Do not
    // turn a transient CORS/proxy failure into a database incident.
    return null
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
        setOutage(result)
        return result
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
