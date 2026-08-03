import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode, useEffect } from 'react'
import userEvent from '@testing-library/user-event'
import MockAdapter from 'axios-mock-adapter'
import axios from 'axios'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { OutageBoundary, OUTAGE_RECHECK_INTERVAL_MS } from './OutageBoundary'
import { __resetOutageMonitorForTests } from './outageMonitor'
import { AuthProvider } from '../auth/AuthContext'
import { __resetRefreshSingletonForTests } from '../api/client'

let refreshMock: MockAdapter | null = null

function app() {
  return (
    <OutageBoundary>
      <main id="main">Trip planner</main>
    </OutageBoundary>
  )
}

function AuthMountProbe({ onMount }: { onMount: () => void }) {
  useEffect(onMount, [onMount])
  return <span>Authenticated app mounted</span>
}

function authApp(onMount: () => void) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return (
    <QueryClientProvider client={queryClient}>
      <OutageBoundary>
        <AuthProvider>
          <AuthMountProbe onMount={onMount} />
        </AuthProvider>
      </OutageBoundary>
    </QueryClientProvider>
  )
}

function healthFetch(livenessStatus: () => number, databaseStatus: () => number) {
  return vi.fn().mockImplementation((url: string) => Promise.resolve(
    new Response(null, {
      status: url.includes('/database') ? databaseStatus() : livenessStatus(),
    }),
  ))
}

afterEach(() => {
  __resetOutageMonitorForTests()
  __resetRefreshSingletonForTests()
  refreshMock?.restore()
  refreshMock = null
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  Reflect.deleteProperty(navigator, 'onLine')
})

describe('<OutageBoundary>', () => {
  it('waits for both startup probes before mounting auth or refreshing a session', async () => {
    const resolveProbes: Array<(value: Response) => void> = []
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => {
      resolveProbes.push(resolve)
    }))
    const authChildMounted = vi.fn()
    refreshMock = new MockAdapter(axios)
    refreshMock.onPost('/api/auth/refresh').reply(401, { error: 'unauthenticated' })
    vi.stubGlobal('fetch', fetchMock)
    render(authApp(authChildMounted))

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    expect(screen.getByRole('status')).toHaveTextContent(/checking dupert’s route/i)
    expect(authChildMounted).not.toHaveBeenCalled()
    expect(refreshMock.history.post).toHaveLength(0)

    resolveProbes.forEach((resolve) => resolve(new Response(null, { status: 200 })))

    await waitFor(() => expect(authChildMounted).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(refreshMock?.history.post).toHaveLength(1))
    expect(fetchMock.mock.calls[0][0]).toContain('/actuator/health/liveness')
    expect(fetchMock.mock.calls[1][0]).toContain('/actuator/health/database')
  })

  it('shows the playful Neon page instead of mounting auth when the database is down', async () => {
    const authChildMounted = vi.fn()
    refreshMock = new MockAdapter(axios)
    refreshMock.onPost('/api/auth/refresh').reply(401, { error: 'unauthenticated' })
    vi.stubGlobal('fetch', healthFetch(() => 200, () => 503))

    render(authApp(authChildMounted))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/neon database/i)
    expect(alert).toHaveTextContent(/database sat on the suitcase/i)
    expect(authChildMounted).not.toHaveBeenCalled()
    expect(refreshMock.history.post).toHaveLength(0)
  })

  it('shows the playful Render page when liveness fails', async () => {
    vi.stubGlobal('fetch', healthFetch(() => 503, () => 503))
    render(app())

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/render app service/i)
    expect(alert).toHaveTextContent(/ran out of road-trip snacks/i)
    expect(within(alert).getByRole('heading')).toHaveFocus()
  })

  it('uses cautious Render copy when an online liveness check is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')))
    render(app())

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveAttribute('data-kind', 'server-unreachable')
    expect(alert).toHaveTextContent(/wandered off the map/i)
  })

  it('deduplicates the dual startup probe across StrictMode effect replays', async () => {
    const fetchMock = healthFetch(() => 200, () => 200)
    vi.stubGlobal('fetch', fetchMock)
    render(<StrictMode>{app()}</StrictMode>)

    await screen.findByText('Trip planner')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('recovers through the manual retry and restores focus to the app landmark', async () => {
    let databaseStatus = 503
    vi.stubGlobal('fetch', healthFetch(() => 200, () => databaseStatus))
    render(app())
    await screen.findByRole('alert')

    databaseStatus = 200
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))

    const main = await screen.findByRole('main')
    expect(main).toHaveTextContent('Trip planner')
    expect(main).toHaveFocus()
    expect(main).not.toHaveAttribute('tabindex')
  })

  it('quietly rechecks on foreground without making the retry button look clicked', async () => {
    let databaseStatus = 503
    let resolveDatabase: ((value: Response) => void) | undefined
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (!url.includes('/database')) return Promise.resolve(new Response(null, { status: 200 }))
      if (databaseStatus === 503) return Promise.resolve(new Response(null, { status: 503 }))
      return new Promise<Response>((resolve) => {
        resolveDatabase = resolve
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(app())
    await screen.findByRole('alert')

    databaseStatus = 200
    window.dispatchEvent(new Event('focus'))
    await waitFor(() => expect(resolveDatabase).toBeDefined())
    const retryButton = screen.getByRole('button', { name: /try again/i })
    expect(retryButton).toBeEnabled()
    expect(retryButton).toHaveTextContent('Try again')

    resolveDatabase?.(new Response(null, { status: 200 }))
    expect(await screen.findByText('Trip planner')).toBeInTheDocument()
  })

  it('recovers automatically on the quiet outage interval', async () => {
    vi.useFakeTimers()
    let databaseStatus = 503
    vi.stubGlobal('fetch', healthFetch(() => 200, () => databaseStatus))
    render(app())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole('alert')).toHaveTextContent(/neon database/i)

    databaseStatus = 200
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OUTAGE_RECHECK_INTERVAL_MS)
    })

    expect(screen.getByText('Trip planner')).toBeInTheDocument()
  })

  it('shows the playful connectivity page without making a request when offline', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(app())

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/internet missed the bus/i)
    expect(alert).toHaveTextContent(/unscheduled layover/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
