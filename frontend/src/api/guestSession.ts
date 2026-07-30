import { apiClient } from './client'
import type { GuestSessionBootstrap } from '../types/guestSession'

/**
 * Resolves the current server-held guest credential without persisting a trip
 * identifier or guest secret in browser/native storage.
 */
export async function bootstrapGuestSession(): Promise<GuestSessionBootstrap | null> {
  const response = await apiClient.get<GuestSessionBootstrap>(
    '/guest-session/bootstrap',
  )
  return response.status === 204 ? null : response.data
}
