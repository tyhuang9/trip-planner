import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DATABASE_DEADLINE_MS,
  LIVENESS_DEADLINE_MS,
  waitForReadiness,
} from './readiness'

function up() { return new Response(JSON.stringify({ status: 'UP' }), { status: 200, headers: { 'Content-Type': 'application/json' } }) }
function pendingUntilAbort() {
  return vi.fn((_: string, init: RequestInit) => new Promise<Response>((_, reject) => {
    init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
  }))
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); Reflect.deleteProperty(navigator, 'onLine') })

describe('startup readiness', () => {
  it('progresses through liveness then database only after valid UP JSON', async () => {
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

  it('rejects a pre-aborted parent without probing', async () => {
    const controller = new AbortController(); controller.abort()
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock)
    await expect(waitForReadiness(controller.signal, vi.fn())).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('bounds stalled JSON parsing and retries', async () => {
    vi.useFakeTimers()
    const stalled = { ok: true, status: 200, headers: new Headers(), json: () => new Promise(() => undefined) } as unknown as Response
    const fetchMock = vi.fn().mockResolvedValue(stalled); vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const pending = waitForReadiness(controller.signal, vi.fn())
    await vi.advanceTimersByTimeAsync(13_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('aborts body parsing on parent cancellation and cleans parent listeners', async () => {
    const controller = new AbortController()
    const add = vi.spyOn(controller.signal, 'addEventListener'); const remove = vi.spyOn(controller.signal, 'removeEventListener')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), json: () => new Promise(() => undefined) } as unknown as Response))
    const pending = waitForReadiness(controller.signal, vi.fn())
    await Promise.resolve(); controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(remove.mock.calls.length).toBe(add.mock.calls.length)
  })

  it('settles offline during an active request', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    const active = pendingUntilAbort(); vi.stubGlobal('fetch', active)
    const request = waitForReadiness(new AbortController().signal, vi.fn())
    await Promise.resolve(); window.dispatchEvent(new Event('offline'))
    await expect(request).resolves.toBe('offline')
  })

  it('settles offline when a failed request is waiting to retry', async () => {
    vi.useFakeTimers()
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('Network failed'))
    vi.stubGlobal('fetch', fetchMock)
    const readiness = waitForReadiness(new AbortController().signal, vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    window.dispatchEvent(new Event('offline'))
    await expect(readiness).resolves.toBe('offline')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('propagates parent cancellation while a failed request is waiting to retry', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network failed')))
    const readiness = waitForReadiness(controller.signal, vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    controller.abort()
    await expect(readiness).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not start a database probe when aborted at the liveness handoff', async () => {
    const controller = new AbortController()
    const fetchMock = vi.fn().mockResolvedValueOnce(up()); vi.stubGlobal('fetch', fetchMock)
    const pending = waitForReadiness(controller.signal, (phase) => { if (phase === 'database') controller.abort() })
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries malformed successful responses', async () => {
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

  it('retries non-UP 2xx responses', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: 'DOWN' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const readiness = waitForReadiness(controller.signal, vi.fn())
    await vi.advanceTimersByTimeAsync(3_000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    controller.abort()
    await expect(readiness).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('honors delta-seconds Retry-After before retrying, then continues to database', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '2' } })).mockResolvedValueOnce(up()).mockResolvedValueOnce(up())
    vi.stubGlobal('fetch', fetchMock)
    const readiness = waitForReadiness(new AbortController().signal, vi.fn())
    await vi.advanceTimersByTimeAsync(1_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(readiness).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('uses the normal retry interval for Retry-After: 0 to avoid a request storm', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '0' } })).mockResolvedValueOnce(up()).mockResolvedValueOnce(up())
    vi.stubGlobal('fetch', fetchMock)
    const readiness = waitForReadiness(new AbortController().signal, vi.fn())
    await vi.advanceTimersByTimeAsync(2_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(readiness).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('uses the normal retry interval for a past HTTP-date Retry-After to avoid a request storm', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': 'Wed, 31 Dec 2025 23:59:59 GMT' } })).mockResolvedValueOnce(up()).mockResolvedValueOnce(up())
    vi.stubGlobal('fetch', fetchMock)
    const readiness = waitForReadiness(new AbortController().signal, vi.fn())
    await vi.advanceTimersByTimeAsync(2_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await expect(readiness).resolves.toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('removes parent abort listeners after each settled request and retry delay', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const addListener = vi.spyOn(controller.signal, 'addEventListener')
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 429 })).mockResolvedValueOnce(up()).mockResolvedValueOnce(up()))
    const readiness = waitForReadiness(controller.signal, vi.fn())
    await vi.advanceTimersByTimeAsync(3_000)
    await expect(readiness).resolves.toBeNull()
    expect(removeListener).toHaveBeenCalledTimes(addListener.mock.calls.length)
  })

  it('honors HTTP-date Retry-After but caps it at the phase deadline', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 429, headers: { 'Retry-After': 'Thu, 01 Jan 2026 01:00:00 GMT' } }))
    vi.stubGlobal('fetch', fetchMock)
    const readiness = waitForReadiness(new AbortController().signal, vi.fn())
    await vi.advanceTimersByTimeAsync(LIVENESS_DEADLINE_MS)
    await expect(readiness).resolves.toBe('timeout')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uses a 90s liveness deadline with 10s attempts and 3s retry cadence', async () => {
    vi.useFakeTimers()
    const fetchMock = pendingUntilAbort()
    vi.stubGlobal('fetch', fetchMock)
    const readiness = waitForReadiness(new AbortController().signal, vi.fn())
    await vi.advanceTimersByTimeAsync(LIVENESS_DEADLINE_MS)
    await expect(readiness).resolves.toBe('timeout')
    expect(fetchMock).toHaveBeenCalledTimes(7)
  })

  it('polls expected database 503s every 6s and stops at its 30s deadline', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValueOnce(up()).mockResolvedValue(new Response(JSON.stringify({ status: 'DOWN' }), { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    const readiness = waitForReadiness(new AbortController().signal, vi.fn())
    await vi.advanceTimersByTimeAsync(DATABASE_DEADLINE_MS)
    await expect(readiness).resolves.toBe('timeout')
    const paths = fetchMock.mock.calls.map(([path]) => path as string)
    expect(paths.filter((path) => path.includes('/database'))).toHaveLength(5)
  })
})
