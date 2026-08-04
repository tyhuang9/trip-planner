import { apiClient } from '../api/client'
import { buildApiUrl } from '../api/baseUrl'
import {
  logPlaceDetailsTiming,
  placeDetailsElapsedMs,
  placeDetailsNowMs,
} from '../utils/placeDetailsTiming'
import { markPerformance } from '../performance/timing'

export const GOOGLE_PLACES_SEARCH_RESULT_LIMIT = 10

const GOOGLE_PLACE_DETAILS_DEFAULT_FIELDS = [
  'id',
  'displayName',
  'formattedAddress',
  'googleMapsUri',
  'location',
  'rating',
  'types',
  'userRatingCount',
  'websiteUri',
  'nationalPhoneNumber',
]

const GOOGLE_PLACE_DETAILS_EXPANDED_FIELDS = [
  'regularOpeningHours',
  'currentOpeningHours',
  'photos',
  'reviews',
]

export const GOOGLE_PLACE_DETAILS_WITHOUT_PHOTOS_FIELD_MASK =
  GOOGLE_PLACE_DETAILS_DEFAULT_FIELDS.join(',')

export const GOOGLE_PLACE_DETAILS_FIELD_MASK = [
  ...GOOGLE_PLACE_DETAILS_DEFAULT_FIELDS,
  'photos',
].join(',')

type FetchImplementation = typeof fetch

const PLACE_DETAILS_STALE_TIME_MS = 15 * 60 * 1000
const PLACE_DETAILS_GC_TIME_MS = 60 * 60 * 1000

type AppLatLng = { lat: number; lng: number }
type GoogleRestLatLng = { latitude: number; longitude: number }
type FlexibleLatLng = AppLatLng | GoogleRestLatLng

type FlexibleCircle =
  | { center: FlexibleLatLng; radius: number }
  | { circle: { center: FlexibleLatLng; radius: number } }

type FlexibleRectangle =
  | { low: FlexibleLatLng; high: FlexibleLatLng }
  | { rectangle: { low: FlexibleLatLng; high: FlexibleLatLng } }

export type GooglePlaceLocationBias = FlexibleCircle | FlexibleRectangle
export type GooglePlaceLocationRestriction = FlexibleCircle | FlexibleRectangle
export type GooglePlaceRankPreference = 'RELEVANCE' | 'DISTANCE'
export type GooglePlaceNearbyRankPreference = 'POPULARITY' | 'DISTANCE'

export interface GooglePlaceSearchOptions {
  language?: string
  region?: string
  types?: string[]
  proximity?: AppLatLng
  locationBias?: GooglePlaceLocationBias | null
  locationRestriction?: GooglePlaceLocationRestriction | null
}

export interface GooglePlaceTextSearchOptions extends GooglePlaceSearchOptions {
  includedType?: string | null
  pageToken?: string | null
  rankPreference?: GooglePlaceRankPreference | null
}

export interface GooglePlaceNearbySearchOptions {
  language?: string
  location: AppLatLng
  radius?: number
  rankPreference?: GooglePlaceNearbyRankPreference | null
  region?: string
}

export interface GooglePlacePrediction {
  placeId: string
  text: string
  mainText: string
  secondaryText: string
  types: string[]
  placeResourceName: string | null
}

export interface GooglePlaceSuggestion {
  placePrediction: GooglePlacePrediction | null
}

export interface GooglePlaceSelection {
  businessStatus: string | null
  currentOpeningHours: GooglePlaceOpeningHours | null
  id: string
  displayName: string | null
  formattedAddress: string | null
  googleMapsUri: string | null
  lat: number | null
  lng: number | null
  photoName: string | null
  photoUrl: string | null
  primaryType: string | null
  primaryTypeDisplayName: string | null
  priceLevel?: string | null
  rating: number | null
  regularOpeningHours: GooglePlaceOpeningHours | null
  reviews: GooglePlaceReview[]
  text: string
  types: string[]
  userRatingCount: number | null
  websiteUri: string | null
}

