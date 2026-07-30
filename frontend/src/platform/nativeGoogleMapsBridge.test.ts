import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pluginMocks = vi.hoisted(() => ({
  addListener: vi.fn(),
  create: vi.fn(),
  destroy: vi.fn(),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'ios',
  },
  registerPlugin: () => pluginMocks,
}))

import { NativeGoogleMap } from './nativeGoogleMapsBridge'

class ResizeObserverStub {
  disconnect = vi.fn()
  observe = vi.fn()
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  pluginMocks.addListener.mockReset()
  pluginMocks.addListener.mockResolvedValue({ remove: vi.fn() })
  pluginMocks.create.mockReset()
  pluginMocks.create.mockResolvedValue(undefined)
  pluginMocks.destroy.mockReset()
  pluginMocks.destroy.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('NativeGoogleMap.create', () => {
  it('measures element bounds after the WKWebView layout wait', async () => {
    let layoutSettled = false
    const element = document.createElement('div')
    vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => ({
      bottom: layoutSettled ? 274 : 0,
      height: layoutSettled ? 240 : 0,
      left: layoutSettled ? 12 : 0,
      right: layoutSettled ? 332 : 0,
      toJSON: () => ({}),
      top: layoutSettled ? 34 : 0,
      width: layoutSettled ? 320 : 0,
      x: layoutSettled ? 12 : 0,
      y: layoutSettled ? 34 : 0,
    }))
    window.setTimeout(() => {
      layoutSettled = true
    }, 199)

    const mapPromise = NativeGoogleMap.create({
      apiKey: 'native-key',
      config: {
        center: { lat: 41.8781, lng: -87.6298 },
        zoom: 12,
      },
      element,
      id: 'trip-map',
    })
    expect(pluginMocks.create).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(200)
    const map = await mapPromise

    expect(pluginMocks.create).toHaveBeenCalledWith({
      apiKey: 'native-key',
      config: {
        center: { lat: 41.8781, lng: -87.6298 },
        devicePixelRatio: window.devicePixelRatio,
        height: 240,
        width: 320,
        x: 12,
        y: 34,
        zoom: 12,
      },
      forceCreate: true,
      id: 'trip-map',
    })

    await map.destroy()
  })
})
