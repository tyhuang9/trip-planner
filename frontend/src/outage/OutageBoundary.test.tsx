import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OutageBoundary, OUTAGE_RECHECK_INTERVAL_MS } from './OutageBoundary'
import {
  __resetOutageMonitorForTests,
  reportAmbiguousBackendFailure,
} from './outageMonitor'

function app() {
  return <OutageBoundary><main id="main">Trip planner</main></OutageBoundary>
}

function reportRuntimeFailure() {
  reportAmbiguousBackendFailure()
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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  Reflect.deleteProperty(navigator, 'onLine')
})

describe('<OutageBoundary> runtime incidents', () => {
  it('does not perform health probes simply by mounting', () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(app())

    expect(screen.getByRole('main')).toHaveTextContent('Trip planner')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('diagnoses a server incident with provider-neutral copy and focuses its heading', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })))
    render(app())
    reportRuntimeFailure()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/trip planning service/i)
    expect(alert).toHaveTextContent(/ran out of road-trip snacks/i)
    expect(alert).not.toHaveTextContent(/render/i)
    await waitFor(() => expect(within(alert).getByRole('heading')).toHaveFocus())
  })

  it('uses cautious provider-neutral copy when a runtime liveness probe is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')))
    render(app())
    reportRuntimeFailure()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveAttribute('data-kind', 'server-unreachable')
    expect(alert).toHaveTextContent(/wandered off the map/i)
    expect(alert).not.toHaveTextContent(/render/i)
  })

  it('renders a neutral database diagnosis, retries, recovers, and restores main focus', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(app())
    reportRuntimeFailure()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/trip database/i)
    expect(alert).not.toHaveTextContent(/neon/i)
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))

    const main = await screen.findByRole('main')
    expect(main).toHaveTextContent('Trip planner')
    expect(main).toHaveFocus()
    expect(main).not.toHaveAttribute('tabindex')
  })

  it('keeps retry feedback scoped to the current incident', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    render(app())
    reportRuntimeFailure()
    await screen.findByRole('alert')

    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(await screen.findByRole('status')).toHaveTextContent(/still no answer/i)
    reportRuntimeFailure()

    await waitFor(() => expect(screen.getByRole('alert')).toHaveAttribute('data-kind', 'database'))
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('quietly rechecks and recovers when the app returns to the foreground', async () => {
    let databaseStatus = 503
    vi.stubGlobal('fetch', healthFetch(() => 200, () => databaseStatus))
    render(app())
    reportRuntimeFailure()
    await screen.findByRole('alert')

    databaseStatus = 200
    window.dispatchEvent(new Event('focus'))

    expect(await screen.findByText('Trip planner')).toBeInTheDocument()
  })

  it('quietly rechecks and recovers when connectivity returns', async () => {
    let databaseStatus = 503
    vi.stubGlobal('fetch', healthFetch(() => 200, () => databaseStatus))
    render(app())
    reportRuntimeFailure()
    await screen.findByRole('alert')

    databaseStatus = 200
    window.dispatchEvent(new Event('online'))

    expect(await screen.findByText('Trip planner')).toBeInTheDocument()
  })

  it('recovers automatically on the quiet outage interval', async () => {
    vi.useFakeTimers()
    let databaseStatus = 503
    vi.stubGlobal('fetch', healthFetch(() => 200, () => databaseStatus))
    render(app())
    reportRuntimeFailure()
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByRole('alert')).toHaveTextContent(/trip database/i)

    databaseStatus = 200
    await act(async () => {
      await vi.advanceTimersByTimeAsync(OUTAGE_RECHECK_INTERVAL_MS)
    })

    expect(screen.getByText('Trip planner')).toBeInTheDocument()
  })

  it('shows the connectivity page without making a request when offline', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    render(app())
    reportRuntimeFailure()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/internet missed the bus/i)
    expect(alert).toHaveTextContent(/unscheduled layover/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
