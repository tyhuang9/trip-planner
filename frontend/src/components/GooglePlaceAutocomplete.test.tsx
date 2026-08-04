import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MockAdapter from 'axios-mock-adapter'
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '../api/client'
import { GooglePlaceAutocomplete } from './GooglePlaceAutocomplete'
import {
  GOOGLE_PLACE_DETAILS_FIELD_MASK,
  GOOGLE_PLACE_DETAILS_WITHOUT_PHOTOS_FIELD_MASK,
  __resetGooglePlaceDetailsCacheForTests,
  buildGooglePlacesNearbySearchRequest,
  buildGooglePlacesTextSearchRequest,
  fetchGooglePlaceNearLocation,
  fetchGooglePlaceSelection,
  fetchGooglePlaceTextSearch,
  fetchGooglePlaceSuggestions,
  googlePlaceCategoryTypeForQuery,
  imageUrlFromGooglePhotoName,
  normalizeGooglePlace,
  type GooglePlacePrediction,
  type GooglePlaceSelection,
} from './googlePlaces'

let apiMock: MockAdapter

const tokyoTowerPrediction = {
  placePrediction: {
    place: 'places/google.tokyo-tower',
    placeId: 'google.tokyo-tower',
    text: { text: 'Tokyo Tower, Minato City, Tokyo' },
    structuredFormat: {
      mainText: { text: 'Tokyo Tower' },
      secondaryText: { text: 'Minato City, Tokyo' },
    },
    types: ['tourist_attraction'],
  },
}

const tokyoTowerDetails = {
  displayName: { text: 'Tokyo Tower' },
  formattedAddress: '4 Chome-2-8 Shibakoen, Minato City, Tokyo',
  id: 'google.tokyo-tower',
  location: {
    latitude: 35.6586,
    longitude: 139.7454,
  },
  photos: [{ name: 'places/google.tokyo-tower/photos/photo1' }],
  primaryType: 'tourist_attraction',
  primaryTypeDisplayName: { text: 'Tourist attraction' },
  types: ['tourist_attraction'],
}

function requestData<T = Record<string, unknown>>(request: { data?: unknown } | undefined): T {
  return JSON.parse(String(request?.data ?? '{}')) as T
}

function autocompleteRequestFor(input: string) {
  return apiMock.history.post.find((request) => {
    if (request.url !== '/places/autocomplete') return false
    const body = requestData<{ input?: string }>(request)
    return body.input === input
  })
}

function autocompleteCalls() {
  return apiMock.history.post.filter((request) => request.url === '/places/autocomplete')
}

function placeDetailsCall() {
  return apiMock.history.get.find((request) => request.url === '/places/google.tokyo-tower/details')
}

function Harness({
  includePhoto = false,
  initialValue = '',
  onClear,
  onPlaceSelect = vi.fn(),
  onSearchError = vi.fn(),
  onSearchSubmit,
  selectOnFocus = false,
  showClearButton = false,
}: {
  initialValue?: string
  includePhoto?: boolean
  onClear?: () => void
  onPlaceSelect?: (place: GooglePlaceSelection) => void
  onSearchError?: (message: string | null) => void
  onSearchSubmit?: (query: string) => Promise<void> | void
  selectOnFocus?: boolean
  showClearButton?: boolean
}) {
  const [value, setValue] = useState(initialValue)
  return (
    <GooglePlaceAutocomplete
      inputLabel="Destination"
      value={value}
      onValueChange={setValue}
      onPlaceSelect={onPlaceSelect}
      onSearchError={onSearchError}
      onClear={onClear}
      onSearchSubmit={onSearchSubmit}
      options={{ language: 'en', proximity: { lat: 35.6586, lng: 139.7454 } }}
      includePhoto={includePhoto}
      placeholder="Search"
      searchFailedMessage="Google Places failed."
      selectOnFocus={selectOnFocus}
      showClearButton={showClearButton}
    />
  )
}

