import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetOutageMonitorForTests,
  checkHealth,
  checkStartupHealth,
  HEALTH_PROBE_TIMEOUT_MS,
  reportAmbiguousBackendFailure,
  subscribeToOutage,
} from './outageMonitor'

function response(status: number) {
  return new Response(null, { status })
}

afterEach(() => {
  __resetOutageMonitorForTests()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  Reflect.deleteProperty(navigator, 'onLine')
})

describe('outage monitoring', () => {
  it('probes liveness and database concurrently during startup', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(503))
    vi.stubGlobal('fetch', fetchMock)

    await expect(checkStartupHealth()).resolves.toBe('database')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[0][0]).toContain('/actuator/health/liveness')
    expect(fetchMock.mock.calls[1][0]).toContain('/actuator/health/database')
    expect(fetchMock.mock.calls[0][1].signal).toBe(fetchMock.mock.calls[1][1].signal)
  })

  it('returns healthy only when both probes are healthy', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(200)))

    await expect(checkHealth()).resolves.toBeNull()
  })

  it('classifies liveness 5xx as a server outage', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(503)))

    await expect(checkHealth()).resolves.toBe('server')
  })

  it('classifies unreachable liveness as server-unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockRejectedValueOnce(new TypeError('network'))
      .mockRejectedValueOnce(new TypeError('network')))

    await expect(checkHealth()).resolves.toBe('server-unreachable')
  })

  it('classifies a database timeout after healthy liveness', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200))
      .mockImplementationOnce((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        const signal = init.signal as AbortSignal
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      }))
    vi.stubGlobal('fetch', fetchMock)

    const probe = checkHealth()
    await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS)

    await expect(probe).resolves.toBe('database')
  })

  it('classifies an unexpected database response after healthy liveness as database', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(429)))

    await expect(checkHealth()).resolves.toBe('database')
  })

  it('classifies an offline browser as connectivity without probing', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(checkHealth()).resolves.toBe('connectivity')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shares one dual probe across concurrent startup and runtime checks', async () => {
    const resolveProbes: Array<(value: Response) => void> = []
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => {
      resolveProbes.push(resolve)
    }))
    vi.stubGlobal('fetch', fetchMock)

    const startup = checkStartupHealth()
    const runtime = checkHealth()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    resolveProbes.forEach((resolve) => resolve(response(200)))

    await expect(Promise.all([startup, runtime])).resolves.toEqual([null, null])
  })

  it('publishes a changed diagnosis to subscribers', async () => {
    const listener = vi.fn()
    subscribeToOutage(listener)
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(503)))

    await checkHealth()

    expect(listener).toHaveBeenNthCalledWith(1, null)
    expect(listener).toHaveBeenLastCalledWith('database')
  })

  it('probes after an Axios server or network failure', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(503))
    vi.stubGlobal('fetch', fetchMock)

    reportAmbiguousBackendFailure({ isAxiosError: true, response: { status: 500 } })
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
  })

  it('does not promote client errors or non-Axios failures into outage probes', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    reportAmbiguousBackendFailure({ isAxiosError: true, response: { status: 422 } })
    reportAmbiguousBackendFailure(new Error('local state changed'))

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('resets the shared probe after completion so recovery can be detected', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(200))
    vi.stubGlobal('fetch', fetchMock)

    await expect(checkHealth()).resolves.toBe('server')
    await expect(checkHealth()).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})
