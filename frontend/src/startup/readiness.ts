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
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1_000 : null
  const date = Date.parse(value)
  const delay = date - Date.now()
  return Number.isFinite(delay) && delay > 0 ? delay : null
}

function aborted(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

function isOffline(): boolean {
  return navigator.onLine === false
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

async function delayOrReturnOffline(ms: number, signal: AbortSignal, offline: () => boolean): Promise<StartupFailure | null> {
  try {
    await delay(ms, signal)
    return null
  } catch (error) {
    if ((error as DOMException).name === 'AbortError' && offline()) return 'offline'
    throw error
  }
}

function parseJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return Promise.reject(aborted())
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(aborted()) }
    signal.addEventListener('abort', abort, { once: true })
    response.json().then((body) => { signal.removeEventListener('abort', abort); resolve(body) }, (error) => { signal.removeEventListener('abort', abort); reject(error) })
  })
}

async function request(path: string, timeout: number, signal: AbortSignal): Promise<{ response: Response; body: unknown }> {
  if (signal.aborted) throw aborted()
  if (timeout <= 0) throw new DOMException('Deadline elapsed', 'TimeoutError')

  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = window.setTimeout(abort, timeout)
  signal.addEventListener('abort', abort, { once: true })
  try {
    // Keep both the timeout and parent relationship until the body is fully
    // consumed. A response with stalled JSON is not a completed readiness
    // probe, and must remain cancellable when the boundary unmounts.
    const response = await fetch(`${backendBaseUrl}${path}`, { cache: 'no-store', signal: controller.signal })
    let body: unknown
    try { body = await parseJson(response, controller.signal) } catch (error) {
      if ((error as DOMException).name === 'AbortError') throw error
      body = null
    }
    return { response, body }
  } finally {
    window.clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

async function waitForUp(path: string, deadlineMs: number, intervalMs: number, timeoutMs: number, signal: AbortSignal): Promise<StartupFailure | null> {
  const deadline = Date.now() + deadlineMs
  const runController = new AbortController()
  let wentOffline = false
  const abortFromParent = () => runController.abort()
  const abortForOffline = () => {
    wentOffline = true
    runController.abort()
  }
  signal.addEventListener('abort', abortFromParent, { once: true })
  window.addEventListener('offline', abortForOffline, { once: true })
  if (signal.aborted) abortFromParent()
  try {
    while (Date.now() < deadline) {
      if (wentOffline || isOffline()) return 'offline'
      let result: { response: Response; body: unknown } | undefined
      try {
        const remaining = deadline - Date.now()
        if (remaining <= 0) break
        result = await request(path, Math.min(timeoutMs, remaining), runController.signal)
      } catch (error) {
        if ((error as DOMException).name === 'AbortError') {
          if (wentOffline || isOffline()) return 'offline'
          if (signal.aborted) throw error
        }
        const remainingAfterError = deadline - Date.now()
        if (remainingAfterError <= 0) break
        const retry = await delayOrReturnOffline(Math.min(intervalMs, remainingAfterError), runController.signal, () => wentOffline || isOffline())
        if (retry) return retry
        continue
      }

      if (!result) continue
      const { response, body } = result
      if (response.ok && typeof body === 'object' && body !== null && 'status' in body && body.status === 'UP') return null
      const wait = response.status === 429 ? retryAfterMs(response) ?? intervalMs : intervalMs
      const remainingAfterResponse = deadline - Date.now()
      if (remainingAfterResponse <= 0) break
      const retry = await delayOrReturnOffline(Math.min(wait, remainingAfterResponse), runController.signal, () => wentOffline || isOffline())
      if (retry) return retry
    }
    return 'timeout'
  } finally {
    signal.removeEventListener('abort', abortFromParent)
    window.removeEventListener('offline', abortForOffline)
  }
}

export async function waitForReadiness(signal: AbortSignal, onPhase: (phase: StartupPhase) => void): Promise<StartupFailure | null> {
  onPhase('liveness')
  const liveness = await waitForUp('/actuator/health/liveness', LIVENESS_DEADLINE_MS, LIVENESS_RETRY_MS, LIVENESS_TIMEOUT_MS, signal)
  if (liveness) return liveness
  onPhase('database')
  return waitForUp('/actuator/health/database', DATABASE_DEADLINE_MS, DATABASE_POLL_MS, DATABASE_POLL_MS, signal)
}
