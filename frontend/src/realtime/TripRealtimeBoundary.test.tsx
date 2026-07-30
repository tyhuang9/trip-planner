import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import { useEffect, type PropsWithChildren } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useTripStream } from '../hooks/useTripStream'
import { useTrip } from '../hooks/useTrips'
import { TripRealtimeBoundary } from './TripRealtimeBoundary'
import { useTripRealtimeActivityBuffer } from './tripRealtimeActivityBuffer'
import { AuthContext, type AuthContextValue } from '../auth/authContextValue'
import { useAuthStore } from '../auth/authStore'

vi.mock('../hooks/useTripStream', () => ({
  useTripStream: vi.fn(),
}))

vi.mock('../hooks/useTrips', () => ({
  useTrip: vi.fn(() => ({ isSuccess: true })),
}))

const useTripStreamMock = vi.mocked(useTripStream)
const useTripMock = vi.mocked(useTrip)
const bufferingChildMounted = vi.fn()
let queryClient: QueryClient

function makeAuth(
  overrides: Partial<AuthContextValue> = {},
): AuthContextValue {
  return {
    authStatus: 'unauthenticated',
    user: null,
    isAuthenticated: false,
    isInitializing: false,
    retryAuthResolution: async () => undefined,
    login: async () => {
      throw new Error('Not used in this test.')
    },
    register: async () => {
      throw new Error('Not used in this test.')
    },
    updateProfile: async () => {
      throw new Error('Not used in this test.')
    },
    changePassword: async () => undefined,
    requestPasswordReset: async () => undefined,
    resendEmailVerification: async () => undefined,
    logout: async () => undefined,
    deleteAccount: async () => undefined,
    ...overrides,
  }
}

function Providers({ children }: PropsWithChildren) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}

function BufferingChild({ buffering }: { buffering: boolean }) {
  useEffect(() => {
    bufferingChildMounted()
  }, [])
  useTripRealtimeActivityBuffer(buffering)
  return <div>Trip child</div>
}

function boundaryTree(
  buffering = false,
  auth = makeAuth(),
  initialPath = '/trips/abc234def567',
) {
  return (
    <Providers>
      <AuthContext.Provider value={auth}>
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path="/trips/:publicId" element={<TripRealtimeBoundary />}>
              <Route index element={<BufferingChild buffering={buffering} />} />
              <Route path="members" element={<BufferingChild buffering={buffering} />} />
              <Route path="archive/members" element={<BufferingChild buffering={buffering} />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </Providers>
  )
}

function renderBoundary(
  buffering = false,
  auth = makeAuth(),
  initialPath = '/trips/abc234def567',
) {
  return render(boundaryTree(buffering, auth, initialPath))
}

function authenticateUser() {
  useAuthStore.getState().setSession({
    accessToken: 'jwt-access-token',
    expiresInSeconds: 900,
    user: {
      id: 200,
      email: 'bob@example.com',
      displayName: 'Bob',
      emailVerified: true,
    },
  })
}

beforeEach(() => {
  useAuthStore.getState().clearSession()
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  useTripMock.mockReturnValue({ isSuccess: true } as ReturnType<typeof useTrip>)
  bufferingChildMounted.mockReset()
})

afterEach(() => {
  useAuthStore.getState().clearSession()
})

describe('<TripRealtimeBoundary>', () => {
  it('owns one stream for the active trip route after access succeeds', () => {
    renderBoundary()

    expect(useTripMock).toHaveBeenCalledWith('abc234def567', { enabled: true })
    expect(useTripStreamMock).toHaveBeenLastCalledWith('abc234def567', {
      bufferActivityEvents: false,
      enabled: true,
    })
  })

  it('receives drag buffering state without giving the child stream ownership', async () => {
    const auth = makeAuth()
    const view = renderBoundary(false, auth)
    expect(bufferingChildMounted).toHaveBeenCalledOnce()

    view.rerender(boundaryTree(true, auth))

    await waitFor(() => {
      expect(useTripStreamMock).toHaveBeenLastCalledWith('abc234def567', {
        bufferActivityEvents: true,
        enabled: true,
      })
    })
    expect(bufferingChildMounted).toHaveBeenCalledOnce()
  })

  it('withholds the stream until the trip access query succeeds', () => {
    useTripMock.mockReturnValue({ isSuccess: false } as ReturnType<typeof useTrip>)

    act(() => {
      renderBoundary()
    })

    expect(useTripStreamMock).toHaveBeenLastCalledWith('abc234def567', {
      bufferActivityEvents: false,
      enabled: false,
    })
  })

  it.each([
    ['canonical', '/trips/abc234def567/members?tab=people#members'],
    ['trailing-slash', '/trips/abc234def567/members/?tab=people#members'],
  ])('withholds trip data and realtime for an unauthenticated %s Members route', (_kind, path) => {
    renderBoundary(false, makeAuth(), path)

    expect(useTripMock).toHaveBeenLastCalledWith(undefined, { enabled: false })
    expect(useTripStreamMock).toHaveBeenLastCalledWith(undefined, {
      bufferActivityEvents: false,
      enabled: false,
    })
  })

  it('preserves protected Members realtime behavior for an authenticated trailing-slash route', () => {
    authenticateUser()

    renderBoundary(
      false,
      makeAuth(),
      '/trips/abc234def567/members/?tab=people#members',
    )

    expect(useTripMock).toHaveBeenLastCalledWith('abc234def567', { enabled: true })
    expect(useTripStreamMock).toHaveBeenLastCalledWith('abc234def567', {
      bufferActivityEvents: false,
      enabled: true,
    })
  })

  it('does not treat another nested path ending in members as protected', () => {
    renderBoundary(false, makeAuth(), '/trips/abc234def567/archive/members')

    expect(useTripMock).toHaveBeenLastCalledWith('abc234def567', { enabled: true })
    expect(useTripStreamMock).toHaveBeenLastCalledWith('abc234def567', {
      bufferActivityEvents: false,
      enabled: true,
    })
  })

  it('hides a cached trip workspace while authentication is unresolved', () => {
    queryClient.setQueryData(['trips', 'detail', 'abc234def567'], {
      name: 'Cached private trip',
    })
    queryClient.setQueryData(['activities', 'abc234def567'], [
      { id: 1, title: 'Cached private activity' },
    ])

    renderBoundary(
      false,
      makeAuth({ authStatus: 'offline-unknown', isInitializing: true }),
    )

    expect(screen.queryByText('Trip child')).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: /could not confirm your session/i }),
    ).toBeInTheDocument()
    expect(useTripMock).toHaveBeenLastCalledWith(undefined, { enabled: false })
    expect(useTripStreamMock).toHaveBeenLastCalledWith(undefined, {
      bufferActivityEvents: false,
      enabled: false,
    })
  })

  it('unmounts the workspace during the confirmed-session clearing boundary', () => {
    queryClient.setQueryData(['trips', 'detail', 'abc234def567'], {
      name: 'Cached private trip',
    })

    renderBoundary(
      false,
      makeAuth({ authStatus: 'clearing-session', isInitializing: true }),
    )

    expect(screen.queryByText('Trip child')).not.toBeInTheDocument()
    expect(
      screen.getByRole('heading', { name: /preparing your trip planner/i }),
    ).toBeInTheDocument()
    expect(useTripMock).toHaveBeenLastCalledWith(undefined, { enabled: false })
  })
})
