import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForReadiness } from './readiness'

function up() { return new Response(JSON.stringify({ status: 'UP' }), { status: 200, headers: { 'Content-Type': 'application/json' } }) }

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); Reflect.deleteProperty(navigator, 'onLine') })

describe('startup readiness', () => {
  it('progresses from liveness to database only after valid UP JSON', async () => {
    const phases: string[] = []
    const fetchMock = vi.fn().mockResolvedValueOnce(up()).mockResolvedValueOnce(up())
    vi.stubGlobal('fetch', fetchMock)
    await expect(waitForReadiness(new AbortController().signal, (phase) => phases.push(phase))).resolves.toBeNull()
    expect(phases).toEqual(['liveness', 'database'])
    expect(fetchMock.mock.calls[0][0]).toContain('/liveness')
    expect(fetchMock.mock.calls[1][0]).toContain('/database')
  })

  it('does not probe while offline', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    await expect(waitForReadiness(new AbortController().signal, vi.fn())).resolves.toBe('offline')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('retries malformed successful responses instead of accepting them', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const fetchMock = vi.fn().mockResolvedValue(new Response('{bad', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const readiness = waitForReadiness(controller.signal, vi.fn())
    await vi.advanceTimersByTimeAsync(3_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    controller.abort()
    await expect(readiness).rejects.toMatchObject({ name: 'AbortError' })
  })
})
