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

const platformMock = vi.hoisted(() => ({ current: 'ios' }))

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => platformMock.current,
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
const animationFrameCallbacks = new Map<number, FrameRequestCallback>()
let nextAnimationFrame = 1

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

function flushAnimationFrames() {
  const callbacks = Array.from(animationFrameCallbacks.values())
  animationFrameCallbacks.clear()
  callbacks.forEach((callback) => callback(0))
}

beforeEach(() => {
  vi.useFakeTimers()
  platformMock.current = 'ios'
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
    const frame = nextAnimationFrame++
    animationFrameCallbacks.set(frame, callback)
    return frame
  }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((frame: number) => {
    animationFrameCallbacks.delete(frame)
  }))
  resizeObserverInstances.length = 0
  animationFrameCallbacks.clear()
  nextAnimationFrame = 1
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
  it('retries focus registration, contains dispatch failures, and scopes nested focus to the map host', async () => {
    const focusRegistrationFailure = new Error('focus registration failed')
    const unhandledRejection = vi.fn()
    window.addEventListener('unhandledrejection', unhandledRejection)
    pluginMocks.addListener.mockRejectedValueOnce(focusRegistrationFailure)
    const element = document.createElement('capacitor-google-map')
    const firstMapPromise = NativeGoogleMap.create({
      apiKey: 'native-key',
      config: {
        center: { lat: 41.8781, lng: -87.6298 },
        zoom: 12,
      },
      element,
      id: 'trip-map',
    })
    await expect(firstMapPromise).rejects.toBe(focusRegistrationFailure)
    await Promise.resolve()
    expect(pluginMocks.create).not.toHaveBeenCalled()

    const mapPromise = NativeGoogleMap.create({
      apiKey: 'native-key',
      config: {
        center: { lat: 41.8781, lng: -87.6298 },
        zoom: 12,
      },
      element,
      id: 'trip-map',
    })
    await Promise.resolve()
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

    const focusListeners = pluginMocks.addListener.mock.calls
      .filter(([eventName]) => eventName === 'isMapInFocus')
    expect(focusListeners).toHaveLength(2)
    const focusListener = focusListeners.at(-1)?.[1] as
      | ((event: unknown) => void)
      | undefined
    if (!focusListener) throw new Error('Expected native map focus listener to be registered')

    pluginMocks.dispatchMapEvent.mockRejectedValueOnce(new Error('focus dispatch failed'))
    focusListener({ mapId: 'trip-map', x: 12, y: 34 })
    focusListener({ mapId: 'trip-map', x: 56, y: 78 })
    await Promise.resolve()
    await Promise.resolve()

    expect(pluginMocks.dispatchMapEvent).toHaveBeenNthCalledWith(1, {
      focus: true,
      id: 'trip-map',
    })
    expect(pluginMocks.dispatchMapEvent).toHaveBeenNthCalledWith(2, {
      focus: false,
      id: 'trip-map',
    })
    expect(unhandledRejection).not.toHaveBeenCalled()

    window.removeEventListener('unhandledrejection', unhandledRejection)
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
    flushAnimationFrames()
    await Promise.resolve()
    await Promise.resolve()
    width = 0
    triggerResizeObserver(observer)
    width = 300
    triggerResizeObserver(observer)
    flushAnimationFrames()
    await Promise.resolve()
    await Promise.resolve()

    expect(pluginMocks.onResize).toHaveBeenCalledOnce()
    expect(pluginMocks.onDisplay).toHaveBeenCalledOnce()
    expect(unhandledRejection).not.toHaveBeenCalled()

    window.removeEventListener('unhandledrejection', unhandledRejection)
    await map.destroy()
  })

  it('uses display for an initially hidden iOS map and keeps display priority within the frame', async () => {
    let width = 0
    let x = 10
    const element = document.createElement('div')
    vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => mockRect(width, 100, x, 20))

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
    if (!observer) throw new Error('Expected iOS bounds observer after native map creation')

    width = 100
    triggerResizeObserver(observer)
    x = 11
    triggerResizeObserver(observer)
    expect(animationFrameCallbacks).toHaveLength(1)

    flushAnimationFrames()
    await Promise.resolve()

    expect(pluginMocks.onDisplay).toHaveBeenCalledOnce()
    expect(pluginMocks.onDisplay).toHaveBeenLastCalledWith({
      id: 'trip-map',
      mapBounds: { height: 100, width: 100, x: 11, y: 20 },
    })
    expect(pluginMocks.onResize).not.toHaveBeenCalled()

    await map.destroy()
  })

  it('retains failed listener removals for a later shared destroy retry', async () => {
    const element = document.createElement('div')
    const removalFailure = new Error('listener removal failed')
    const onReadyHandle = {
      remove: vi.fn()
        .mockRejectedValueOnce(removalFailure)
        .mockResolvedValue(undefined),
    }
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

    await map.destroy()
    expect(onReadyHandle.remove).toHaveBeenCalledTimes(2)
    expect(pluginMocks.destroy).toHaveBeenCalledOnce()
  })

  it('waits for listeners that resolve during teardown and shares concurrent destroys', async () => {
    const element = document.createElement('div')
    const lateListenerHandle = { remove: vi.fn().mockResolvedValue(undefined) }
    let resolveListener: ((handle: typeof lateListenerHandle) => void) | undefined
    pluginMocks.addListener.mockImplementation((eventName: string) => {
      if (eventName === 'onMapClick') {
        return new Promise((resolve) => {
          resolveListener = resolve
        })
      }
      return Promise.resolve({ remove: vi.fn().mockResolvedValue(undefined) })
    })

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
    const registration = map.setOnMapClickListener(vi.fn())
    const firstDestroy = map.destroy()
    const secondDestroy = map.destroy()

    expect(firstDestroy).toBe(secondDestroy)
    expect(resolveListener).toBeDefined()
    resolveListener?.(lateListenerHandle)
    await registration
    await firstDestroy

    expect(lateListenerHandle.remove).toHaveBeenCalledOnce()
    expect(pluginMocks.destroy).toHaveBeenCalledOnce()
  })

  it('coalesces and serializes iOS bounds forwarding with the latest coordinates', async () => {
    let x = 10
    let y = 20
    const element = document.createElement('div')
    vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => mockRect(100, 100, x, y))
    let resolveFirstResize: (() => void) | undefined
    pluginMocks.onResize
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveFirstResize = resolve
      }))
      .mockResolvedValue(undefined)

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
    const observer = resizeObserverInstances.at(-1)
    if (!observer) throw new Error('Expected iOS bounds observer after native map creation')

    x = 11
    triggerResizeObserver(observer)
    x = 12
    y = 22
    triggerResizeObserver(observer)
    expect(animationFrameCallbacks).toHaveLength(1)

    flushAnimationFrames()
    expect(pluginMocks.onResize).toHaveBeenCalledOnce()
    expect(pluginMocks.onResize).toHaveBeenLastCalledWith({
      id: 'trip-map',
      mapBounds: { height: 100, width: 100, x: 12, y: 22 },
    })

    x = 13
    triggerResizeObserver(observer)
    x = 14
    y = 24
    triggerResizeObserver(observer)
    expect(animationFrameCallbacks).toHaveLength(0)

    resolveFirstResize?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(animationFrameCallbacks).toHaveLength(1)
    flushAnimationFrames()
    await Promise.resolve()

    expect(pluginMocks.onResize).toHaveBeenCalledTimes(2)
    expect(pluginMocks.onResize).toHaveBeenLastCalledWith({
      id: 'trip-map',
      mapBounds: { height: 100, width: 100, x: 14, y: 24 },
    })

    await map.destroy()
  })

  it('routes Android resize and scroll bounds updates, then cancels queued work during destroy', async () => {
    platformMock.current = 'android'
    let androidX = 10
    const androidElement = document.createElement('div')
    vi.spyOn(androidElement, 'getBoundingClientRect')
      .mockImplementation(() => mockRect(100, 100, androidX, 20))
    const androidMapPromise = NativeGoogleMap.create({
      apiKey: 'native-key',
      config: {
        center: { lat: 41.8781, lng: -87.6298 },
        zoom: 12,
      },
      element: androidElement,
      id: 'android-map',
    })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(200)
    const androidMap = await androidMapPromise
    const androidObserver = resizeObserverInstances.at(0)
    if (!androidObserver) throw new Error('Expected Android bounds observer after native map creation')
    androidX = 11
    triggerResizeObserver(androidObserver)
    flushAnimationFrames()
    await Promise.resolve()
    await Promise.resolve()
    expect(pluginMocks.onResize).toHaveBeenCalledOnce()
    window.dispatchEvent(new Event('scroll'))
    flushAnimationFrames()
    await Promise.resolve()
    expect(pluginMocks.onScroll).toHaveBeenCalledOnce()
    expect(pluginMocks.onDisplay).not.toHaveBeenCalled()
    await androidMap.destroy()

    platformMock.current = 'ios'
    let x = 10
    const element = document.createElement('div')
    vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => mockRect(100, 100, x, 20))
    const iosMapPromise = NativeGoogleMap.create({
      apiKey: 'native-key',
      config: {
        center: { lat: 41.8781, lng: -87.6298 },
        zoom: 12,
      },
      element,
      id: 'ios-map',
    })
    await Promise.resolve()
    await vi.advanceTimersByTimeAsync(200)
    const iosMap = await iosMapPromise
    const observer = resizeObserverInstances.at(-1)
    if (!observer) throw new Error('Expected iOS bounds observer after native map creation')
    x = 11
    triggerResizeObserver(observer)
    expect(animationFrameCallbacks).toHaveLength(1)
    const resizeCallsBeforeDestroy = pluginMocks.onResize.mock.calls.length

    await iosMap.destroy()

    expect(pluginMocks.onResize).toHaveBeenCalledTimes(resizeCallsBeforeDestroy)
    expect(window.cancelAnimationFrame).toHaveBeenCalledOnce()
  })
})
