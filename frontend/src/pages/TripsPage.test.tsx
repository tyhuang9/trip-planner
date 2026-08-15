import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MockAdapter from 'axios-mock-adapter'
import type { PropsWithChildren } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryRouter, Route, Routes } from 'react-router'
import { apiClient } from '../api/client'
import { AuthContext, type AuthContextValue } from '../auth/authContextValue'
import type { GooglePlaceSearchOptions, GooglePlaceSelection } from '../components/googlePlaces'
import { ColorModeProvider } from '../theme/ColorModeProvider'
import type { Trip } from '../types/trip'
import { selectTripVisualKey } from '../utils/tripVisuals'
import { NewTripPage } from './NewTripPage'
import { TripsPage } from './TripsPage'

const searchBoxState = vi.hoisted(() => ({
  props: null as null | {
    onPlaceSelect?: (place: GooglePlaceSelection) => void
    onValueChange?: (value: string) => void
    options?: GooglePlaceSearchOptions
    value?: string
  },
}))

vi.mock('../components/GooglePlaceAutocomplete', () => ({
  GooglePlaceAutocomplete: (props: typeof searchBoxState.props & { inputLabel?: string }) => {
    searchBoxState.props = props
    return (
      <input
        aria-label={props?.inputLabel ?? 'Destination'}
        value={props?.value ?? ''}
        onChange={(event) => props?.onValueChange?.(event.target.value)}
      />
    )
  },
}))

let apiMock: MockAdapter
let queryClient: QueryClient

const SAMPLE_TRIP: Trip = {
  publicId: 'abc234def567',
  name: 'Tokyo 2026',
  destination: 'Tokyo, Japan',
  startDate: '2026-05-01',
  endDate: '2026-05-05',
  imageUrl: null,
  createdAt: '2026-05-22T16:00:00Z',
  role: 'OWNER',
  version: 0,
}

const PARIS_TRIP: Trip = {
  publicId: 'paris987',
  name: 'Paris spring',
  destination: 'Paris, France',
  startDate: '2026-04-10',
  endDate: '2026-04-14',
  imageUrl: null,
  createdAt: '2026-01-10T16:00:00Z',
  role: 'EDITOR',
  version: 0,
}

const COASTAL_TRIP: Trip = {
  publicId: 'coast321',
  name: 'Coastal reset',
  destination: 'Oregon Coast',
  startDate: '2026-08-01',
  endDate: '2026-08-03',
  imageUrl: null,
  createdAt: '2026-01-12T16:00:00Z',
  role: 'VIEWER',
  version: 0,
}

function makeAuth(overrides: Partial<AuthContextValue> = {}): AuthContextValue {
  return {
    authStatus: 'authenticated',
    user: { id: 1, email: 'a@b.com', displayName: 'A', emailVerified: true },
    isAuthenticated: true,
    isInitializing: false,
    retryAuthResolution: vi.fn(async () => {}),
    login: vi.fn(async () => ({
      id: 1,
      email: 'a@b.com',
      displayName: 'A',
      emailVerified: true,
    })),
    register: vi.fn(async () => ({
      status: 'verification_required' as const,
      email: 'a@b.com',
    })),
    updateProfile: vi.fn(async () => ({
      id: 1,
      email: 'a@b.com',
      displayName: 'A',
      emailVerified: true,
    })),
    changePassword: vi.fn(async () => {}),
    requestPasswordReset: vi.fn(async () => {}),
    resendEmailVerification: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    deleteAccount: vi.fn(async () => {}),
    ...overrides,
  }
}

function Providers({
  children,
  auth = makeAuth(),
}: PropsWithChildren<{ auth?: AuthContextValue }>) {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={auth}>
        <ColorModeProvider>
          {children}
        </ColorModeProvider>
      </AuthContext.Provider>
    </QueryClientProvider>
  )
}

function renderTrips(auth?: AuthContextValue) {
  return render(
    <Providers auth={auth}>
      <MemoryRouter initialEntries={['/trips']}>
        <Routes>
          <Route path="/trips" element={<TripsPage />} />
          <Route
            path="/trips/new"
            element={<div data-testid="new-trip">NEW TRIP</div>}
          />
          <Route
            path="/trips/:publicId"
            element={<div data-testid="workspace">WORKSPACE</div>}
          />
          <Route
            path="/login"
            element={<div data-testid="login">LOGIN</div>}
          />
        </Routes>
      </MemoryRouter>
    </Providers>,
  )
}

