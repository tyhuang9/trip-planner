import { act, render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Activity } from '../types/activity'
import type { TripMapProps } from './TripMap'
import { TripMapSurface } from './TripMapSurface.native'

const nativeMapHarness = vi.hoisted(() => {
  const listeners = {
    mapClick: null as null | ((event: { latitude: number; longitude: number }) => void),
    markerClick: null as null | ((event: { markerId: string }) => void),
    poiClick: null as null | ((event: {
      latitude: number
      longitude: number
      name: string
      placeId: string
    }) => void),
  }
  const map = {
    addMarkers: vi.fn(async () => ['saved-marker-id']),
    addPolylines: vi.fn(async () => []),
    destroy: vi.fn(async () => undefined),
    fitBounds: vi.fn(async () => undefined),
    removeMarkers: vi.fn(async () => undefined),
    removePolylines: vi.fn(async () => undefined),
    setCamera: vi.fn(async () => undefined),
    setMapType: vi.fn(async () => undefined),
    setOnCameraIdleListener: vi.fn(async () => undefined),
    setOnMapClickListener: vi.fn(async (listener) => {
      listeners.mapClick = listener
    }),
    setOnMarkerClickListener: vi.fn(async (listener) => {
      listeners.markerClick = listener
    }),
    setOnPoiClickListener: vi.fn(async (listener) => {
      listeners.poiClick = listener
    }),
  }
  return {
    create: vi.fn(async () => map),
    listeners,
    map,
  }
})

vi.mock('../platform/nativeGoogleMapsBridge', () => ({
  NativeGoogleMap: { create: nativeMapHarness.create },
}))

vi.mock('../platform/runtime', () => ({
  platformRuntime: { actualPlatform: 'android' },
}))

const currentDir = dirname(fileURLToPath(import.meta.url))
const mapSurfaceCss = readFileSync(join(currentDir, 'TripMapSurface.native.module.css'), 'utf8')
const mapSurfaceSource = readFileSync(join(currentDir, 'TripMapSurface.native.tsx'), 'utf8')
const nativeBridgeSource = readFileSync(join(currentDir, '../platform/nativeGoogleMapsBridge.ts'), 'utf8')
const nativePoiPatch = readFileSync(
  join(currentDir, '../../patches/@capacitor+google-maps+8.0.1.patch'),
  'utf8',
)
const packageJson = JSON.parse(readFileSync(join(currentDir, '../../package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  scripts?: Record<string, string>
}

function mappedActivity(): Activity {
  return {
    address: '1 Main Street',
    category: 'ACTIVITY',
    createdAt: '2026-08-06T12:00:00.000Z',
    createdByUserDisplayName: null,
    dayDate: null,
    endTime: null,
    id: 42,
    lat: 35.7,
    lng: 139.8,
    notes: null,
    orderIndex: 0,
    placeId: 'saved-place-id',
    placeName: 'Saved place',
    startTime: null,
    title: 'Saved place',
    updatedAt: '2026-08-06T12:00:00.000Z',
    updatedByUserDisplayName: null,
    version: 1,
  }
}

describe('<TripMapSurface> native target', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    nativeMapHarness.listeners.mapClick = null
    nativeMapHarness.listeners.markerClick = null
    nativeMapHarness.listeners.poiClick = null
  })

  it('renders the native map host without importing the browser renderer', async () => {
    await act(async () => {
      render(<TripMapSurface {...({ activities: [], destination: null } as TripMapProps)} />)
    })

    expect(screen.getByTestId('native-google-map')).toBeInTheDocument()
    await waitFor(() => expect(nativeMapHarness.create).toHaveBeenCalledTimes(1))
    expect(mapSurfaceSource).not.toMatch(/@vis\.gl\/react-google-maps/)
  })

  it('fills the bounded mobile map panel and supports Android native transparency', () => {
    expect(mapSurfaceCss).toMatch(/height:\s*100%/)
    expect(mapSurfaceCss).toMatch(/min-height:\s*0/)
    expect(mapSurfaceCss).toMatch(/var\(--mobile-bottom-nav-height,\s*64px\)/)
    expect(mapSurfaceCss).toMatch(/html\.native-map-active/)
  })

  it('installs an exact-version native POI callback patch and forwards its identity separately', () => {
    expect(packageJson.dependencies?.['@capacitor/google-maps']).toBe('8.0.1')
    expect(packageJson.scripts?.postinstall).toBe('patch-package')
    expect(nativePoiPatch).toMatch(/didTapPOIWithPlaceID placeID: String/)
    expect(nativePoiPatch).toMatch(/OnPoiClickListener/)
    expect(nativePoiPatch).toMatch(/setOnPoiClickListener/)
    expect(nativePoiPatch).toMatch(/notifyListeners\("onPoiClick"/)
    expect(nativePoiPatch).toMatch(/delegate\.notify\("onPoiClick"/)
    expect(nativeBridgeSource).toMatch(/setOnPoiClickListener\(callback/)
    expect(mapSurfaceSource).toMatch(/nextMap\.setOnPoiClickListener/)
    expect(mapSurfaceSource).toMatch(/source: 'native-poi'/)
    expect(mapSurfaceSource).toMatch(/source: 'native-coordinate'/)
    expect(mapSurfaceSource).toMatch(/NATIVE_POI_MAP_CLICK_SUPPRESSION_MS/)
  })

  it('suppresses only a duplicate same-location map callback after an exact POI callback', async () => {
    const onMapPlaceClick = vi.fn()
    await act(async () => {
      render(<TripMapSurface activities={[]} destination={null} onMapPlaceClick={onMapPlaceClick} />)
    })
    await waitFor(() => expect(nativeMapHarness.listeners.poiClick).not.toBeNull())

    act(() => {
      nativeMapHarness.listeners.poiClick?.({
        latitude: 35.7,
        longitude: 139.8,
        name: 'Exact place',
        placeId: 'google.exact-place',
      })
      nativeMapHarness.listeners.mapClick?.({ latitude: 35.7, longitude: 139.8 })
      nativeMapHarness.listeners.mapClick?.({ latitude: 35.71, longitude: 139.81 })
    })

    expect(onMapPlaceClick).toHaveBeenCalledTimes(2)
    expect(onMapPlaceClick).toHaveBeenNthCalledWith(1, expect.objectContaining({
      location: { lat: 35.7, lng: 139.8 },
      placeId: 'google.exact-place',
      placeName: 'Exact place',
      source: 'native-poi',
    }))
    expect(onMapPlaceClick).toHaveBeenNthCalledWith(2, expect.objectContaining({
      location: { lat: 35.71, lng: 139.81 },
      placeId: null,
      source: 'native-coordinate',
    }))
  })

  it('keeps saved marker actions isolated from base-map POI callbacks', async () => {
    const onActivityActivate = vi.fn()
    const onMapPlaceClick = vi.fn()
    await act(async () => {
      render(
        <TripMapSurface
          activities={[mappedActivity()]}
          destination={null}
          onActivityActivate={onActivityActivate}
          onMapPlaceClick={onMapPlaceClick}
        />,
      )
    })
    await waitFor(() => expect(nativeMapHarness.listeners.markerClick).not.toBeNull())
    await waitFor(() => expect(nativeMapHarness.map.addMarkers).toHaveBeenCalledTimes(1))

    act(() => nativeMapHarness.listeners.markerClick?.({ markerId: 'saved-marker-id' }))

    expect(onActivityActivate).toHaveBeenCalledWith(42)
    expect(onMapPlaceClick).not.toHaveBeenCalled()
  })
})
