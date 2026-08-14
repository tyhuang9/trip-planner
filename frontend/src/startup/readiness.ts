import { backendBaseUrl } from '../api/baseUrl'

export const LIVENESS_DEADLINE_MS = 90_000
export const LIVENESS_TIMEOUT_MS = 10_000
export const LIVENESS_RETRY_MS = 3_000
export const DATABASE_DEADLINE_MS = 30_000
export const DATABASE_POLL_MS = 6_000
export type StartupPhase = 'liveness' | 'database' | 'session'
export type StartupFailure = 'offline' | 'timeout'

function retryAfterMs(response: Response): number | null {
  const value = response.headers.get('Retry-After')?.trim()
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null
}

function aborted(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(aborted())

  return new Promise((resolve, reject) => {
    const settle = (callback: () => void) => {
      signal.removeEventListener('abort', abort)
      callback()
    }
    const timer = window.setTimeout(() => settle(resolve), ms)
    const abort = () => {
      window.clearTimeout(timer)
      settle(() => reject(aborted()))
    }
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function request(path: string, timeout: number, signal: AbortSignal) {
  if (signal.aborted) throw aborted()
  if (timeout <= 0) throw new DOMException('Deadline elapsed', 'TimeoutError')

  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = window.setTimeout(abort, timeout)
  signal.addEventListener('abort', abort, { once: true })
  try {
    return await fetch(`${backendBaseUrl}${path}`, { cache: 'no-store', signal: controller.signal })
  } finally {
    window.clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

async function waitForUp(path: string, deadlineMs: number, intervalMs: number, timeoutMs: number, signal: AbortSignal): Promise<StartupFailure | null> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (navigator.onLine === false) return 'offline'
    try {
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      const response = await request(path, Math.min(timeoutMs, remaining), signal)
      let body: unknown
      try { body = await response.json() } catch { body = null }
      if (response.ok && typeof body === 'object' && body !== null && 'status' in body && body.status === 'UP') return null
      const wait = response.status === 429 ? retryAfterMs(response) ?? intervalMs : intervalMs
      const remainingAfterResponse = deadline - Date.now()
      if (remainingAfterResponse <= 0) break
      await delay(Math.min(wait, remainingAfterResponse), signal)
    } catch (error) {
      if ((error as DOMException).name === 'AbortError' && signal.aborted) throw error
      const remainingAfterError = deadline - Date.now()
      if (remainingAfterError <= 0) break
      await delay(Math.min(intervalMs, remainingAfterError), signal)
    }
  }
  return 'timeout'
}

export async function waitForReadiness(signal: AbortSignal, onPhase: (phase: StartupPhase) => void): Promise<StartupFailure | null> {
  onPhase('liveness')
  const liveness = await waitForUp('/actuator/health/liveness', LIVENESS_DEADLINE_MS, LIVENESS_RETRY_MS, LIVENESS_TIMEOUT_MS, signal)
  if (liveness) return liveness
  onPhase('database')
  return waitForUp('/actuator/health/database', DATABASE_DEADLINE_MS, DATABASE_POLL_MS, DATABASE_POLL_MS, signal)
}