export interface GooglePlaceOpeningHours {
  openNow: boolean | null
  weekdayDescriptions: string[]
}

export interface GooglePlaceReview {
  authorName: string | null
  rating: number | null
  relativePublishTimeDescription: string | null
  text: string | null
}

export interface GooglePlaceTextSearchPage {
  nextPageToken: string | null
  places: GooglePlaceSelection[]
}

interface GoogleText {
  text?: string | null
}

interface GoogleAutocompletePredictionResponse {
  place?: string | null
  placeId?: string | null
  text?: GoogleText | null
  structuredFormat?: {
    mainText?: GoogleText | null
    secondaryText?: GoogleText | null
  } | null
  types?: string[] | null
}

interface GoogleAutocompleteSuggestionResponse {
  placePrediction?: GoogleAutocompletePredictionResponse | null
}

interface GoogleAutocompleteResponse {
  suggestions?: GoogleAutocompleteSuggestionResponse[] | null
}

interface GooglePlaceDetailsResponse {
  businessStatus?: string | null
  currentOpeningHours?: GoogleOpeningHoursResponse | null
  id?: string | null
  displayName?: GoogleText | null
  formattedAddress?: string | null
  googleMapsUri?: string | null
  location?: GoogleRestLatLng | null
  name?: string | null
  photos?: Array<{ name?: string | null }> | null
  primaryType?: string | null
  primaryTypeDisplayName?: GoogleText | null
  priceLevel?: string | null
  rating?: number | null
  regularOpeningHours?: GoogleOpeningHoursResponse | null
  reviews?: GoogleReviewResponse[] | null
  types?: string[] | null
  userRatingCount?: number | null
  websiteUri?: string | null
  nationalPhoneNumber?: string | null
  photoUrl?: string | null
}

interface GooglePlacesTextSearchResponse {
  nextPageToken?: string | null
  places?: GooglePlaceDetailsResponse[] | null
}

interface GoogleOpeningHoursResponse {
  openNow?: boolean | null
  weekdayDescriptions?: string[] | null
}

interface GoogleReviewResponse {
  authorAttribution?: {
    displayName?: string | null
  } | null
  rating?: number | null
  relativePublishTimeDescription?: string | null
  text?: GoogleText | null
}

interface BackendPhotoUrlResponse {
  photoUrl?: string | null
}

interface BackendPlaceDetailsResponse {
  placeId: string
  fieldMask: string
  source: 'cache' | 'google' | 'stale_cache'
  stale: boolean
  details: GooglePlaceDetailsResponse
}

interface PlaceDetailsCacheEntry {
  data?: GooglePlaceDetailsResponse
  expiresAt?: number
  garbageCollectAt?: number
  garbageCollectionTimer?: ReturnType<typeof globalThis.setTimeout>
  request?: Promise<GooglePlaceDetailsResponse>
}

const backendPlaceDetailsCache = new Map<string, PlaceDetailsCacheEntry>()

function canonicalBackendPlaceDetailsFieldMask({
  fields,
  includePhoto,
}: {
  fields?: string | string[]
  includePhoto: boolean
}): string {
  const requestedFields = new Set(GOOGLE_PLACE_DETAILS_DEFAULT_FIELDS)
  const rawFields = Array.isArray(fields) ? fields : fields?.split(',') ?? []
  for (const rawField of rawFields) {
    const field = rawField.trim()
    if (field) requestedFields.add(field)
  }
  if (includePhoto) requestedFields.add('photos')

  const orderedFields = [
    ...GOOGLE_PLACE_DETAILS_DEFAULT_FIELDS,
    ...GOOGLE_PLACE_DETAILS_EXPANDED_FIELDS,
  ].filter((field) => requestedFields.has(field))
  return orderedFields.join(',')
}

