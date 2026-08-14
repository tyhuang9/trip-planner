import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OutageBoundary } from './OutageBoundary'
import { __resetOutageMonitorForTests, reportAmbiguousBackendFailure } from './outageMonitor'

function app() {
  return <OutageBoundary><main id="main">Trip planner</main></OutageBoundary>
}

function reportRuntimeFailure() {
  reportAmbiguousBackendFailure({ response: { status: 500 } } as never)
}

afterEach(() => {
  __resetOutageMonitorForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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

  it('diagnoses a server incident and focuses its alert heading', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })))
    render(app())
    reportRuntimeFailure()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/render app service/i)
    expect(alert).toHaveTextContent(/ran out of road-trip snacks/i)
    expect(within(alert).getByRole('heading')).toHaveFocus()
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })

  it('uses cautious server copy when a runtime liveness probe is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')))
    render(app())
    reportRuntimeFailure()
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveAttribute('data-kind', 'server-unreachable')
    expect(alert).toHaveTextContent(/wandered off the map/i)
  })

  it('renders database diagnosis, retries, recovers, and restores main focus', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(app())
    reportRuntimeFailure()
    expect(await screen.findByRole('alert')).toHaveTextContent(/neon database/i)
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
})
