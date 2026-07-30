import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const pluginMocks = vi.hoisted(() => ({
  addListener: vi.fn(),
  create: vi.fn(),
  destroy: vi.fn(),
  dispatchMapEvent: vi.fn(),
  onDisplay: vi.fn(),
  onResize: vi.fn(),
  onScroll: vi.fn(),
}))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'ios',
  },
  registerPlugin: () => pluginMocks,
}))

import { NativeGoogleMap } from './nativeGoogleMapsBridge'

class ResizeObserverStub {
  readonly callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    resizeObserverInstances.push(this)
  }

  disconnect = vi.fn()
  observe = vi.fn()
}

const resizeObserverInstances: ResizeObserverStub[] = []

function mockRect(width: number, height: number, x = 0, y = 0): DOMRect {
  return {
    bottom: y + height,
    height,
    left: x,
    right: x + width,
    toJSON: () => ({}),
    top: y,
    width,
    x,
    y,
  } as DOMRect
}

function triggerResizeObserver(instance: ResizeObserverStub) {
  instance.callback([], instance as unknown as ResizeObserver)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  resizeObserverInstances.length = 0
  pluginMocks.addListener.mockReset()
  pluginMocks.addListener.mockResolvedValue({ remove: vi.fn() })
  pluginMocks.create.mockReset()
  pluginMocks.create.mockResolvedValue(undefined)
  pluginMocks.destroy.mockReset()
  pluginMocks.destroy.mockResolvedValue(undefined)
  pluginMocks.dispatchMapEvent.mockReset()
  pluginMocks.dispatchMapEvent.mockResolvedValue(undefined)
  pluginMocks.onDisplay.mockReset()
  pluginMocks.onDisplay.mockResolvedValue(undefined)
  pluginMocks.onResize.mockReset()
  pluginMocks.onResize.mockResolvedValue(undefined)
  pluginMocks.onScroll.mockReset()
  pluginMocks.onScroll.mockResolvedValue(undefined)
})

