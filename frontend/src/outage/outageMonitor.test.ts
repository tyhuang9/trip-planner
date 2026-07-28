import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  __resetOutageMonitorForTests,
  checkHealth,
  reportAmbiguousBackendFailure,
  subscribeToOutage,
} from './outageMonitor'

function response(status: number) {
  return new Response(null, { status })
}

afterEach(() => {
  __resetOutageMonitorForTests()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'onLine')
})

describe('outage monitoring', () => {
  it('identifies an unavailable app when liveness cannot be reached', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network'))
    vi.stubGlobal('fetch', fetchMock)

    await expect(checkHealth()).resolves.toBe('app')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('classifies an offline browser as a connectivity issue without probing', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(checkHealth()).resolves.toBe('connectivity')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('identifies a database outage only after liveness is healthy', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(response(200)).mockResolvedValueOnce(response(503))
    vi.stubGlobal('fetch', fetchMock)

    await expect(checkHealth()).resolves.toBe('database')
    expect(fetchMock.mock.calls[0][0]).toContain('/actuator/health/liveness')
    expect(fetchMock.mock.calls[1][0]).toContain('/actuator/health/database')
  })

  it('fails open when dedicated probes are healthy after a backend 500', async () => {
    const listener = vi.fn()
    const unsubscribe = subscribeToOutage(listener)
    const fetchMock = vi.fn().mockResolvedValue(response(200))
    vi.stubGlobal('fetch', fetchMock)

    reportAmbiguousBackendFailure({ response: { status: 500 } } as never)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    expect(listener).toHaveBeenLastCalledWith(null)
    unsubscribe()
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

    await expect(Promise.all([first, second])).resolves.toEqual(['app', 'app'])
  })
})