export function __resetGooglePlaceDetailsCacheForTests(): void {
  for (const entry of backendPlaceDetailsCache.values()) {
    if (entry.garbageCollectionTimer !== undefined) {
      globalThis.clearTimeout(entry.garbageCollectionTimer)
    }
  }
  backendPlaceDetailsCache.clear()
}

function deletePlaceDetailsCacheEntry(cacheKey: string): void {
  const entry = backendPlaceDetailsCache.get(cacheKey)
  if (entry?.garbageCollectionTimer !== undefined) {
    globalThis.clearTimeout(entry.garbageCollectionTimer)
  }
  backendPlaceDetailsCache.delete(cacheKey)
}

function pruneExpiredPlaceDetailsCache(now: number): void {
  for (const [cacheKey, entry] of backendPlaceDetailsCache) {
    if (entry.garbageCollectAt !== undefined && entry.garbageCollectAt <= now) {
      deletePlaceDetailsCacheEntry(cacheKey)
    }
  }
}

function cachePlaceDetails(
  cacheKey: string,
  details: GooglePlaceDetailsResponse,
  completedAt: number,
): void {
  const previous = backendPlaceDetailsCache.get(cacheKey)
  if (previous?.garbageCollectionTimer !== undefined) {
    globalThis.clearTimeout(previous.garbageCollectionTimer)
  }
  const garbageCollectAt = completedAt + PLACE_DETAILS_GC_TIME_MS
  const garbageCollectionTimer = globalThis.setTimeout(() => {
    const current = backendPlaceDetailsCache.get(cacheKey)
    if (current?.garbageCollectAt !== undefined && current.garbageCollectAt <= Date.now()) {
      deletePlaceDetailsCacheEntry(cacheKey)
    }
  }, PLACE_DETAILS_GC_TIME_MS)
  backendPlaceDetailsCache.set(cacheKey, {
    data: details,
    expiresAt: completedAt + PLACE_DETAILS_STALE_TIME_MS,
    garbageCollectAt,
    garbageCollectionTimer,
  })
}

const GOOGLE_PLACE_CATEGORY_TYPES = new Map<string, string>([
  ['restaurant', 'restaurant'],
  ['restaurants', 'restaurant'],
  ['food', 'restaurant'],
  ['dining', 'restaurant'],
  ['cafe', 'cafe'],
  ['cafes', 'cafe'],
  ['coffee', 'cafe'],
  ['coffee shop', 'cafe'],
  ['coffee shops', 'cafe'],
  ['bar', 'bar'],
  ['bars', 'bar'],
  ['pub', 'bar'],
  ['pubs', 'bar'],
  ['museum', 'museum'],
  ['museums', 'museum'],
  ['park', 'park'],
  ['parks', 'park'],
  ['hotel', 'lodging'],
  ['hotels', 'lodging'],
  ['lodging', 'lodging'],
  ['attraction', 'tourist_attraction'],
  ['attractions', 'tourist_attraction'],
  ['tourist attraction', 'tourist_attraction'],
  ['tourist attractions', 'tourist_attraction'],
  ['things to do', 'tourist_attraction'],
])

function isFiniteCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function textValue(value: string | GoogleText | null | undefined): string {
  if (typeof value === 'string') return value.trim()
  return value?.text?.trim() ?? ''
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function normalizeHttpsUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  if (!trimmed) return null

  const normalized = trimmed.startsWith('//') ? `https:${trimmed}` : trimmed
  return isHttpsUrl(normalized) ? normalized : null
}