function renderNewTrip() {
  return render(
    <Providers>
      <MemoryRouter initialEntries={['/trips/new']}>
        <Routes>
          <Route path="/trips/new" element={<NewTripPage />} />
          <Route
            path="/trips/:publicId"
            element={<div data-testid="workspace">WORKSPACE</div>}
          />
          <Route
            path="/trips"
            element={<div data-testid="trips">TRIPS</div>}
          />
        </Routes>
      </MemoryRouter>
    </Providers>,
  )
}

function mockViewport(isMobile: boolean) {
  const matchMedia = vi.fn((query: string) => ({
    matches: isMobile && query === '(max-width: 640px)',
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  }) as MediaQueryList)

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: matchMedia,
    writable: true,
  })
}

async function navigateDatePickerToMay2026() {
  for (let index = 0; index < 12; index += 1) {
    if (screen.queryByRole('heading', { name: /may 2026/i })) return
    await userEvent.click(screen.getByRole('button', { name: /previous month/i }))
  }
  expect(screen.getByRole('heading', { name: /may 2026/i })).toBeInTheDocument()
}

async function selectMayTripDates(startDay: number, endDay: number) {
  await userEvent.click(screen.getByRole('button', { name: /trip dates/i }))
  await navigateDatePickerToMay2026()
  await userEvent.click(screen.getByRole('button', {
    name: new RegExp(`choose .*may ${startDay}, 2026`, 'i'),
  }))
  await userEvent.click(screen.getByRole('button', {
    name: new RegExp(`choose .*may ${endDay}, 2026`, 'i'),
  }))
  await userEvent.click(screen.getByRole('button', { name: /done/i }))
}

beforeEach(() => {
  vi.stubEnv('VITE_GOOGLE_MAPS_API_KEY', 'gmaps.test')
  mockViewport(false)
  window.localStorage.clear()
  searchBoxState.props = null
  apiMock = new MockAdapter(apiClient)
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
})

