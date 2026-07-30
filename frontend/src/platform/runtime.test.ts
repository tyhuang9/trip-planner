import { afterEach, describe, expect, it } from 'vitest'
import { platformRuntime, subscribeToAppLifecycle } from './runtime'

afterEach(() => {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  })
})

describe('platform runtime facade', () => {
  it('exposes the test build as the web development profile', () => {
    expect(platformRuntime).toMatchObject({
      actualPlatform: 'web',
      environment: 'development',
      target: 'web',
    })
    expect(platformRuntime.capabilities).toEqual({
      appAccessGate: true,
      appLifecycle: true,
      browserMapsLoader: true,
      serviceWorker: true,
      vercelAnalytics: false,
    })
  })

  it('normalizes browser visibility and focus into one lifecycle subscription', () => {
    const states: string[] = []
    const unsubscribe = subscribeToAppLifecycle((state) => states.push(state))

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    })
    document.dispatchEvent(new Event('visibilitychange'))
    window.dispatchEvent(new Event('focus'))
    unsubscribe()
    window.dispatchEvent(new Event('pageshow'))

    expect(states).toEqual(['background', 'background'])
  })
})