afterEach(() => {
  document.body.replaceChildren()
  Reflect.deleteProperty(document, 'elementFromPoint')
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('NativeGoogleMap.create', () => {
  it('treats a nested iOS map overflow child as focused without matching outside the host', async () => {
    const element = document.createElement('capacitor-google-map')
    const mapPromise = NativeGoogleMap.create({
      apiKey: 'native-key',
      config: {
        center: { lat: 41.8781, lng: -87.6298 },
        zoom: 12,
      },
      element,
      id: 'trip-map',
    })
    await vi.advanceTimersByTimeAsync(200)
    const map = await mapPromise

    document.body.append(element)
    const overflowChild = element.firstElementChild
    expect(overflowChild).not.toBeNull()
    const nestedTarget = document.createElement('button')
    overflowChild?.append(nestedTarget)
    const outsideTarget = document.createElement('div')
    outsideTarget.dataset.internalId = 'trip-map'
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn()
        .mockReturnValueOnce(nestedTarget)
        .mockReturnValueOnce(outsideTarget),
    })

    const focusListener = pluginMocks.addListener.mock.calls
      .find(([eventName]) => eventName === 'isMapInFocus')?.[1] as
      | ((event: unknown) => void)
      | undefined
    if (!focusListener) throw new Error('Expected native map focus listener to be registered')

    focusListener({ mapId: 'trip-map', x: 12, y: 34 })
    focusListener({ mapId: 'trip-map', x: 56, y: 78 })

    expect(pluginMocks.dispatchMapEvent).toHaveBeenNthCalledWith(1, {
      focus: true,
      id: 'trip-map',
    })
    expect(pluginMocks.dispatchMapEvent).toHaveBeenNthCalledWith(2, {
      focus: false,
      id: 'trip-map',
    })

    await map.destroy()
  })

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

  it('does not observe bounds before create succeeds and cleans bridge listeners after create failure', async () => {
    const element = document.createElement('div')
    const onReadyHandle = { remove: vi.fn().mockResolvedValue(undefined) }
    let rejectCreate: (reason?: unknown) => void = () => undefined
    pluginMocks.addListener.mockImplementation((eventName: string) => Promise.resolve({
      remove: eventName === 'onMapReady' ? onReadyHandle.remove : vi.fn(),
    }))
    pluginMocks.create.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
      rejectCreate = reject
    }))

    const mapPromise = NativeGoogleMap.create({
      apiKey: 'native-key',
      config: {
        center: { lat: 41.8781, lng: -87.6298 },
        zoom: 12,
      },
      element,
      id: 'trip-map',
      onReady: vi.fn(),
    })
    await vi.advanceTimersByTimeAsync(200)

    expect(resizeObserverInstances).toHaveLength(0)
    window.dispatchEvent(new Event('scroll'))
    window.dispatchEvent(new Event('resize'))
    expect(pluginMocks.onScroll).not.toHaveBeenCalled()

    const createFailure = new Error('native create failed')
    const rejection = expect(mapPromise).rejects.toBe(createFailure)
    rejectCreate(createFailure)
    await rejection

    expect(onReadyHandle.remove).toHaveBeenCalledOnce()
    expect(resizeObserverInstances).toHaveLength(0)
  })

  it('contains rejected display and resize notifications from bounds observation', async () => {
    let width = 100
    const height = 100
    const element = document.createElement('div')
    vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => mockRect(width, height))
    const unhandledRejection = vi.fn()
    window.addEventListener('unhandledrejection', unhandledRejection)
    pluginMocks.onDisplay.mockRejectedValue(new Error('display failed'))
    pluginMocks.onResize.mockRejectedValue(new Error('resize failed'))

    const mapPromise = NativeGoogleMap.create({
      apiKey: 'native-key',
      config: {
        center: { lat: 41.8781, lng: -87.6298 },
        zoom: 12,
      },
      element,
      id: 'trip-map',
    })
    await vi.advanceTimersByTimeAsync(200)
    const map = await mapPromise
    const observer = resizeObserverInstances.at(0)
    if (!observer) throw new Error('Expected bounds observer after native map creation')

    width = 200
    triggerResizeObserver(observer)
    width = 0
    triggerResizeObserver(observer)
    width = 300
    triggerResizeObserver(observer)
    await Promise.resolve()
    await Promise.resolve()

    expect(pluginMocks.onResize).toHaveBeenCalledOnce()
    expect(pluginMocks.onDisplay).toHaveBeenCalledOnce()
    expect(unhandledRejection).not.toHaveBeenCalled()

    window.removeEventListener('unhandledrejection', unhandledRejection)
    await map.destroy()
  })

  it('destroys the native map after a bridge listener removal failure', async () => {
    const element = document.createElement('div')
    const removalFailure = new Error('listener removal failed')
    const onReadyHandle = { remove: vi.fn().mockRejectedValue(removalFailure) }
    pluginMocks.addListener.mockImplementation((eventName: string) => Promise.resolve({
      remove: eventName === 'onMapReady' ? onReadyHandle.remove : vi.fn(),
    }))
    const removeWindowListener = vi.spyOn(window, 'removeEventListener')

    const mapPromise = NativeGoogleMap.create({
      apiKey: 'native-key',
      config: {
        center: { lat: 41.8781, lng: -87.6298 },
        zoom: 12,
      },
      element,
      id: 'trip-map',
      onReady: vi.fn(),
    })
    await vi.advanceTimersByTimeAsync(200)
    const map = await mapPromise
    const observer = resizeObserverInstances.at(0)
    if (!observer) throw new Error('Expected bounds observer after native map creation')

    await expect(map.destroy()).rejects.toThrow('Failed to remove 1 native map bridge listener')

    expect(onReadyHandle.remove).toHaveBeenCalledOnce()
    expect(observer.disconnect).toHaveBeenCalledOnce()
    expect(removeWindowListener).toHaveBeenCalledWith('scroll', expect.any(Function))
    expect(removeWindowListener).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(pluginMocks.destroy).toHaveBeenCalledWith({ id: 'trip-map' })
  })
})
