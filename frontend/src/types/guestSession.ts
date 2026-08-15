import type { TripRole } from './trip'

export interface GuestSessionBootstrap {
  publicId: string
  role: TripRole
  displayName: string
}
