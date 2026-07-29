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
let normalProbePromise: Promise<OutageKind | null> | null = null
let startupProbePromise: Promise<OutageKind | null> | null = null
let normalProbeGeneration = 0
const listeners = new Set<Listener>()

export const HEALTH_PROBE_TIMEOUT_MS = 10_000
export const STARTUP_HEALTH_PROBE_TIMEOUT_MS = 3_000

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

async function fetchHealth(path: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(healthUrl(path), {
      cache: 'no-store',
      signal: controller.signal,
    })
  } finally {
    window.clearTimeout(timeout)
  }
}

async function probeLiveness(timeoutMs: number): Promise<OutageKind | null> {
  if (isOffline()) return 'connectivity'

  let liveness: Response
  try {
    liveness = await fetchHealth('/actuator/health/liveness', timeoutMs)
  } catch {
    return 'server-unreachable'
  }
  if (liveness.status >= 500 && liveness.status < 600) return 'server'
  if (!liveness.ok) return 'server-unreachable'

  return null
}

async function probeHealth(timeoutMs: number): Promise<ProbeResult> {
  const deadline = Date.now() + timeoutMs
  const livenessResult = await probeLiveness(timeoutMs)
  if (livenessResult !== null) return livenessResult

  const remainingMs = deadline - Date.now()
  if (remainingMs <= 0) return undefined

  try {
    const database = await fetchHealth('/actuator/health/database', remainingMs)
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

function checkHealthWithTimeout(timeoutMs: number, startup: boolean): Promise<OutageKind | null> {
  const activeProbe = startup ? startupProbePromise : normalProbePromise
  if (activeProbe === null) {
    const normalWasInFlight = startup && normalProbePromise !== null
    const probeGeneration = startup ? normalProbeGeneration : ++normalProbeGeneration
    // Startup intentionally checks liveness only; database diagnosis stays on
    // the normal API-failure path so cold starts make one short request.
    const probe = (startup ? probeLiveness : probeHealth)(timeoutMs)
      .then((result) => {
        // An indeterminate database probe fails open on first detection and
        // preserves an already-visible incident during a manual retry.
        if (
          result !== undefined
          && (!startup || result !== null)
          && (!startup || (!normalWasInFlight && probeGeneration === normalProbeGeneration))
        ) {
          setOutage(result)
        }
        return result === undefined ? outage : result
      })
      .finally(() => {
        if (startup) startupProbePromise = null
        else normalProbePromise = null
      })
    if (startup) startupProbePromise = probe
    else normalProbePromise = probe
    return probe
  }
  return activeProbe
}

export function checkHealth(): Promise<OutageKind | null> {
  return checkHealthWithTimeout(HEALTH_PROBE_TIMEOUT_MS, false)
}

export function checkStartupHealth(): Promise<OutageKind | null> {
  return checkHealthWithTimeout(STARTUP_HEALTH_PROBE_TIMEOUT_MS, true)
}

export function subscribeToOutage(listener: Listener): () => void {
  listeners.add(listener)
  listener(outage)
  return () => listeners.delete(listener)
}

export function __resetOutageMonitorForTests(): void {
  outage = null
  normalProbePromise = null
  startupProbePromise = null
  normalProbeGeneration = 0
  listeners.clear()
}
