import { act, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TripMapProps } from './TripMap'
import { TripMapSurface } from './TripMapSurface.native'

const nativeMapMocks = vi.hoisted(() => ({ create: vi.fn() }))
const runtimeMock = vi.hoisted(() => ({ actualPlatform: 'web' }))

vi.mock('../platform/nativeGoogleMapsBridge', () => ({
  NativeGoogleMap: { create: nativeMapMocks.create },
}))

vi.mock('../platform/runtime', () => ({
  platformRuntime: {
    get actualPlatform() {
      return runtimeMock.actualPlatform
    },
  },
}))

const currentDir = dirname(fileURLToPath(import.meta.url))
const mapSurfaceCss = readFileSync(join(currentDir, 'TripMapSurface.native.module.css'), 'utf8')
const mapSurfaceSource = readFileSync(join(currentDir, 'TripMapSurface.native.tsx'), 'utf8')

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function nativeMapMock() {
  return {
    destroy: vi.fn().mockResolvedValue(undefined),
    setOnCameraIdleListener: vi.fn().mockResolvedValue(undefined),
    setOnMapClickListener: vi.fn().mockResolvedValue(undefined),
    setOnMarkerClickListener: vi.fn().mockResolvedValue(undefined),
  }
}

beforeEach(() => {
  runtimeMock.actualPlatform = 'web'
  nativeMapMocks.create.mockReset()
})

describe('<TripMapSurface> native target', () => {
  it('renders the native map host without importing the browser renderer', async () => {
    await act(async () => {
      render(<TripMapSurface {...({ activities: [], destination: null } as TripMapProps)} />)
    })

    expect(screen.getByTestId('native-google-map')).toBeInTheDocument()
    expect(screen.getByTestId('native-map-runtime-notice'))
      .toBeInTheDocument()
    expect(mapSurfaceSource).not.toMatch(/@vis\.gl\/react-google-maps/)
  })

  it('fills the bounded mobile map panel and supports Android native transparency', () => {
    expect(mapSurfaceCss).toMatch(/height:\s*100%/)
    expect(mapSurfaceCss).toMatch(/min-height:\s*0/)
    expect(mapSurfaceCss.match(
      /var\(--mobile-bottom-nav-height,\s*calc\(56px \+ env\(safe-area-inset-bottom\)\)\)/g,
    )).toHaveLength(2)
    expect(mapSurfaceCss).not.toMatch(/var\(--mobile-bottom-nav-height,\s*64px\)/)
    expect(mapSurfaceCss).toMatch(/html\.native-map-active/)
  })

  it('waits for every listener registration and destroys a failed native map before showing startup failure', async () => {
    const map = nativeMapMock()
    const delayedRegistration = deferred<void>()
    const delayedDestroy = deferred<void>()
    map.setOnMarkerClickListener.mockRejectedValueOnce(new Error('marker listener failed'))
    map.setOnMapClickListener.mockReturnValueOnce(delayedRegistration.promise)
    map.destroy.mockReturnValueOnce(delayedDestroy.promise)
    nativeMapMocks.create.mockResolvedValueOnce(map)
    runtimeMock.actualPlatform = 'android'

    render(<TripMapSurface {...({ activities: [], destination: null } as TripMapProps)} />)

    await waitFor(() => {
      expect(map.setOnMarkerClickListener).toHaveBeenCalledOnce()
      expect(map.setOnMapClickListener).toHaveBeenCalledOnce()
      expect(map.setOnCameraIdleListener).toHaveBeenCalledOnce()
    })
    expect(map.destroy).not.toHaveBeenCalled()
    expect(screen.queryByText('Native Google Maps could not start. Check the iOS or Android Maps SDK key configuration.'))
      .not.toBeInTheDocument()

    delayedRegistration.resolve()
    await waitFor(() => expect(map.destroy).toHaveBeenCalledOnce())
    expect(screen.queryByText('Native Google Maps could not start. Check the iOS or Android Maps SDK key configuration.'))
      .not.toBeInTheDocument()

    delayedDestroy.resolve()
    expect(await screen.findByText('Native Google Maps could not start. Check the iOS or Android Maps SDK key configuration.'))
      .toBeInTheDocument()
  })
})