afterEach(() => {
  apiMock.restore()
  queryClient.clear()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('<TripsPage>', () => {
  it('renders trips from the API', async () => {
    apiMock.onGet('/trips').reply(200, [
      { ...SAMPLE_TRIP, imageUrl: 'https://example.com/tokyo.jpg' },
    ])

    const { container } = renderTrips()

    expect(screen.getByText(/loading trips/i)).toBeInTheDocument()
    const tripLink = await screen.findByRole('link', { name: /tokyo 2026/i })
    expect(tripLink).toHaveAttribute(
      'href',
      '/trips/abc234def567',
    )
    expect(tripLink).toHaveAccessibleName(/5 days/i)
    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      'https://example.com/tokyo.jpg',
    )
    expect(screen.getByText(/Tokyo, Japan/)).toBeInTheDocument()
    expect(screen.getByText(/May 1, 2026 - May 5, 2026/)).toBeInTheDocument()
    expect(screen.getAllByText(/owner/i).length).toBeGreaterThan(0)
  })

  it('filters trips by search text and role', async () => {
    apiMock
      .onGet('/trips')
      .reply(200, [SAMPLE_TRIP, PARIS_TRIP, COASTAL_TRIP])

    renderTrips()

    expect(
      await screen.findByRole('link', { name: /open tokyo 2026/i }),
    ).toBeInTheDocument()

    const searchInput = screen.getByLabelText(/search trips/i)

    await userEvent.type(searchInput, 'paris')

    expect(
      screen.getByRole('link', { name: /open paris spring/i }),
    ).toBeInTheDocument()
    expect(screen.getByRole('list', { name: /^trips$/i }).className).not.toContain(
      'tripGridSingle',
    )
    expect(
      screen.queryByRole('link', { name: /open tokyo 2026/i }),
    ).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /viewer/i }))

    expect(
      screen.getByText(/no trips match your filters/i),
    ).toBeInTheDocument()

    const clearFiltersButton = screen.getByRole('button', { name: /clear filters/i })
    await userEvent.click(clearFiltersButton)

    expect(searchInput).not.toHaveFocus()
    expect(
      screen.getByRole('link', { name: /open coastal reset/i }),
    ).toBeInTheDocument()
    expect(screen.getByText(/showing 3 of 3 trips/i)).toBeInTheDocument()
  })

  it('keeps desktop header actions unchanged', async () => {
    apiMock.onGet('/trips').reply(200, [SAMPLE_TRIP])

    renderTrips()

    expect(await screen.findByRole('link', { name: /^new trip$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^account$/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^sign out$/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /open account menu/i })).not.toBeInTheDocument()
  })

  it('uses an accessible mobile account menu and restores focus after Escape', async () => {
    mockViewport(true)
    apiMock.onGet('/trips').reply(200, [SAMPLE_TRIP])
    const user = userEvent.setup()

    renderTrips()

    await screen.findByRole('link', { name: /open tokyo 2026/i })
    const trigger = screen.getByRole('button', { name: /open account menu/i })
    expect(screen.queryByRole('button', { name: /^account$/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^sign out$/i })).not.toBeInTheDocument()

    trigger.focus()
    await user.keyboard('{Enter}')
    const menu = await screen.findByRole('menu', { name: /account options/i })
    expect(trigger).toHaveAttribute('aria-expanded', 'true')
    await waitFor(() => {
      expect(within(menu).getByRole('menuitem', { name: /^account$/i })).toHaveFocus()
    })

    await user.keyboard('{Escape}')
    await waitFor(() => {
      expect(screen.queryByRole('menu', { name: /account options/i })).not.toBeInTheDocument()
      expect(trigger).toHaveFocus()
    })

    await user.click(trigger)
    await user.click(await screen.findByRole('menuitem', { name: /^account$/i }))
    expect(screen.getByRole('dialog', { name: /account settings/i })).toBeInTheDocument()
  })

  it('places New Trip beside the mobile trip-list context', async () => {
    mockViewport(true)
    apiMock.onGet('/trips').reply(200, [SAMPLE_TRIP])
    const user = userEvent.setup()

    renderTrips()

    const listHeading = await screen.findByRole('heading', { name: /^your trips$/i })
    const newTrip = screen.getByRole('link', { name: /^new trip$/i })
    expect(listHeading.parentElement).toContainElement(newTrip)

    await user.click(newTrip)
    expect(screen.getByTestId('new-trip')).toBeInTheDocument()
  })

  it('signs out from the mobile account menu', async () => {
    mockViewport(true)
    apiMock.onGet('/trips').reply(200, [])
    const auth = makeAuth()
    const user = userEvent.setup()

    renderTrips(auth)

    await user.click(await screen.findByRole('button', { name: /open account menu/i }))
    await user.click(await screen.findByRole('menuitem', { name: /^sign out$/i }))

    expect(auth.logout).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(screen.getByTestId('login')).toBeInTheDocument()
    })
  })

  it('deletes owner trips from the navigator', async () => {
    apiMock
      .onGet('/trips')
      .reply(200, [SAMPLE_TRIP, PARIS_TRIP])
      .onDelete('/trips/abc234def567')
      .reply(204)

    renderTrips()

    expect(
      await screen.findByRole('link', { name: /open tokyo 2026/i }),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /delete paris spring/i }),
    ).not.toBeInTheDocument()

    await userEvent.click(
      screen.getByRole('button', { name: /delete tokyo 2026/i }),
    )

    const dialog = screen.getByRole('alertdialog', { name: /delete trip/i })
    expect(dialog).toHaveTextContent('Delete "Tokyo 2026"? This cannot be undone.')
    await userEvent.click(screen.getByRole('button', { name: /^delete trip$/i }))

    await waitFor(() => {
      expect(apiMock.history.delete[0].url).toBe('/trips/abc234def567')
    })
    expect(
      screen.queryByRole('link', { name: /open tokyo 2026/i }),
    ).not.toBeInTheDocument()
    expect(
      screen.getByRole('link', { name: /open paris spring/i }),
    ).toBeInTheDocument()
  })

  it('renders an empty state with a create link', async () => {
    apiMock.onGet('/trips').reply(200, [])

    renderTrips()

    expect(await screen.findByText(/no trips yet/i)).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: /new trip/i })[0]).toHaveAttribute(
      'href',
      '/trips/new',
    )
  })

  it('shows a retryable error state', async () => {
    apiMock.onGet('/trips').replyOnce(500, {}).onGet('/trips').reply(200, [])

    renderTrips()

    expect(
      await screen.findByText(/server ran into a problem/i),
    ).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /retry/i }))

    expect(await screen.findByText(/no trips yet/i)).toBeInTheDocument()
  })

  it('signs out and navigates to login', async () => {
    apiMock.onGet('/trips').reply(200, [])
    const auth = makeAuth()

    renderTrips(auth)

    await userEvent.click(await screen.findByRole('button', { name: /sign out/i }))

    expect(auth.logout).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(screen.getByTestId('login')).toBeInTheDocument()
    })
  })

  it('opens account settings from the trips page and saves profile changes', async () => {
    apiMock.onGet('/trips').reply(200, [])
    const auth = makeAuth({
      updateProfile: vi.fn(async (body) => ({
        id: 1,
        email: 'a@b.com',
        displayName: body.displayName,
        emailVerified: true,
      })),
    })

    renderTrips(auth)

    await userEvent.click(await screen.findByRole('button', { name: /account/i }))
    expect(
      screen.getByRole('dialog', { name: /account settings/i }),
    ).toBeInTheDocument()

    const displayNameInput = screen.getByLabelText(/display name/i)
    await userEvent.clear(displayNameInput)
    await userEvent.type(displayNameInput, 'Alice Chen')
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }))

    await waitFor(() => {
      expect(auth.updateProfile).toHaveBeenCalledWith({ displayName: 'Alice Chen' })
      expect(
        screen.queryByRole('dialog', { name: /account settings/i }),
      ).not.toBeInTheDocument()
    })
  })

  it('requires confirmation and current password before deleting and returning to login', async () => {
    apiMock.onGet('/trips').reply(200, [])
    const auth = makeAuth()

    renderTrips(auth)

    await userEvent.click(await screen.findByRole('button', { name: /account/i }))
    await userEvent.click(screen.getByRole('button', { name: /^delete account$/i }))

    const dialog = screen.getByRole('alertdialog', { name: /delete account/i })
    const confirmButton = within(dialog).getByRole('button', {
      name: /^delete account$/i,
    })
    expect(confirmButton).toBeDisabled()

    await userEvent.type(within(dialog).getByLabelText(/confirmation/i), 'delete')
    expect(confirmButton).toBeDisabled()
    await userEvent.type(within(dialog).getByLabelText(/current password/i), 'current-secret')
    expect(confirmButton).toBeEnabled()
    await userEvent.click(confirmButton)

    await waitFor(() => {
      expect(auth.deleteAccount).toHaveBeenCalledWith({
        currentPassword: 'current-secret',
      })
    })
    expect(screen.getByTestId('login')).toBeInTheDocument()
  })
})

