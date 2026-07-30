import { Capacitor, registerPlugin, type Plugin, type PluginListenerHandle } from '@capacitor/core'

export interface NativeMapCoordinate {
  lat: number
  lng: number
}

export interface NativeMapBounds {
  southwest: NativeMapCoordinate
  center: NativeMapCoordinate
  northeast: NativeMapCoordinate
}

export interface NativeMapMarker {
  coordinate: NativeMapCoordinate
  snippet?: string
  tintColor?: {
    a: number
    b: number
    g: number
    r: number
  }
  title?: string
  zIndex?: number
}

export interface NativeMapPolyline {
  path: NativeMapCoordinate[]
  strokeColor?: string
  strokeOpacity?: number
  strokeWeight?: number
  zIndex?: number
}

export type NativeMapType = 'Normal' | 'Hybrid' | 'Satellite' | 'Terrain'

interface NativeMapConfig {
  center: NativeMapCoordinate
  devicePixelRatio?: number
  height?: number
  mapTypeId?: string
  width?: number
  x?: number
  y?: number
  zoom: number
}

interface MapReadyEvent {
  mapId: string
}

interface MapClickEvent {
  latitude: number
  longitude: number
  mapId: string
}

interface MarkerClickEvent {
  markerId: string
  mapId: string
}

interface CameraIdleEvent {
  bounds: NativeMapBounds
  latitude: number
  longitude: number
  mapId: string
  zoom: number
}

interface MapFocusEvent {
  mapId: string
  x: number
  y: number
}

interface NativeGoogleMapsPlugin extends Plugin {
  addMarkers(options: { id: string; markers: NativeMapMarker[] }): Promise<{ ids: string[] }>
  addPolylines(options: { id: string; polylines: NativeMapPolyline[] }): Promise<{ ids: string[] }>
  create(options: {
    apiKey: string
    config: NativeMapConfig
    forceCreate?: boolean
    id: string
  }): Promise<void>
  destroy(options: { id: string }): Promise<void>
  dispatchMapEvent(options: { focus: boolean; id: string }): Promise<void>
  fitBounds(options: { bounds: NativeMapBounds; id: string; padding?: number }): Promise<void>
  onDisplay(options: { id: string; mapBounds: NativeMapElementBounds }): Promise<void>
  onResize(options: { id: string; mapBounds: NativeMapElementBounds }): Promise<void>
  onScroll(options: { id: string; mapBounds: NativeMapElementBounds }): Promise<void>
  removeMarkers(options: { id: string; markerIds: string[] }): Promise<void>
  removePolylines(options: { id: string; polylineIds: string[] }): Promise<void>
  setCamera(options: {
    config: { animate?: boolean; coordinate?: NativeMapCoordinate; zoom?: number }
    id: string
  }): Promise<void>
  setMapType(options: { id: string; mapType: NativeMapType }): Promise<void>
}

interface NativeMapElementBounds {
  height: number
  width: number
  x: number
  y: number
}

const capacitorGoogleMaps = registerPlugin<NativeGoogleMapsPlugin>('CapacitorGoogleMaps')

let focusListenerRegistered = false

function ensureMapElementDefinition() {
  if (customElements.get('capacitor-google-map')) return

  class CapacitorGoogleMapElement extends HTMLElement {
    connectedCallback() {
      this.innerHTML = ''
      if (Capacitor.getPlatform() !== 'ios') return

      // The native iOS plugin binds its GMSMapView to this child scroll view.
      // This mirrors the package's element implementation without bundling its
      // browser Maps fallback.
      this.style.overflow = 'scroll'
      this.style.setProperty('-webkit-overflow-scrolling', 'touch')
      const overflowElement = document.createElement('div')
      overflowElement.style.height = '200%'
      this.appendChild(overflowElement)
    }
  }

  customElements.define('capacitor-google-map', CapacitorGoogleMapElement)
}

function mapElementBounds(element: HTMLElement): NativeMapElementBounds {
  const bounds = element.getBoundingClientRect()
  return {
    height: bounds.height,
    width: bounds.width,
    x: bounds.x,
    y: bounds.y,
  }
}

function registerFocusListener() {
  if (focusListenerRegistered) return
  focusListenerRegistered = true

  void capacitorGoogleMaps.addListener('isMapInFocus', (event) => {
    const { mapId, x, y } = event as unknown as MapFocusEvent
    const target = document.elementFromPoint(x, y) as HTMLElement | null
    void capacitorGoogleMaps.dispatchMapEvent({
      focus: target?.dataset.internalId === mapId,
      id: mapId,
    })
  })
}

export class NativeGoogleMap {
  private readonly id: string
  private readonly element: HTMLElement
  private readonly listenerHandles = new Map<string, PluginListenerHandle>()
  private readonly handleScroll = () => {
    void this.updateMapBounds('onScroll')
  }
  private resizeObserver: ResizeObserver | null = null

  private constructor(id: string, element: HTMLElement) {
    this.id = id
    this.element = element
  }

