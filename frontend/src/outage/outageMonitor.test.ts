import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetOutageMonitorForTests,
  checkHealth,
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
  it('uses a cautious server diagnosis when online liveness cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')))

    await expect(checkHealth()).resolves.toBe('server-unreachable')
  })

  it('classifies an offline browser as connectivity without probing', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(checkHealth()).resolves.toBe('connectivity')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the definitive server diagnosis only for an explicit liveness 5xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(503)))

    await expect(checkHealth()).resolves.toBe('server')
  })

  it('uses the cautious server diagnosis for an unexpected liveness status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(404)))

    await expect(checkHealth()).resolves.toBe('server-unreachable')
  })

  it('identifies a database outage only from a 503 after healthy liveness', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(200)).mockResolvedValueOnce(response(503))
    vi.stubGlobal('fetch', fetchMock)

    await expect(checkHealth()).resolves.toBe('database')
    expect(fetchMock.mock.calls[0][0]).toContain('/actuator/health/liveness')
    expect(fetchMock.mock.calls[1][0]).toContain('/actuator/health/database')
  })

  it('fails open when both dedicated probes are healthy after an API 500', async () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToOutage(listener)
    const fetchMock = vi.fn().mockResolvedValue(response(200))
    vi.stubGlobal('fetch', fetchMock)

    reportAmbiguousBackendFailure({ response: { status: 500 } } as never)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    expect(listener).toHaveBeenLastCalledWith(null)
    unsubscribe()
  })

  it.each([
    ['rejects', () => Promise.reject(new TypeError('network'))],
    ['returns an unexpected status', () => Promise.resolve(response(429))],
  ])('fails open when a healthy server database probe %s', async (_label, databaseReply) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(200)).mockImplementationOnce(databaseReply)
    vi.stubGlobal('fetch', fetchMock)

    await expect(checkHealth()).resolves.toBeNull()
  })

  it('preserves a visible outage when a retry database probe is indeterminate', async () => {
    const listener = vi.fn()
    subscribeToOutage(listener)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200))
      .mockRejectedValueOnce(new TypeError('network'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(checkHealth()).resolves.toBe('server')
    await expect(checkHealth()).resolves.toBe('server')
    expect(listener).toHaveBeenLastCalledWith('server')
  })

  it('times out a hanging probe and resets the shared promise for retry', async () => {
    vi.useFakeTimers()
    let firstSignal: AbortSignal | undefined
    const fetchMock = vi.fn()
      .mockImplementationOnce((_url, init: RequestInit) => {
        firstSignal = init.signal as AbortSignal
        return new Promise<Response>((_resolve, reject) => {
          firstSignal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
        })
      })
      .mockResolvedValueOnce(response(503))
    vi.stubGlobal('fetch', fetchMock)

    const timedOut = checkHealth()
    await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS)

    await expect(timedOut).resolves.toBe('server-unreachable')
    expect(firstSignal?.aborted).toBe(true)
    await expect(checkHealth()).resolves.toBe('server')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not promote client or business errors into outage probes', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    reportAmbiguousBackendFailure({ response: { status: 422 } } as never)

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('shares one health probe across concurrent backend failures', async () => {
    let resolveLiveness: ((value: Response) => void) | undefined
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => {
      resolveLiveness = resolve
    }))
    vi.stubGlobal('fetch', fetchMock)

    const first = checkHealth()
    const second = checkHealth()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    resolveLiveness?.(response(503))

    await expect(Promise.all([first, second])).resolves.toEqual(['server', 'server'])
  })
})