describe('selectTripVisualKey', () => {
  it('selects known destination visuals by whole-token hints', () => {
    expect(
      selectTripVisualKey({
        name: 'Tokyo 2026',
        destination: 'Tokyo, Japan',
      }),
    ).toBe('tokyo')
    expect(
      selectTripVisualKey({
        name: 'Paris spring',
        destination: 'France',
      }),
    ).toBe('paris')
    expect(
      selectTripVisualKey({
        name: 'Coastal reset',
        destination: 'Oregon Coast',
      }),
    ).toBe('coastal')
  })

  it('uses the generic visual when hints only appear inside another word', () => {
    expect(
      selectTripVisualKey({
        name: 'Seattle weekend',
        destination: 'Seattle, Washington',
      }),
    ).toBe('generic')
    expect(
      selectTripVisualKey({
        name: 'Japanese garden walk',
        destination: 'Kyoto',
      }),
    ).toBe('generic')
  })
})

describe('<NewTripPage>', () => {
  it('uses the form cancel action as the only return navigation', () => {
    renderNewTrip()

    expect(screen.queryByRole('link', { name: /back to trips/i })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /^cancel$/i })).toHaveAttribute('href', '/trips')
  })

  it('validates required fields before submitting', async () => {
    renderNewTrip()

    await userEvent.click(screen.getByRole('button', { name: /create trip/i }))

    expect(await screen.findByText(/trip name is required/i)).toBeInTheDocument()
    expect(screen.getByText(/start date is required/i)).toBeInTheDocument()
    expect(screen.getByText(/end date is required/i)).toBeInTheDocument()
    expect(apiMock.history.post).toHaveLength(0)
  })

  it('orders a backwards date selection into a valid trip range', async () => {
    apiMock.onPost('/trips').reply((config) => [
      201,
      {
        ...SAMPLE_TRIP,
        name: JSON.parse(config.data as string).name,
      },
    ])
    renderNewTrip()

    await userEvent.type(screen.getByLabelText(/trip name/i), 'Tokyo 2026')
    await selectMayTripDates(5, 1)
    await userEvent.click(screen.getByRole('button', { name: /create trip/i }))

    await waitFor(() => {
      expect(screen.getByTestId('workspace')).toBeInTheDocument()
    })
    expect(JSON.parse(apiMock.history.post[0].data as string)).toMatchObject({
      startDate: '2026-05-01',
      endDate: '2026-05-05',
    })
  })

  it('creates a trip and navigates to its workspace', async () => {
    apiMock.onPost('/trips').reply((config) => [
      201,
      {
        ...SAMPLE_TRIP,
        name: JSON.parse(config.data as string).name,
      },
    ])

    renderNewTrip()

    await userEvent.type(screen.getByLabelText(/trip name/i), 'Tokyo 2026')
    await userEvent.type(screen.getByLabelText(/destination/i), 'Tokyo, Japan')
    await selectMayTripDates(1, 5)
    await userEvent.click(screen.getByRole('button', { name: /create trip/i }))

    await waitFor(() => {
      expect(screen.getByTestId('workspace')).toBeInTheDocument()
    })
    expect(JSON.parse(apiMock.history.post[0].data as string)).toEqual({
      name: 'Tokyo 2026',
      destination: 'Tokyo, Japan',
      imageUrl: null,
      startDate: '2026-05-01',
      endDate: '2026-05-05',
    })
  })

  it('fills the destination from a selected Google suggestion', async () => {
    renderNewTrip()

    await userEvent.type(screen.getByLabelText(/trip name/i), 'Madison weekend')
    await userEvent.type(screen.getByLabelText(/destination/i), 'Madison')
    act(() => {
      searchBoxState.props?.onPlaceSelect?.({
        businessStatus: null,
        currentOpeningHours: null,
        displayName: 'Madison',
        formattedAddress: 'Wisconsin, United States',
        googleMapsUri: null,
        id: 'google.madison',
        lat: 43.0731,
        lng: -89.4012,
        photoName: 'places/google.madison/photos/main',
        photoUrl: 'https://example.com/madison.webp',
        primaryType: 'locality',
        primaryTypeDisplayName: 'Locality',
        rating: null,
        regularOpeningHours: null,
        reviews: [],
        text: 'Madison, Wisconsin, United States',
        types: ['locality'],
        userRatingCount: null,
        websiteUri: null,
      })
    })

    expect(screen.getByLabelText(/destination/i)).toHaveValue(
      'Madison, Wisconsin, United States',
    )
    expect(screen.getByLabelText(/cover image url/i)).toHaveValue(
      'https://example.com/madison.webp',
    )
    expect(searchBoxState.props?.options).toMatchObject({
      language: 'en',
    })
    expect(searchBoxState.props?.options).not.toHaveProperty('proximity')
  })

  it('does not overwrite the cover image from an unusable Google photo URL', async () => {
    renderNewTrip()

    await userEvent.type(screen.getByLabelText(/cover image url/i), 'https://example.com/original.webp')
    act(() => {
      searchBoxState.props?.onPlaceSelect?.({
        businessStatus: null,
        currentOpeningHours: null,
        displayName: 'Madison',
        formattedAddress: 'Wisconsin, United States',
        googleMapsUri: null,
        id: 'google.madison',
        lat: 43.0731,
        lng: -89.4012,
        photoName: null,
        photoUrl: 'http://example.com/insecure.webp',
        primaryType: 'locality',
        primaryTypeDisplayName: 'Locality',
        rating: null,
        regularOpeningHours: null,
        reviews: [],
        text: 'Madison, Wisconsin, United States',
        types: ['locality'],
        userRatingCount: null,
        websiteUri: null,
      })
    })

    expect(screen.getByLabelText(/destination/i)).toHaveValue(
      'Madison, Wisconsin, United States',
    )
    expect(screen.getByLabelText(/cover image url/i)).toHaveValue(
      'https://example.com/original.webp',
    )
  })

  it('surfaces server validation errors', async () => {
    apiMock.onPost('/trips').reply(400, {
      error: 'validation_failed',
      fieldErrors: [{ field: 'name', message: 'must not be blank' }],
    })

    renderNewTrip()

    await userEvent.type(screen.getByLabelText(/trip name/i), 'Tokyo 2026')
    await selectMayTripDates(1, 5)
    await userEvent.click(screen.getByRole('button', { name: /create trip/i }))

    expect(await screen.findByText(/must not be blank/i)).toBeInTheDocument()
    expect(screen.queryByTestId('workspace')).not.toBeInTheDocument()
  })
})