  static async create(options: {
    apiKey: string
    config: Omit<NativeMapConfig, 'devicePixelRatio' | 'height' | 'width' | 'x' | 'y'>
    element: HTMLElement
    id: string
    onReady?: () => void
  }): Promise<NativeGoogleMap> {
    ensureMapElementDefinition()
    registerFocusListener()

    const map = new NativeGoogleMap(options.id, options.element)
    map.element.dataset.internalId = options.id
    const bounds = mapElementBounds(map.element)

    if (options.onReady) {
      await map.setListener<MapReadyEvent>('onMapReady', (event) => {
        if (event.mapId === options.id) options.onReady?.()
      })
    }

    map.observeBounds()

    // WKWebView needs one layout turn to create the scroll view the iOS plugin
    // uses as its native map container.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 200))
    try {
      await capacitorGoogleMaps.create({
        apiKey: options.apiKey,
        config: {
          ...options.config,
          ...bounds,
          devicePixelRatio: window.devicePixelRatio,
        },
        forceCreate: true,
        id: options.id,
      })
    } catch (error) {
      await map.removeBridgeListeners()
      throw error
    }

    return map
  }

  async addMarkers(markers: NativeMapMarker[]): Promise<string[]> {
    if (markers.length === 0) return []
    const result = await capacitorGoogleMaps.addMarkers({ id: this.id, markers })
    return result.ids
  }

  async addPolylines(polylines: NativeMapPolyline[]): Promise<string[]> {
    if (polylines.length === 0) return []
    const result = await capacitorGoogleMaps.addPolylines({ id: this.id, polylines })
    return result.ids
  }

  async destroy() {
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    window.removeEventListener('scroll', this.handleScroll)
    window.removeEventListener('resize', this.handleScroll)
    await this.removeBridgeListeners()
    await capacitorGoogleMaps.destroy({ id: this.id })
  }

  fitBounds(bounds: NativeMapBounds, padding?: number) {
    return capacitorGoogleMaps.fitBounds({ bounds, id: this.id, padding })
  }

  removeMarkers(markerIds: string[]) {
    return markerIds.length > 0
      ? capacitorGoogleMaps.removeMarkers({ id: this.id, markerIds })
      : Promise.resolve()
  }

  removePolylines(polylineIds: string[]) {
    return polylineIds.length > 0
      ? capacitorGoogleMaps.removePolylines({ id: this.id, polylineIds })
      : Promise.resolve()
  }

  setCamera(config: { animate?: boolean; coordinate?: NativeMapCoordinate; zoom?: number }) {
    return capacitorGoogleMaps.setCamera({ config, id: this.id })
  }

  setMapType(mapType: NativeMapType) {
    return capacitorGoogleMaps.setMapType({ id: this.id, mapType })
  }

  setOnCameraIdleListener(callback?: (event: CameraIdleEvent) => void) {
    return this.setListener('onCameraIdle', callback)
  }

  setOnMapClickListener(callback?: (event: MapClickEvent) => void) {
    return this.setListener('onMapClick', callback)
  }

  setOnMarkerClickListener(callback?: (event: MarkerClickEvent) => void) {
    return this.setListener('onMarkerClick', callback)
  }

  private observeBounds() {
    let wasHidden = false
    let previous = mapElementBounds(this.element)
    this.resizeObserver = new ResizeObserver(() => {
      const bounds = mapElementBounds(this.element)
      const isHidden = bounds.width === 0 || bounds.height === 0
      if (!isHidden && wasHidden && Capacitor.getPlatform() === 'ios') {
        void capacitorGoogleMaps.onDisplay({ id: this.id, mapBounds: bounds })
      } else if (!isHidden && (previous.width !== bounds.width || previous.height !== bounds.height)) {
        void capacitorGoogleMaps.onResize({ id: this.id, mapBounds: bounds })
      }
      previous = bounds
      wasHidden = isHidden
    })
    this.resizeObserver.observe(this.element)
    window.addEventListener('scroll', this.handleScroll)
    window.addEventListener('resize', this.handleScroll)
  }

  private async setListener<T extends { mapId: string }>(
    eventName: string,
    callback?: (event: T) => void,
  ) {
    const existing = this.listenerHandles.get(eventName)
    if (existing) {
      await existing.remove()
      this.listenerHandles.delete(eventName)
    }
    if (!callback) return

    const handle = await capacitorGoogleMaps.addListener(eventName, (event) => {
      const mapEvent = event as unknown as T
      if (mapEvent.mapId === this.id) callback(mapEvent)
    })
    this.listenerHandles.set(eventName, handle)
  }

  private async removeBridgeListeners() {
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    window.removeEventListener('scroll', this.handleScroll)
    window.removeEventListener('resize', this.handleScroll)
    await Promise.all(Array.from(this.listenerHandles.values(), (handle) => handle.remove()))
    this.listenerHandles.clear()
  }

  private updateMapBounds(method: 'onResize' | 'onScroll') {
    return capacitorGoogleMaps[method]({
      id: this.id,
      mapBounds: mapElementBounds(this.element),
    }).catch(() => undefined)
  }
}