function normalizeCategoryQuery(value: string): string {
  return value
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function googlePlaceCategoryTypeForQuery(query: string): string | null {
  return GOOGLE_PLACE_CATEGORY_TYPES.get(normalizeCategoryQuery(query)) ?? null
}

function restLatLng(value: FlexibleLatLng): GoogleRestLatLng | null {
  const lat = 'latitude' in value ? value.latitude : value.lat
  const lng = 'longitude' in value ? value.longitude : value.lng
  if (!isFiniteCoordinate(lat) || !isFiniteCoordinate(lng)) return null
  return { latitude: lat, longitude: lng }
}

function normalizeLocationConstraint(
  value: GooglePlaceLocationBias | GooglePlaceLocationRestriction | null | undefined,
):
  | { circle: { center: GoogleRestLatLng; radius: number } }
  | { rectangle: { low: GoogleRestLatLng; high: GoogleRestLatLng } }
  | undefined {
  if (!value) return undefined

  const circle = 'circle' in value ? value.circle : 'center' in value ? value : null
  if (circle) {
    const center = restLatLng(circle.center)
    if (!center || !isFiniteCoordinate(circle.radius)) return undefined
    return { circle: { center, radius: circle.radius } }
  }

  const rectangle = 'rectangle' in value ? value.rectangle : 'low' in value ? value : null
  if (!rectangle) return undefined

  const low = restLatLng(rectangle.low)
  const high = restLatLng(rectangle.high)
  if (!low || !high) return undefined
  return { rectangle: { low, high } }
}

function placeIdFromPrediction(prediction: GoogleAutocompletePredictionResponse): string {
  const placeId = prediction.placeId?.trim()
  if (placeId) return placeId

  const placeResourceName = prediction.place?.trim()
  if (!placeResourceName) return ''
  return placeResourceName.startsWith('places/')
    ? placeResourceName.slice('places/'.length)
    : placeResourceName
}

function placeIdFromResourceName(value: string | null | undefined): string {
  const resourceName = value?.trim()
  if (!resourceName) return ''
  return resourceName.startsWith('places/') ? resourceName.slice('places/'.length) : resourceName
}

function normalizePrediction(
  prediction: GoogleAutocompletePredictionResponse | null | undefined,
): GooglePlacePrediction | null {
  if (!prediction) return null

  const placeId = placeIdFromPrediction(prediction)
  if (!placeId) return null

  const mainText = textValue(prediction.structuredFormat?.mainText)
  const secondaryText = textValue(prediction.structuredFormat?.secondaryText)
  const fullText = textValue(prediction.text)
  const fallbackText =
    mainText && secondaryText ? `${mainText}, ${secondaryText}` : mainText || secondaryText

  return {
    placeId,
    text: fullText || fallbackText || 'Untitled place',
    mainText: mainText || fullText || 'Untitled place',
    secondaryText,
    types: prediction.types?.filter(Boolean) ?? [],
    placeResourceName: prediction.place?.trim() || null,
  }
}

function assertOk(response: Response, context: string): void {
  if (!response.ok) {
    throw new Error(`${context} failed with ${response.status}`)
  }
}

function backendFetchUrl(url: string, params?: Record<string, string | boolean | undefined>): string {
  return buildApiUrl(url, params)
}

async function getBackendJson<T>(
  url: string,
  context: string,
  params?: Record<string, string | boolean | undefined>,
  fetchImpl?: FetchImplementation,
  signal?: AbortSignal,
): Promise<T> {
  if (fetchImpl) {
    const response = await fetchImpl(backendFetchUrl(url, params), {
      credentials: 'include',
      signal,
    })
    assertOk(response, context)
    return (await response.json()) as T
  }
  const response = await apiClient.get<T>(url, { params, signal })
  return response.data
}

async function postBackendJson<T>(
  url: string,
  body: unknown,
  context: string,
  params?: Record<string, string | boolean | undefined>,
  fetchImpl?: FetchImplementation,
  signal?: AbortSignal,
): Promise<T> {
  if (fetchImpl) {
    const response = await fetchImpl(backendFetchUrl(url, params), {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal,
    })
    assertOk(response, context)
    return (await response.json()) as T
  }
  const response = await apiClient.post<T>(url, body, { params, signal })
  return response.data
}

export function googlePredictionPrimaryText(prediction: GooglePlacePrediction): string {
  return prediction.mainText || prediction.text || 'Untitled place'
}

export function googlePredictionSecondaryText(prediction: GooglePlacePrediction): string {
  return prediction.secondaryText
}

export function buildGooglePlacesAutocompleteRequest(
  query: string,
  options: GooglePlaceSearchOptions | undefined,
  sessionToken: string,
) {
  const origin = options?.proximity ? restLatLng(options.proximity) : null
  const locationRestriction = normalizeLocationConstraint(options?.locationRestriction)
  const locationBias =
    locationRestriction
      ? undefined
      : normalizeLocationConstraint(options?.locationBias) ??
        (origin ? { circle: { center: origin, radius: 50000 } } : undefined)

  return {
    input: query,
    languageCode: options?.language,
    regionCode: options?.region,
    includedPrimaryTypes: options?.types,
    locationBias,
    locationRestriction,
    origin: origin ?? undefined,
    sessionToken,
  }
}

export function buildGooglePlacesTextSearchRequest(
  query: string,
  options: GooglePlaceTextSearchOptions | undefined,
  pageSize = GOOGLE_PLACES_SEARCH_RESULT_LIMIT,
) {
  const origin = options?.proximity ? restLatLng(options.proximity) : null
  const locationRestriction = normalizeLocationConstraint(options?.locationRestriction)
  const locationBias =
    locationRestriction
      ? undefined
      : normalizeLocationConstraint(options?.locationBias) ??
        (origin ? { circle: { center: origin, radius: 50000 } } : undefined)

  return {
    textQuery: query,
    languageCode: options?.language,
    regionCode: options?.region,
    includedType: options?.includedType ?? options?.types?.[0],
    locationBias,
    locationRestriction,
    pageSize,
    pageToken: options?.pageToken || undefined,
    rankPreference: options?.rankPreference || undefined,
  }
}

export function buildGooglePlacesNearbySearchRequest(
  options: GooglePlaceNearbySearchOptions,
  maxResultCount = 1,
) {
  const center = restLatLng(options.location)
  if (!center) {
    throw new Error('Google Places nearby search requires finite coordinates')
  }
  const radius =
    isFiniteCoordinate(options.radius) && options.radius > 0 ? options.radius : 75

  return {
    languageCode: options.language,
    locationRestriction: {
      circle: {
        center,
        radius,
      },
    },
    maxResultCount,
    rankPreference: options.rankPreference || 'DISTANCE',
    regionCode: options.region,
  }
}

export async function fetchGooglePlaceSuggestions({
  fetchImpl,
  options,
  query,
  sessionToken,
  signal,
}: {
  fetchImpl?: FetchImplementation
  options?: GooglePlaceSearchOptions
  query: string
  sessionToken: string
  signal?: AbortSignal
}): Promise<GooglePlaceSuggestion[]> {
  const body = await postBackendJson<GoogleAutocompleteResponse>(
    '/places/autocomplete',
    buildGooglePlacesAutocompleteRequest(query, options, sessionToken),
    'Google Places autocomplete',
    undefined,
    fetchImpl,
    signal,
  )
  return (body.suggestions ?? [])
    .map((suggestion) => ({
      placePrediction: normalizePrediction(suggestion.placePrediction),
    }))
    .filter((suggestion) => suggestion.placePrediction)
}

export async function fetchGooglePlaceTextSearch({
  fetchImpl,
  includePhoto = false,
  options,
  pageSize = GOOGLE_PLACES_SEARCH_RESULT_LIMIT,
  query,
}: {
  fetchImpl?: FetchImplementation
  includePhoto?: boolean
  options?: GooglePlaceTextSearchOptions
  pageSize?: number
  query: string
}): Promise<GooglePlaceTextSearchPage> {
  const body = await postBackendJson<GooglePlacesTextSearchResponse>(
    '/places/text-search',
    buildGooglePlacesTextSearchRequest(query, options, pageSize),
    'Google Places text search',
    { includePhoto },
    fetchImpl,
  )
  const places = (body.places ?? []).slice(0, pageSize)
  const normalizedPlaces = places.map((place) =>
    normalizeGoogleTextSearchPlace(place, includePhoto ? normalizeHttpsUrl(place.photoUrl) : null),
  )
  return {
    nextPageToken: body.nextPageToken?.trim() || null,
    places: normalizedPlaces.filter((place): place is GooglePlaceSelection => place !== null),
  }
}

export async function fetchGooglePlaceNearLocation({
  fetchImpl,
  includePhoto = false,
  maxResultCount = 1,
  options,
}: {
  fetchImpl?: FetchImplementation
  includePhoto?: boolean
  maxResultCount?: number
  options: GooglePlaceNearbySearchOptions
}): Promise<GooglePlaceSelection | null> {
  const body = await postBackendJson<GooglePlacesTextSearchResponse>(
    '/places/nearby-search',
    buildGooglePlacesNearbySearchRequest(options, maxResultCount),
    'Google Places nearby search',
    { includePhoto },
    fetchImpl,
  )
  for (const place of body.places ?? []) {
    const photoUrl = includePhoto ? normalizeHttpsUrl(place.photoUrl) : null
    const normalizedPlace = normalizeGoogleTextSearchPlace(place, photoUrl)
    if (normalizedPlace) return normalizedPlace
  }
  return null
}

export async function fetchGooglePlaceDetails({
  includePhoto = false,
  placeId,
  fields,
  fetchImpl,
  sessionToken,
  signal,
  traceId,
}: {
  fetchImpl?: FetchImplementation
  includePhoto?: boolean
  placeId: string
  sessionToken?: string | null
  signal?: AbortSignal
  fields?: string | string[]
  traceId?: string | null
}): Promise<GooglePlaceDetailsResponse> {
  const fieldMask = canonicalBackendPlaceDetailsFieldMask({ fields, includePhoto })
  const normalizedSessionToken = sessionToken?.trim() || ''
  const cacheKey = `${placeId}\n${fieldMask}`
  const now = Date.now()
  pruneExpiredPlaceDetailsCache(now)
  const cached = backendPlaceDetailsCache.get(cacheKey)
  if (cached?.data && cached.expiresAt !== undefined && cached.expiresAt > now) {
    return cached.data
  }
  if (!signal && cached?.request) return cached.request

  const shouldSendFields = fields !== undefined || includePhoto
  const requestStartedAtMs = placeDetailsNowMs()
  logPlaceDetailsTiming('frontend_details_request_start', {
    fieldMask,
    includePhoto,
    placeId,
    sessionTokenPresent: normalizedSessionToken.length > 0,
    traceId: traceId?.trim() || null,
  })
  const request = getBackendJson<BackendPlaceDetailsResponse>(
    `/places/${encodeURIComponent(placeId)}/details`,
    'Google Place Details',
    {
      ...(shouldSendFields ? { fields: fieldMask } : {}),
      ...(traceId?.trim() ? { clientTraceId: traceId.trim() } : {}),
      ...(normalizedSessionToken ? { sessionToken: normalizedSessionToken } : {}),
    },
    fetchImpl,
    signal,
  ).then((response) => {
    logPlaceDetailsTiming('frontend_details_response_received', {
      durationMs: placeDetailsElapsedMs(requestStartedAtMs),
      fieldMask: response.fieldMask,
      includePhoto,
      placeId: response.placeId,
      source: response.source,
      stale: response.stale,
      traceId: traceId?.trim() || null,
    })
    markPerformance('place-details-ready')
    return response.details
  })

  if (!signal) {
    backendPlaceDetailsCache.set(cacheKey, { ...cached, request })
  }
  try {
    const details = await request
    cachePlaceDetails(cacheKey, details, Date.now())
    return details
  } catch (error) {
    if (!signal) {
      if (cached) {
        backendPlaceDetailsCache.set(cacheKey, cached)
      } else {
        deletePlaceDetailsCacheEntry(cacheKey)
      }
    }
    throw error
  }
}

export async function fetchGooglePlaceById({
  fetchImpl,
  includePhoto = false,
  placeId,
  traceId,
}: {
  fetchImpl?: FetchImplementation
  includePhoto?: boolean
  placeId: string
  traceId?: string | null
}): Promise<GooglePlaceSelection> {
  const requestStartedAtMs = placeDetailsNowMs()
  const details = await fetchGooglePlaceDetails({
    fetchImpl,
    includePhoto,
    placeId,
    traceId,
  })
  logPlaceDetailsTiming('frontend_details_normalized', {
    durationMs: placeDetailsElapsedMs(requestStartedAtMs),
    includePhoto,
    placeId,
    traceId: traceId?.trim() || null,
  })
  const photoStartedAtMs = placeDetailsNowMs()
  const photoUrl = includePhoto
    ? await imageUrlFromGooglePhotoName({
        fetchImpl,
        photoName: details.photos?.[0]?.name,
      })
    : null
  if (includePhoto) {
    logPlaceDetailsTiming('frontend_photo_hydration_complete', {
      durationMs: placeDetailsElapsedMs(photoStartedAtMs),
      hasPhotoUrl: photoUrl !== null,
      placeId,
      traceId: traceId?.trim() || null,
    })
  }

  return normalizeGooglePlaceResponse(
    details,
    {
      mainText: textValue(details.displayName) || details.formattedAddress?.trim() || 'Selected place',
      placeId,
      placeResourceName: details.name?.trim() || null,
      secondaryText: details.formattedAddress?.trim() || '',
      text: textValue(details.displayName) || details.formattedAddress?.trim() || 'Selected place',
      types: details.types?.filter(Boolean) ?? [],
    },
    photoUrl,
  )
}

export async function imageUrlFromGooglePhotoName({
  fetchImpl,
  maxHeightPx = 1000,
  maxWidthPx = 1600,
  photoName,
}: {
  fetchImpl?: FetchImplementation
  maxHeightPx?: number
  maxWidthPx?: number
  photoName: string | null | undefined
}): Promise<string | null> {
  if (!photoName) return null

  try {
    const body = await postBackendJson<BackendPhotoUrlResponse>(
      '/places/photo-url',
      {
        photoName,
        maxWidthPx,
        maxHeightPx,
      },
      'Google Places photo media',
      undefined,
      fetchImpl,
    )
    return normalizeHttpsUrl(body.photoUrl)
  } catch {
    return null
  }
}

export function normalizeGooglePlace(
  place: GooglePlaceDetailsResponse,
  prediction: GooglePlacePrediction,
  photoUrl: string | null,
): GooglePlaceSelection {
  return normalizeGooglePlaceResponse(place, prediction, photoUrl)
}

function normalizeOpeningHours(
  openingHours: GoogleOpeningHoursResponse | null | undefined,
): GooglePlaceOpeningHours | null {
  if (!openingHours) return null
  const weekdayDescriptions = openingHours.weekdayDescriptions?.filter(Boolean) ?? []
  const hasOpenNow = typeof openingHours.openNow === 'boolean'
  if (!hasOpenNow && weekdayDescriptions.length === 0) return null

  return {
    openNow: hasOpenNow ? openingHours.openNow ?? null : null,
    weekdayDescriptions,
  }
}

function normalizeReviews(
  reviews: GoogleReviewResponse[] | null | undefined,
): GooglePlaceReview[] {
  return (reviews ?? []).flatMap((review): GooglePlaceReview[] => {
    const authorName = review.authorAttribution?.displayName?.trim() || null
    const relativePublishTimeDescription =
      review.relativePublishTimeDescription?.trim() || null
    const text = textValue(review.text) || null
    const rating = isFiniteCoordinate(review.rating) ? review.rating : null
    if (!authorName && !relativePublishTimeDescription && !text && rating === null) {
      return []
    }
    return [{
      authorName,
      rating,
      relativePublishTimeDescription,
      text,
    }]
  })
}

function firstPhotoName(place: GooglePlaceDetailsResponse): string | null {
  return place.photos?.[0]?.name?.trim() || null
}

function normalizeGooglePlaceResponse(
  place: GooglePlaceDetailsResponse,
  prediction: GooglePlacePrediction,
  photoUrl: string | null,
): GooglePlaceSelection {
  const displayName = textValue(place.displayName) || googlePredictionPrimaryText(prediction)
  const formattedAddress =
    place.formattedAddress?.trim() || googlePredictionSecondaryText(prediction) || null
  const lat = place.location?.latitude
  const lng = place.location?.longitude
  const types = place.types && place.types.length > 0 ? place.types : prediction.types
  const text =
    displayName && formattedAddress && !formattedAddress.toLowerCase().includes(displayName.toLowerCase())
      ? `${displayName}, ${formattedAddress}`
      : formattedAddress || displayName || prediction.text || 'Selected place'

  return {
    businessStatus: place.businessStatus?.trim() || null,
    currentOpeningHours: normalizeOpeningHours(place.currentOpeningHours),
    id: place.id?.trim() || placeIdFromResourceName(place.name) || prediction.placeId,
    displayName: displayName || null,
    formattedAddress,
    googleMapsUri: normalizeHttpsUrl(place.googleMapsUri),
    lat: isFiniteCoordinate(lat) ? lat : null,
    lng: isFiniteCoordinate(lng) ? lng : null,
    photoName: firstPhotoName(place),
    photoUrl,
    primaryType: place.primaryType ?? null,
    primaryTypeDisplayName: textValue(place.primaryTypeDisplayName) || null,
    priceLevel: place.priceLevel?.trim() || null,
    rating: isFiniteCoordinate(place.rating) ? place.rating : null,
    regularOpeningHours: normalizeOpeningHours(place.regularOpeningHours),
    reviews: normalizeReviews(place.reviews),
    text,
    types,
    userRatingCount: isFiniteCoordinate(place.userRatingCount) ? place.userRatingCount : null,
    websiteUri: normalizeHttpsUrl(place.websiteUri),
  }
}

export function normalizeGoogleTextSearchPlace(
  place: GooglePlaceDetailsResponse,
  photoUrl: string | null = null,
): GooglePlaceSelection | null {
  const placeId = place.id?.trim() || placeIdFromResourceName(place.name)
  const displayName = textValue(place.displayName)
  const formattedAddress = place.formattedAddress?.trim() || null
  const fallbackText =
    displayName && formattedAddress ? `${displayName}, ${formattedAddress}` : displayName || formattedAddress
  if (!placeId || !fallbackText) return null

  return normalizeGooglePlaceResponse(
    place,
    {
      mainText: displayName || fallbackText,
      placeId,
      placeResourceName: place.name?.trim() || null,
      secondaryText: formattedAddress || '',
      text: fallbackText,
      types: place.types?.filter(Boolean) ?? [],
    },
    photoUrl,
  )
}

export async function fetchGooglePlaceSelection({
  fetchImpl,
  includePhoto = false,
  prediction,
  sessionToken,
  traceId,
}: {
  fetchImpl?: FetchImplementation
  includePhoto?: boolean
  prediction: GooglePlacePrediction
  sessionToken?: string | null
  traceId?: string | null
}): Promise<GooglePlaceSelection> {
  const place = await fetchGooglePlaceDetails({
    fetchImpl,
    includePhoto,
    placeId: prediction.placeId,
    sessionToken,
    traceId,
  })
  const photoUrl = includePhoto
    ? await imageUrlFromGooglePhotoName({
        fetchImpl,
        photoName: place.photos?.[0]?.name,
      })
    : null

  return normalizeGooglePlace(place, prediction, photoUrl)
}
