import { GoogleMapsProvider } from './GoogleMapsProvider'
import { TripMap, type TripMapProps } from './TripMap'

export function TripMapSurface(props: TripMapProps) {
  return (
    <GoogleMapsProvider>
      <TripMap {...props} />
    </GoogleMapsProvider>
  )
}