beforeEach(() => {
  Object.defineProperty(window, 'requestAnimationFrame', {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      callback(0)
      return 1
    },
  })
  Object.defineProperty(window, 'cancelAnimationFrame', {
    configurable: true,
    value: vi.fn(),
  })
  __resetGooglePlaceDetailsCacheForTests()
  apiMock = new MockAdapter(apiClient)
  apiMock.onPost('/places/autocomplete').reply(200, {
    suggestions: [tokyoTowerPrediction],
  })
  apiMock.onGet('/places/google.tokyo-tower/details').reply(200, {
    placeId: 'google.tokyo-tower',
    fieldMask: GOOGLE_PLACE_DETAILS_FIELD_MASK,
    source: 'google',
    stale: false,
    details: tokyoTowerDetails,
  })
  apiMock.onPost('/places/photo-url').reply(200, {
    photoUrl: 'https://example.com/tokyo-tower.webp',
  })
})

afterEach(() => {
  apiMock.restore()
  __resetGooglePlaceDetailsCacheForTests()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('<GooglePlaceAutocomplete>', () => {
  it('fetches suggestions from Places API (New), selects a place, and normalizes it for the app', async () => {
    const onPlaceSelect = vi.fn()

    render(<Harness includePhoto onPlaceSelect={onPlaceSelect} />)

    await userEvent.type(screen.getByLabelText(/destination/i), 'Tokyo')

    const suggestionButton = await screen.findByRole('button', { name: /tokyo tower/i })
    const autocompleteCall = autocompleteRequestFor('Tokyo')
    await userEvent.click(suggestionButton)

    await waitFor(() => {
      expect(onPlaceSelect).toHaveBeenCalledWith({
        businessStatus: null,
        currentOpeningHours: null,
        displayName: 'Tokyo Tower',
        formattedAddress: '4 Chome-2-8 Shibakoen, Minato City, Tokyo',
        googleMapsUri: null,
        id: 'google.tokyo-tower',
        lat: 35.6586,
        lng: 139.7454,
        photoName: 'places/google.tokyo-tower/photos/photo1',
        photoUrl: 'https://example.com/tokyo-tower.webp',
        priceLevel: null,
        primaryType: 'tourist_attraction',
        primaryTypeDisplayName: 'Tourist attraction',
        rating: null,
        regularOpeningHours: null,
        reviews: [],
        text: 'Tokyo Tower, 4 Chome-2-8 Shibakoen, Minato City, Tokyo',
        types: ['tourist_attraction'],
        userRatingCount: null,
        websiteUri: null,
      })
    })
    expect(screen.getByLabelText(/destination/i)).toHaveValue(
      'Tokyo Tower, 4 Chome-2-8 Shibakoen, Minato City, Tokyo',
    )
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(screen.getByLabelText(/destination/i)).not.toHaveFocus()

    const autocompleteBody = requestData<{
      input?: string
      languageCode?: string
      locationBias?: { circle?: { center?: { latitude?: number; longitude?: number }; radius?: number } }
      origin?: { latitude?: number; longitude?: number }
      sessionToken?: string
    }>(autocompleteCall)

    expect(autocompleteCall?.url).toBe('/places/autocomplete')
    expect(autocompleteBody).toMatchObject({
      input: 'Tokyo',
      languageCode: 'en',
      locationBias: {
        circle: {
          center: { latitude: 35.6586, longitude: 139.7454 },
          radius: 50000,
        },
      },
      origin: { latitude: 35.6586, longitude: 139.7454 },
    })
    expect(autocompleteBody.sessionToken).toEqual(expect.any(String))

    expect(placeDetailsCall()?.params).toEqual({
      fields: GOOGLE_PLACE_DETAILS_FIELD_MASK,
      sessionToken: autocompleteBody.sessionToken,
    })
    expect(GOOGLE_PLACE_DETAILS_FIELD_MASK).not.toContain('reviews')
    expect(GOOGLE_PLACE_DETAILS_WITHOUT_PHOTOS_FIELD_MASK).not.toContain('reviews')
    expect(GOOGLE_PLACE_DETAILS_FIELD_MASK).toContain('googleMapsUri')
    expect(GOOGLE_PLACE_DETAILS_WITHOUT_PHOTOS_FIELD_MASK).toContain('googleMapsUri')
    expect(placeDetailsCall()).toBeDefined()

    const photoCall = apiMock.history.post.find((request) => request.url === '/places/photo-url')
    expect(photoCall).toBeDefined()
    expect(requestData(photoCall)).toEqual({
      photoName: 'places/google.tokyo-tower/photos/photo1',
      maxWidthPx: 1600,
      maxHeightPx: 1000,
    })

    await new Promise((resolve) => window.setTimeout(resolve, 300))
    expect(autocompleteCalls()).toHaveLength(1)

    await userEvent.clear(screen.getByLabelText(/destination/i))
    await userEvent.type(screen.getByLabelText(/destination/i), 'Kyoto')

    await waitFor(() => {
      expect(autocompleteRequestFor('Kyoto')).toBeDefined()
    })
    const secondAutocompleteBody = requestData<{
      sessionToken?: string
    }>(autocompleteRequestFor('Kyoto'))
    expect(secondAutocompleteBody.sessionToken).toEqual(expect.any(String))
    expect(secondAutocompleteBody.sessionToken).not.toBe(autocompleteBody.sessionToken)
  })

  it('reports search errors and closes the suggestions list', async () => {
    const onSearchError = vi.fn()
    apiMock.resetHandlers()
    apiMock.onPost('/places/autocomplete').reply(403, { error: { message: 'Forbidden' } })

    render(<Harness onSearchError={onSearchError} />)

    await userEvent.type(screen.getByLabelText(/destination/i), 'Nope')

    await waitFor(() => {
      expect(onSearchError).toHaveBeenLastCalledWith(
        expect.stringContaining('Google Places request reached the backend'),
      )
    })
    expect(onSearchError).toHaveBeenLastCalledWith(expect.stringContaining('Google Places failed.'))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('reports backend connectivity failures separately from Google API failures', async () => {
    const onSearchError = vi.fn()
    apiMock.resetHandlers()
    apiMock.onPost('/places/autocomplete').networkError()

    render(<Harness onSearchError={onSearchError} />)

    await userEvent.type(screen.getByLabelText(/destination/i), 'Nope')

    await waitFor(() => {
      expect(onSearchError).toHaveBeenLastCalledWith(
        expect.stringContaining('Could not reach the Dupert backend'),
      )
    })
    expect(onSearchError).toHaveBeenLastCalledWith(expect.stringContaining('localhost:8000'))
  })

  it('shows at most four suggestions', async () => {
    apiMock.resetHandlers()
    apiMock.onPost('/places/autocomplete').reply(200, {
      suggestions: Array.from({ length: 5 }, (_, index) => ({
        placePrediction: {
          place: `places/google.place-${index + 1}`,
          placeId: `google.place-${index + 1}`,
          text: { text: `Place ${index + 1}, Tokyo` },
          structuredFormat: {
            mainText: { text: `Place ${index + 1}` },
            secondaryText: { text: 'Tokyo' },
          },
          types: ['tourist_attraction'],
        },
      })),
    })

    render(<Harness />)

    await userEvent.type(screen.getByLabelText(/destination/i), 'Tokyo')

    await waitFor(() => {
      expect(screen.getAllByRole('option')).toHaveLength(4)
    })
    expect(screen.getByRole('button', { name: /place 4/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /place 5/i })).not.toBeInTheDocument()
  })

  it('submits the typed query on Enter', async () => {
    const onSearchSubmit = vi.fn()
    render(<Harness onSearchSubmit={onSearchSubmit} />)

    const input = screen.getByLabelText(/destination/i)
    await userEvent.type(input, 'Ramen')
    await userEvent.keyboard('{Enter}')

    expect(onSearchSubmit).toHaveBeenCalledWith('Ramen')
  })

  it('keeps suggestions closed after Enter even when a pending autocomplete request resolves', async () => {
    const onSearchSubmit = vi.fn()
    apiMock.resetHandlers()
    apiMock.onPost('/places/autocomplete').reply(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 80))
      return [200, { suggestions: [tokyoTowerPrediction] }]
    })

    render(<Harness onSearchSubmit={onSearchSubmit} />)

    const input = screen.getByLabelText(/destination/i)
    await userEvent.type(input, 'Ramen')
    await new Promise((resolve) => window.setTimeout(resolve, 270))
    await userEvent.keyboard('{Enter}')

    expect(onSearchSubmit).toHaveBeenCalledWith('Ramen')

    await new Promise((resolve) => window.setTimeout(resolve, 120))
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })

  it('does not show pending suggestions after blur but can show cached suggestions on refocus', async () => {
    let resolveAutocomplete:
      | ((response: [number, { suggestions: typeof tokyoTowerPrediction[] }]) => void)
      | undefined
    apiMock.resetHandlers()
    apiMock.onPost('/places/autocomplete').reply(
      () => new Promise((resolve) => {
        resolveAutocomplete = resolve
      }),
    )

    render(<Harness />)

    const input = screen.getByLabelText(/destination/i)
    await userEvent.type(input, 'Tokyo')
    await waitFor(() => {
      expect(autocompleteRequestFor('Tokyo')).toBeDefined()
      expect(resolveAutocomplete).toBeDefined()
    })

    fireEvent.blur(input)
    await act(async () => {
      resolveAutocomplete?.([200, { suggestions: [tokyoTowerPrediction] }])
    })

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()

    fireEvent.focus(input)

    expect(await screen.findByRole('listbox')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /tokyo tower/i })).toBeInTheDocument()
  })

  it('selects all text on focus when configured', async () => {
    render(<Harness initialValue="160 Piccadilly" selectOnFocus />)

    const input = screen.getByLabelText(/destination/i) as HTMLInputElement
    await userEvent.click(input)

    await waitFor(() => {
      expect(input.selectionStart).toBe(0)
      expect(input.selectionEnd).toBe('160 Piccadilly'.length)
    })
  })

  it('clears suggestions and search errors when the input is emptied', async () => {
    const onSearchError = vi.fn()

    render(<Harness initialValue="Tokyo" onSearchError={onSearchError} />)

    await userEvent.click(screen.getByLabelText(/destination/i))
    expect(await screen.findByRole('button', { name: /tokyo tower/i })).toBeInTheDocument()
    await userEvent.clear(screen.getByLabelText(/destination/i))

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(onSearchError).toHaveBeenLastCalledWith(null)
  })

  it('renders an explicit clear button that clears and refocuses the input', async () => {
    const onClear = vi.fn()
    const onSearchError = vi.fn()

    render(
      <Harness
        initialValue="Tokyo"
        onClear={onClear}
        onSearchError={onSearchError}
        showClearButton
      />,
    )

    const input = screen.getByLabelText(/destination/i)
    expect(screen.getByRole('button', { name: /clear search/i })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /clear search/i }))

    expect(input).toHaveValue('')
    expect(input).toHaveFocus()
    expect(onClear).toHaveBeenCalledOnce()
    expect(onSearchError).toHaveBeenLastCalledWith(null)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
  })
})

