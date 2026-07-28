import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import { StrictMode } from 'react'
import userEvent from '@testing-library/user-event'
import { OutageBoundary } from './OutageBoundary'
import { __resetOutageMonitorForTests, reportAmbiguousBackendFailure } from './outageMonitor'

function app() {
  return (
    <OutageBoundary>
      <main id="main">Trip planner</main>
    </OutageBoundary>
  )
}

afterEach(() => {
  __resetOutageMonitorForTests()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  Reflect.deleteProperty(navigator, 'onLine')
})

describe('<OutageBoundary>', () => {
  it('starts one liveness-only probe on mount and passes through healthy content', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(app())

    expect(await screen.findByText('Trip planner')).toBeInTheDocument()
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    expect(fetchMock.mock.calls[0][0]).toContain('/actuator/health/liveness')
    expect(fetchMock.mock.calls[0][0]).not.toContain('/actuator/health/database')
  })

  it('deduplicates the mount health probe across StrictMode effect replays', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<StrictMode>{app()}</StrictMode>)

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })

  it('does not update or flash after unmount while its startup probe is in flight', async () => {
    let resolveLiveness: ((value: Response) => void) | undefined
    const fetchMock = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => {
      resolveLiveness = resolve
    }))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', fetchMock)
    const { unmount } = render(app())
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))

    unmount()
    resolveLiveness?.(new Response(null, { status: 503 }))
    await Promise.resolve()
    await Promise.resolve()

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('shows the definitive Render state with one alert, one retry status, and focused heading', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })))
    render(app())

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/render app service/i)
    expect(alert).toHaveTextContent(/used up its monthly render free-tier allowance/i)
    expect(alert).toHaveTextContent(/ran out of road-trip snacks/i)
    expect(alert).not.toHaveAttribute('aria-live')
    expect(within(alert).getByRole('heading')).toHaveFocus()
    expect(within(alert).queryByRole('button')).not.toBeInTheDocument()
    expect(within(alert).queryByRole('status')).not.toBeInTheDocument()
    expect(screen.getAllByRole('status')).toHaveLength(1)
  })

  it('uses cautious Render copy when an online liveness check is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network')))
    render(app())

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveAttribute('data-kind', 'server-unreachable')
    expect(alert).toHaveTextContent(/render app service/i)
    expect(alert).toHaveTextContent(/monthly free-tier allowance may be empty/i)
    expect(alert).toHaveTextContent(/wandered off the map/i)
  })

  it('shows a distinct Neon state and focuses the remounted main landmark after recovery', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(app())

    reportAmbiguousBackendFailure({ response: { status: 500 } } as never)
    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/neon database/i)
    expect(alert).toHaveTextContent(/used up its monthly neon free-tier allowance/i)
    expect(alert).toHaveTextContent(/database sat on the suitcase/i)
    expect(screen.queryByText('Trip planner')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /try again/i }))

    const main = await screen.findByRole('main')
    expect(main).toHaveTextContent('Trip planner')
    expect(main).toHaveFocus()
    expect(main).not.toHaveAttribute('tabindex')
  })

  it('uses neutral retry feedback and drops it when the incident kind changes', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    render(app())

    reportAmbiguousBackendFailure()
    await screen.findByRole('alert')
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Still no answer. Give it another poke whenever you’re ready.',
    )

    reportAmbiguousBackendFailure()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveAttribute('data-kind', 'database'))
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('clears feedback after recovery before the same incident kind recurs', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    render(app())

    reportAmbiguousBackendFailure()
    await screen.findByRole('alert')
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    await screen.findByText('Trip planner')

    reportAmbiguousBackendFailure()
    await screen.findByRole('alert')
    expect(screen.getByRole('alert')).toHaveAttribute('data-kind', 'server')
    expect(screen.getByRole('status')).toBeEmptyDOMElement()
  })

  it('keeps the connectivity state clear while giving it a playful travel mishap', async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    vi.stubGlobal('fetch', vi.fn())
    render(app())

    reportAmbiguousBackendFailure()

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent(/internet connection/i)
    expect(alert).toHaveTextContent(/internet missed the bus/i)
    expect(alert).toHaveTextContent(/unscheduled layover/i)
  })
})
