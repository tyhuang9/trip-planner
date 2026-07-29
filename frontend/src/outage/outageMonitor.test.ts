import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetOutageMonitorForTests,
  checkHealth,
  checkStartupHealth,
  HEALTH_PROBE_TIMEOUT_MS,
  reportAmbiguousBackendFailure,
  STARTUP_HEALTH_PROBE_TIMEOUT_MS,
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
  it('shows a cautious server diagnosis when startup liveness cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')))

    await expect(checkStartupHealth()).resolves.toBe('server-unreachable')
  })

  it('classifies an offline browser as connectivity without probing', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(checkHealth()).resolves.toBe('connectivity')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the definitive server diagnosis only for a startup liveness 5xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(503)))

    await expect(checkStartupHealth()).resolves.toBe('server')
  })

  it('uses the cautious server diagnosis for an unexpected liveness status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(404)))

    await expect(checkHealth()).resolves.toBe('server-unreachable')
  })

  it('does not request database during a healthy startup liveness check', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(200)).mockResolvedValueOnce(response(503))
    vi.stubGlobal('fetch', fetchMock)

    await expect(checkStartupHealth()).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('/actuator/health/liveness')
  })

  it('identifies a database outage only from normal health after an API 500', async () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToOutage(listener)
    const fetchMock = vi.fn().mockResolvedValueOnce(response(200)).mockResolvedValueOnce(response(503))
    vi.stubGlobal('fetch', fetchMock)

    reportAmbiguousBackendFailure({ response: { status: 500 } } as never)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    expect(fetchMock.mock.calls[0][0]).toContain('/actuator/health/liveness')
    expect(fetchMock.mock.calls[1][0]).toContain('/actuator/health/database')
    expect(listener).toHaveBeenLastCalledWith('database')
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

  it.each([
    ['rejects', () => Promise.reject(new TypeError('network'))],
    ['returns an unexpected status', () => Promise.resolve(response(429))],
  ])('preserves a visible outage when a retry database probe %s', async (_label, databaseReply) => {
    const listener = vi.fn()
    subscribeToOutage(listener)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200))
      .mockImplementationOnce(databaseReply)
    vi.stubGlobal('fetch', fetchMock)

    await expect(checkHealth()).resolves.toBe('server')
    await expect(checkHealth()).resolves.toBe('server')
    expect(listener).toHaveBeenLastCalledWith('server')
  })

  it('fails open on an initial database timeout and preserves an outage on retry timeout', async () => {
    vi.useFakeTimers()
    const hangingProbe = (_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal
      return new Promise<Response>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(200))
      .mockImplementationOnce(hangingProbe)
      .mockResolvedValueOnce(response(503))
      .mockResolvedValueOnce(response(200))
      .mockImplementationOnce(hangingProbe)
    vi.stubGlobal('fetch', fetchMock)

    const initial = checkHealth()
    await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS)
    await expect(initial).resolves.toBeNull()

    await expect(checkHealth()).resolves.toBe('server')
    const retry = checkHealth()
    await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS)
    await expect(retry).resolves.toBe('server')
  })

  it('shares one overall timeout between liveness and a hanging database probe', async () => {
    vi.useFakeTimers()
    let databaseSignal: AbortSignal | undefined
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        window.setTimeout(
          () => resolve(response(200)),
          HEALTH_PROBE_TIMEOUT_MS - 1,
        )
      }))
      .mockImplementationOnce((_url, init: RequestInit) => {
        databaseSignal = init.signal as AbortSignal
        return new Promise<Response>((_resolve, reject) => {
          databaseSignal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        })
      })
    vi.stubGlobal('fetch', fetchMock)

    const probe = checkHealth()
    await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS - 1)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(databaseSignal?.aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await expect(probe).resolves.toBeNull()
    expect(databaseSignal?.aborted).toBe(true)
  })

  it('skips the database probe when liveness consumes the overall deadline', async () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_000)
      .mockReturnValue(1_000 + HEALTH_PROBE_TIMEOUT_MS)
    const fetchMock = vi.fn().mockResolvedValue(response(200))
    vi.stubGlobal('fetch', fetchMock)

    await expect(checkHealth()).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toContain('/actuator/health/liveness')
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

  it('keeps an in-flight normal check on its 10-second deadline while startup times out', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = []
    const fetchMock = vi.fn().mockImplementation((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = init.signal as AbortSignal
      signals.push(signal)
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    vi.stubGlobal('fetch', fetchMock)

    const startup = checkStartupHealth()
    const normal = checkHealth()
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(STARTUP_HEALTH_PROBE_TIMEOUT_MS)
    await expect(startup).resolves.toBe('server-unreachable')
    expect(signals[1].aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS - STARTUP_HEALTH_PROBE_TIMEOUT_MS - 1)
    expect(signals[1].aborted).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    await expect(normal).resolves.toBe('server-unreachable')
  })

  it('shares one startup probe across concurrent startup checks', async () => {
    let resolveLiveness: ((value: Response) => void) | undefined
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => {
      resolveLiveness = resolve
    }))
    vi.stubGlobal('fetch', fetchMock)

    const first = checkStartupHealth()
    const second = checkStartupHealth()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    resolveLiveness?.(response(503))

    await expect(Promise.all([first, second])).resolves.toEqual(['server', 'server'])
  })

  it('does not let a late healthy startup probe clear a normal database outage', async () => {
    let resolveStartup: ((value: Response) => void) | undefined
    const listener = vi.fn()
    subscribeToOutage(listener)
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveStartup = resolve
      }))
      .mockResolvedValueOnce(response(200))
      .mockResolvedValueOnce(response(503))
    vi.stubGlobal('fetch', fetchMock)

    const startup = checkStartupHealth()
    await expect(checkHealth()).resolves.toBe('database')
    resolveStartup?.(response(200))
    await expect(startup).resolves.toBeNull()

    expect(listener).toHaveBeenLastCalledWith('database')
  })

  it('does not let a late healthy startup probe clear a normal server outage', async () => {
    let resolveStartup: ((value: Response) => void) | undefined
    const listener = vi.fn()
    subscribeToOutage(listener)
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveStartup = resolve
      }))
      .mockResolvedValueOnce(response(503))
    vi.stubGlobal('fetch', fetchMock)

    const startup = checkStartupHealth()
    await expect(checkHealth()).resolves.toBe('server')
    resolveStartup?.(response(200))
    await expect(startup).resolves.toBeNull()

    expect(listener).toHaveBeenLastCalledWith('server')
  })

  it('does not let a startup begun during normal health clear a database outage', async () => {
    let resolveNormal: ((value: Response) => void) | undefined
    let resolveStartup: ((value: Response) => void) | undefined
    const listener = vi.fn()
    subscribeToOutage(listener)
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveNormal = resolve
      }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveStartup = resolve
      }))
      .mockResolvedValueOnce(response(503))
    vi.stubGlobal('fetch', fetchMock)

    const normal = checkHealth()
    const startup = checkStartupHealth()
    resolveNormal?.(response(200))
    await expect(normal).resolves.toBe('database')
    resolveStartup?.(response(200))
    await expect(startup).resolves.toBeNull()

    expect(listener).toHaveBeenLastCalledWith('database')
  })

  it('does not let a startup begun during normal health clear a server outage', async () => {
    let resolveNormal: ((value: Response) => void) | undefined
    let resolveStartup: ((value: Response) => void) | undefined
    const listener = vi.fn()
    subscribeToOutage(listener)
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveNormal = resolve
      }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveStartup = resolve
      }))
    vi.stubGlobal('fetch', fetchMock)

    const normal = checkHealth()
    const startup = checkStartupHealth()
    resolveNormal?.(response(503))
    await expect(normal).resolves.toBe('server')
    resolveStartup?.(response(200))
    await expect(startup).resolves.toBeNull()

    expect(listener).toHaveBeenLastCalledWith('server')
  })

  it.each([
    ['database', [response(200), response(503), response(200)]],
    ['server', [response(503), response(200)]],
  ] as const)('does not let a healthy startup clear a completed normal %s outage', async (kind, replies) => {
    const listener = vi.fn()
    subscribeToOutage(listener)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(replies[0]).mockResolvedValueOnce(replies[1]).mockResolvedValueOnce(replies[2]))

    await expect(checkHealth()).resolves.toBe(kind)
    await expect(checkStartupHealth()).resolves.toBeNull()

    expect(listener).toHaveBeenLastCalledWith(kind)
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