describe('Google place normalization', () => {
  it('can select places without fetching photo media', async () => {
    const prediction: GooglePlacePrediction = {
      mainText: 'Tokyo Tower',
      placeId: 'google.tokyo-tower',
      placeResourceName: 'places/google.tokyo-tower',
      secondaryText: 'Minato City, Tokyo',
      text: 'Tokyo Tower, Minato City, Tokyo',
      types: ['tourist_attraction'],
    }

    await expect(
      fetchGooglePlaceSelection({
        includePhoto: false,
        prediction,
        sessionToken: 'session-one',
      }),
    ).resolves.toMatchObject({
      displayName: 'Tokyo Tower',
      photoUrl: null,
    })

    const detailsCall = placeDetailsCall()
    expect(detailsCall?.params).toEqual({ sessionToken: 'session-one' })
    expect(apiMock.history.post.filter((request) => request.url === '/places/photo-url')).toHaveLength(0)
  })

  it('deduplicates simultaneous backend place detail requests for the same field mask', async () => {
    const prediction: GooglePlacePrediction = {
      mainText: 'Tokyo Tower',
      placeId: 'google.tokyo-tower',
      placeResourceName: 'places/google.tokyo-tower',
      secondaryText: 'Minato City, Tokyo',
      text: 'Tokyo Tower, Minato City, Tokyo',
      types: ['tourist_attraction'],
    }

    await Promise.all([
      fetchGooglePlaceSelection({ includePhoto: false, prediction }),
      fetchGooglePlaceSelection({ includePhoto: false, prediction }),
    ])

    expect(apiMock.history.get.filter((request) =>
      request.url === '/places/google.tokyo-tower/details',
    )).toHaveLength(1)
  })

  it('keeps successful place details fresh for 15 minutes and evicts them after one hour', async () => {
    let now = new Date('2026-07-13T12:00:00Z').valueOf()
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)
    const prediction: GooglePlacePrediction = {
      mainText: 'Tokyo Tower',
      placeId: 'google.tokyo-tower',
      placeResourceName: 'places/google.tokyo-tower',
      secondaryText: 'Minato City, Tokyo',
      text: 'Tokyo Tower, Minato City, Tokyo',
      types: ['tourist_attraction'],
    }

    await fetchGooglePlaceSelection({ includePhoto: false, prediction, sessionToken: 'first-session' })
    await fetchGooglePlaceSelection({ includePhoto: false, prediction, sessionToken: 'second-session' })

    expect(apiMock.history.get.filter((request) =>
      request.url === '/places/google.tokyo-tower/details',
    )).toHaveLength(1)

    now = new Date('2026-07-13T12:15:01Z').valueOf()
    await fetchGooglePlaceSelection({ includePhoto: false, prediction })

    expect(apiMock.history.get.filter((request) =>
      request.url === '/places/google.tokyo-tower/details',
    )).toHaveLength(2)

    now = new Date('2026-07-13T13:16:02Z').valueOf()
    await fetchGooglePlaceSelection({ includePhoto: false, prediction })

    expect(apiMock.history.get.filter((request) =>
      request.url === '/places/google.tokyo-tower/details',
    )).toHaveLength(3)
    nowSpy.mockRestore()
  })

  it('passes an AbortSignal to autocomplete requests', async () => {
    const controller = new AbortController()
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal)
      return new Response(JSON.stringify({ suggestions: [] }), { status: 200 })
    })

    await fetchGooglePlaceSuggestions({
      fetchImpl,
      query: 'Tokyo',
      sessionToken: 'session-one',
      signal: controller.signal,
    })

    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('normalizes Places Photo (New) media URLs to HTTPS only', async () => {
    apiMock.resetHandlers()
    apiMock
      .onPost('/places/photo-url')
      .replyOnce(200, { photoUrl: '//lh3.example.com/photo.jpg' })
      .onPost('/places/photo-url')
      .replyOnce(200, { photoUrl: 'http://example.com/insecure.jpg' })

    await expect(
      imageUrlFromGooglePhotoName({
        photoName: 'places/google.tokyo-tower/photos/photo1',
      }),
    ).resolves.toBe('https://lh3.example.com/photo.jpg')

    await expect(
      imageUrlFromGooglePhotoName({
        photoName: 'places/google.tokyo-tower/photos/photo1',
      }),
    ).resolves.toBeNull()
  })

  it('falls back to prediction text when place fields are sparse', () => {
    const prediction: GooglePlacePrediction = {
      mainText: 'Tokyo Tower',
      placeId: 'google.tokyo-tower',
      placeResourceName: 'places/google.tokyo-tower',
      secondaryText: 'Minato City, Tokyo',
      text: 'Tokyo Tower, Minato City, Tokyo',
      types: ['tourist_attraction'],
    }

    expect(normalizeGooglePlace({}, prediction, null)).toMatchObject({
      businessStatus: null,
      currentOpeningHours: null,
      displayName: 'Tokyo Tower',
      formattedAddress: 'Minato City, Tokyo',
      googleMapsUri: null,
      id: 'google.tokyo-tower',
      lat: null,
      lng: null,
      photoUrl: null,
      rating: null,
      regularOpeningHours: null,
      reviews: [],
      text: 'Tokyo Tower, Minato City, Tokyo',
      types: ['tourist_attraction'],
      userRatingCount: null,
      websiteUri: null,
    })
  })

  it('fetches text search results for map search details', async () => {
    apiMock.resetHandlers()
    apiMock.onPost('/places/text-search').reply(200, {
      nextPageToken: 'next-page',
      places: [{
        businessStatus: 'OPERATIONAL',
        currentOpeningHours: { openNow: true },
        displayName: { text: 'Ramen Street' },
        formattedAddress: 'Tokyo Station, Tokyo',
        googleMapsUri: 'https://maps.google.com/?cid=ramen',
        id: 'google.ramen-street',
        location: { latitude: 35.6812, longitude: 139.7671 },
        name: 'places/google.ramen-street',
        primaryType: 'restaurant',
        primaryTypeDisplayName: { text: 'Restaurant' },
        rating: 4.4,
        regularOpeningHours: {
          weekdayDescriptions: ['Friday: 10:00 AM – 10:00 PM'],
        },
        types: ['restaurant'],
        userRatingCount: 1200,
      }],
    })

    await expect(
      fetchGooglePlaceTextSearch({
        options: { proximity: { lat: 35.6586, lng: 139.7454 } },
        query: 'ramen near tokyo station',
      }),
    ).resolves.toEqual({
      nextPageToken: 'next-page',
      places: [
        expect.objectContaining({
          businessStatus: 'OPERATIONAL',
          currentOpeningHours: { openNow: true, weekdayDescriptions: [] },
          displayName: 'Ramen Street',
          formattedAddress: 'Tokyo Station, Tokyo',
          googleMapsUri: 'https://maps.google.com/?cid=ramen',
          lat: 35.6812,
          lng: 139.7671,
          rating: 4.4,
          regularOpeningHours: {
            openNow: null,
            weekdayDescriptions: ['Friday: 10:00 AM – 10:00 PM'],
          },
          reviews: [],
          userRatingCount: 1200,
        }),
      ],
    })

    const textSearchCall = apiMock.history.post.find((request) => request.url === '/places/text-search')
    expect(textSearchCall?.params).toEqual({ includePhoto: false })
    expect(requestData(textSearchCall)).toMatchObject({
      pageSize: 10,
      textQuery: 'ramen near tokyo station',
    })
  })

  it('fetches a nearby place for coordinate map clicks', async () => {
    apiMock.resetHandlers()
    apiMock.onPost('/places/nearby-search').reply(200, {
      places: [{
        businessStatus: 'OPERATIONAL',
        currentOpeningHours: { openNow: true },
        displayName: { text: 'Clicked Cafe' },
        formattedAddress: 'Nearby address',
        googleMapsUri: 'https://maps.google.com/?cid=clicked-cafe',
        id: 'google.clicked-cafe',
        location: { latitude: 35.7002, longitude: 139.8002 },
        name: 'places/google.clicked-cafe',
        primaryType: 'cafe',
        primaryTypeDisplayName: { text: 'Cafe' },
        rating: 4.7,
        types: ['cafe', 'food'],
        userRatingCount: 42,
      }],
    })

    await expect(
      fetchGooglePlaceNearLocation({
        options: {
          language: 'en',
          location: { lat: 35.7, lng: 139.8 },
          radius: 100,
        },
      }),
    ).resolves.toEqual(expect.objectContaining({
      businessStatus: 'OPERATIONAL',
      currentOpeningHours: { openNow: true, weekdayDescriptions: [] },
      displayName: 'Clicked Cafe',
      formattedAddress: 'Nearby address',
      googleMapsUri: 'https://maps.google.com/?cid=clicked-cafe',
      id: 'google.clicked-cafe',
      lat: 35.7002,
      lng: 139.8002,
      rating: 4.7,
      types: ['cafe', 'food'],
      userRatingCount: 42,
    }))

    const nearbyCall = apiMock.history.post.find((request) => request.url === '/places/nearby-search')
    expect(nearbyCall?.params).toEqual({ includePhoto: false })
    expect(requestData(nearbyCall)).toMatchObject({
      languageCode: 'en',
      locationRestriction: {
        circle: {
          center: { latitude: 35.7, longitude: 139.8 },
          radius: 100,
        },
      },
      maxResultCount: 1,
      rankPreference: 'DISTANCE',
    })
  })

  it('uses the first valid nearby place when earlier results cannot be normalized', async () => {
    apiMock.resetHandlers()
    apiMock.onPost('/places/nearby-search').reply(200, {
      places: [
        {
          id: 'google.empty-nearby-result',
          name: 'places/google.empty-nearby-result',
        },
        {
          businessStatus: 'OPERATIONAL',
          displayName: { text: 'Valid Nearby Restaurant' },
          formattedAddress: 'Valid nearby address',
          googleMapsUri: 'https://maps.google.com/?cid=valid-nearby',
          id: 'google.valid-nearby',
          location: { latitude: 35.7003, longitude: 139.8003 },
          name: 'places/google.valid-nearby',
          primaryType: 'restaurant',
          primaryTypeDisplayName: { text: 'Restaurant' },
          rating: 4.5,
          types: ['restaurant', 'food'],
          userRatingCount: 18,
        },
      ],
    })

    await expect(
      fetchGooglePlaceNearLocation({
        maxResultCount: 10,
        options: {
          language: 'en',
          location: { lat: 35.7, lng: 139.8 },
          radius: 500,
        },
      }),
    ).resolves.toEqual(expect.objectContaining({
      displayName: 'Valid Nearby Restaurant',
      formattedAddress: 'Valid nearby address',
      id: 'google.valid-nearby',
      lat: 35.7003,
      lng: 139.8003,
      primaryType: 'restaurant',
    }))
  })

  it('builds category text search requests with viewport restriction and type normalization', () => {
    expect(googlePlaceCategoryTypeForQuery('restaurants')).toBe('restaurant')

    expect(
      buildGooglePlacesTextSearchRequest(
        'restaurants',
        {
          includedType: 'restaurant',
          locationRestriction: {
            low: { lat: 35.6, lng: 139.7 },
            high: { lat: 35.7, lng: 139.8 },
          },
          rankPreference: 'RELEVANCE',
        },
        10,
      ),
    ).toMatchObject({
      includedType: 'restaurant',
      locationRestriction: {
        rectangle: {
          low: { latitude: 35.6, longitude: 139.7 },
          high: { latitude: 35.7, longitude: 139.8 },
        },
      },
      pageSize: 10,
      rankPreference: 'RELEVANCE',
      textQuery: 'restaurants',
    })
  })

  it('builds nearby search requests with finite coordinates', () => {
    expect(
      buildGooglePlacesNearbySearchRequest({
        location: { lat: 35.7, lng: 139.8 },
      }),
    ).toMatchObject({
      locationRestriction: {
        circle: {
          center: { latitude: 35.7, longitude: 139.8 },
          radius: 75,
        },
      },
      maxResultCount: 1,
      rankPreference: 'DISTANCE',
    })
  })
})
