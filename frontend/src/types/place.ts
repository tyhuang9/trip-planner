import type { CreateActivityRequest } from './activity'

export interface PlaceOpeningHours {
  openNow: boolean | null
  weekdayDescriptions: string[]
}

export interface PlaceReview {
  authorName: string | null
  rating: number | null
  relativePublishTimeDescription: string | null
  text: string | null
}

export interface PlaceSelection extends Partial<CreateActivityRequest> {
  businessStatus?: string | null
  coordinatesLabel?: string | null
  featureType?: string | null
  googleMapsUri?: string | null
  currentOpeningHours?: PlaceOpeningHours | null
  isLoadingDetails?: boolean
  placeDetailsError?: string | null
  photoName?: string | null
  photoUrl?: string | null
  placeCategory?: string | null
  priceLevel?: string | null
  rating?: number | null
  regularOpeningHours?: PlaceOpeningHours | null
  reviews?: PlaceReview[]
  userRatingCount?: number | null
  websiteUri?: string | null
}
