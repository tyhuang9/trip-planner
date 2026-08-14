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
