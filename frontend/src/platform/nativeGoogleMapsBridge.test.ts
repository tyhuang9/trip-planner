import { afterEach, describe, expect, it, vi } from 'vitest'

const plugin = vi.hoisted(() => {
  const callbacks = new Map<string, (event: unknown) => void>()
  const handles = new Map<string, { remove: ReturnType<typeof vi.fn> }>()
  return {
    callbacks,
    handles,
    plugin: {
      addListener: vi.fn(async (name: string, callback: (event: unknown) => void) => {
        callbacks.set(name, callback)
        const handle = { remove: vi.fn(async () => undefined) }
        handles.set(name, handle)
        return handle
      }),
      addMarkers: vi.fn(),
      addPolylines: vi.fn(),
      create: vi.fn(async () => undefined),
      destroy: vi.fn(async () => undefined),
      dispatchMapEvent: vi.fn(async () => undefined),
      fitBounds: vi.fn(),
      onDisplay: vi.fn(async () => undefined),
      onResize: vi.fn(async () => undefined),
      onScroll: vi.fn(async () => undefined),
      removeMarkers: vi.fn(),
      removePolylines: vi.fn(),
      setCamera: vi.fn(),
      setMapType: vi.fn(),
    },
  }
})

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'ios' },
  registerPlugin: () => plugin.plugin,
}))

import { NativeGoogleMap } from './nativeGoogleMapsBridge'

class TestResizeObserver {
  static instances: TestResizeObserver[] = []
  readonly disconnect = vi.fn()
  readonly callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    TestResizeObserver.instances.push(this)
  }

  observe = vi.fn()
  unobserve = vi.fn()
  trigger() {
    this.callback([], this as unknown as ResizeObserver)
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  plugin.callbacks.clear()
  plugin.handles.clear()
  TestResizeObserver.instances = []
})

describe('NativeGoogleMap iOS bridge', () => {
  it('creates, restores bounds, routes focus, and removes listeners on destroy', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('ResizeObserver', TestResizeObserver)
    let bounds = { bottom: 130, height: 100, left: 20, right: 220, top: 30, width: 200, x: 20, y: 30 }
    const element = document.createElement('capacitor-google-map')
    vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => bounds as DOMRect)
    document.body.appendChild(element)
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => element),
    })

    const mapPromise = NativeGoogleMap.create({
      apiKey: 'restricted-test-key',
      config: { center: { lat: 1, lng: 2 }, zoom: 8 },
      element,
      id: 'map-1',
      onReady: vi.fn(),
    })
    await vi.advanceTimersByTimeAsync(200)
    const map = await mapPromise

    expect(plugin.plugin.create).toHaveBeenCalledWith(expect.objectContaining({
      id: 'map-1',
      config: expect.objectContaining({ height: 100, width: 200, x: 20, y: 30 }),
    }))
    expect(plugin.callbacks.has('isMapInFocus')).toBe(true)
    plugin.callbacks.get('isMapInFocus')?.({ mapId: 'map-1', x: 25, y: 35 })
    expect(plugin.plugin.dispatchMapEvent).toHaveBeenCalledWith({ focus: true, id: 'map-1' })

    bounds = { ...bounds, height: 140 }
    TestResizeObserver.instances[0].trigger()
    expect(plugin.plugin.onResize).toHaveBeenCalledWith(expect.objectContaining({ id: 'map-1' }))
    bounds = { ...bounds, height: 0 }
    TestResizeObserver.instances[0].trigger()
    bounds = { ...bounds, height: 140 }
    TestResizeObserver.instances[0].trigger()
    expect(plugin.plugin.onDisplay).toHaveBeenCalledWith(expect.objectContaining({ id: 'map-1' }))

    await map.destroy()
    expect(plugin.plugin.destroy).toHaveBeenCalledWith({ id: 'map-1' })
    expect(TestResizeObserver.instances[0].disconnect).toHaveBeenCalled()
    expect(plugin.handles.get('onMapReady')?.remove).toHaveBeenCalled()
  })
})
