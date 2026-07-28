import { afterEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { OutageBoundary } from './OutageBoundary'
import { __resetOutageMonitorForTests, reportAmbiguousBackendFailure } from './outageMonitor'

afterEach(() => {
  __resetOutageMonitorForTests()
  vi.unstubAllGlobals()
})

describe('<OutageBoundary>', () => {
  it('names the Render allowance when the server liveness probe is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })))
    render(<OutageBoundary><p>Trip planner</p></OutageBoundary>)

    reportAmbiguousBackendFailure({ response: { status: 500 } } as never)

    expect(await screen.findByRole('alert')).toHaveTextContent(/monthly render free-tier allowance has been reached/i)
  })

  it('unmounts the application for a database outage and remounts it after retry', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<OutageBoundary><p>Trip planner</p></OutageBoundary>)

    reportAmbiguousBackendFailure({ response: { status: 500 } } as never)
    await screen.findByRole('alert')
    expect(screen.getByRole('heading')).toHaveTextContent(/trips are safely waiting/i)
    expect(screen.getByRole('alert')).toHaveTextContent(/monthly neon free-tier allowance has been reached/i)
    expect(screen.queryByText('Trip planner')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    await waitFor(() => expect(screen.getByText('Trip planner')).toBeInTheDocument())
  })
})
