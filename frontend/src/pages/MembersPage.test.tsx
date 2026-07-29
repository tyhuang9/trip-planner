import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import MockAdapter from 'axios-mock-adapter'
import type { PropsWithChildren } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiClient } from '../api/client'
import type { TripMember } from '../types/share'
import type { Trip } from '../types/trip'
import MembersPage from './MembersPage'

vi.mock('../hooks/useTripStream', () => ({
  useTripStream: vi.fn(),
}))

let apiMock: MockAdapter
let queryClient: QueryClient

const TRIP: Trip = {
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

const MEMBER: TripMember = {
  userId: 42,
  email: 'alice@example.com',
  displayName: 'Alice',
  role: 'OWNER',
}

const EDITOR_MEMBER: TripMember = {
  userId: 84,
  email: 'bob@example.com',
  displayName: 'Bob',
  role: 'EDITOR',
}

function Providers({ children }: PropsWithChildren) {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  )
}

function renderMembersPage() {
  return render(
    <Providers>
      <MemoryRouter initialEntries={['/trips/abc234def567/members']}>
        <Routes>
          <Route path="/trips/:publicId/members" element={<MembersPage />} />
        </Routes>
      </MemoryRouter>
    </Providers>,
  )
}

beforeEach(() => {
  apiMock = new MockAdapter(apiClient)
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  })
  apiMock.onGet('/trips/abc234def567').reply(200, TRIP)
})

afterEach(() => {
  apiMock.restore()
  queryClient.clear()
})

describe('<MembersPage>', () => {
  it('renders a members retry state instead of an empty state when members fail', async () => {
    apiMock.onGet('/trips/abc234def567/members').reply(500, { error: 'internal_error' })

    renderMembersPage()

    expect(await screen.findByRole('button', { name: /retry members/i })).toBeInTheDocument()
    expect(screen.queryByText('No members found.')).not.toBeInTheDocument()
  })

  it('is a members-only page and never fetches share links', async () => {
    apiMock.onGet('/trips/abc234def567/members').reply(200, [MEMBER])

    renderMembersPage()

    expect(await screen.findByText('Alice')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: /^members$/i })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: /create share link|active links/i })).not.toBeInTheDocument()
    expect(apiMock.history.get.map(({ url }) => url)).not.toContain('/trips/abc234def567/share-links')
  })

  it('shows removal controls only to the owner and never for the owner membership', async () => {
    apiMock.onGet('/trips/abc234def567/members').reply(200, [MEMBER, EDITOR_MEMBER])

    renderMembersPage()

    expect(await screen.findByRole('button', { name: 'Remove Bob' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Remove Alice' })).not.toBeInTheDocument()
  })

  it('does not show removal controls to non-owners', async () => {
    apiMock.resetHandlers()
    apiMock.onGet('/trips/abc234def567').reply(200, { ...TRIP, role: 'EDITOR' })
    apiMock.onGet('/trips/abc234def567/members').reply(200, [MEMBER, EDITOR_MEMBER])

    renderMembersPage()

    expect(await screen.findByText('Bob')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /remove bob/i })).not.toBeInTheDocument()
  })

  it('confirms removal, shows pending feedback, and removes the member', async () => {
    const user = userEvent.setup()
    let finishRemoval: (() => void) | undefined
    apiMock.onGet('/trips/abc234def567/members').replyOnce(200, [MEMBER, EDITOR_MEMBER])
    apiMock.onGet('/trips/abc234def567/members').reply(200, [MEMBER])
    apiMock.onDelete('/trips/abc234def567/members/84').reply(
      () => new Promise((resolve) => {
        finishRemoval = () => resolve([204])
      }),
    )

    renderMembersPage()

    await user.click(await screen.findByRole('button', { name: 'Remove Bob' }))
    expect(screen.getByRole('alertdialog', { name: 'Remove member?' })).toHaveTextContent(
      'Bob',
    )

    await user.click(screen.getByRole('button', { name: 'Remove member' }))
    expect(await screen.findByRole('button', { name: 'Removing...' })).toBeDisabled()

    await act(async () => {
      finishRemoval?.()
    })

    await waitFor(() => {
      expect(screen.queryByText('Bob')).not.toBeInTheDocument()
    })
    expect(apiMock.history.delete.map(({ url }) => url)).toEqual([
      '/trips/abc234def567/members/84',
    ])
  })

  it('keeps the confirmation open and surfaces an API error when removal fails', async () => {
    const user = userEvent.setup()
    apiMock.onGet('/trips/abc234def567/members').reply(200, [MEMBER, EDITOR_MEMBER])
    apiMock.onDelete('/trips/abc234def567/members/84').reply(500, {
      error: 'internal_error',
    })

    renderMembersPage()

    await user.click(await screen.findByRole('button', { name: 'Remove Bob' }))
    await user.click(screen.getByRole('button', { name: 'Remove member' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The server ran into a problem. Please try again.',
    )
    expect(screen.getByRole('alertdialog', { name: 'Remove member?' })).toBeInTheDocument()
  })
})
