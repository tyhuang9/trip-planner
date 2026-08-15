import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AppAccessGate } from './AppAccessGate'
import { StartupBoundary } from '../startup/StartupBoundary'
import {
  APP_ACCESS_DURATION_MS,
  APP_ACCESS_STORAGE_KEY,
} from './appAccessGateState'

function renderGate() {
  return render(
    <AppAccessGate>
      <div data-testid="app-content">Trip app</div>
    </AppAccessGate>,
  )
}

beforeEach(() => {
  window.localStorage.clear()
  vi.stubEnv('VITE_APP_ACCESS_PASSWORD', 'let-me-in')
})

afterEach(() => {
  window.localStorage.clear()
  vi.unstubAllEnvs()
})

describe('<AppAccessGate>', () => {
  it('shows the password screen when no valid unlock exists', () => {
    renderGate()

    expect(screen.getByRole('heading', { name: /private trip planner/i }))
      .toBeInTheDocument()
    expect(screen.getByLabelText(/access password/i)).toBeInTheDocument()
    expect(screen.queryByTestId('app-content')).not.toBeInTheDocument()
  })

  it('rejects a wrong password and keeps the app hidden', async () => {
    renderGate()

    await userEvent.type(screen.getByLabelText(/access password/i), 'wrong')
    await userEvent.click(screen.getByRole('button', { name: /continue/i }))

    expect(screen.getByRole('alert')).toHaveTextContent('That password does not match.')
    expect(screen.queryByTestId('app-content')).not.toBeInTheDocument()
    expect(window.localStorage.getItem(APP_ACCESS_STORAGE_KEY)).toBeNull()
  })

  it('accepts the configured password and stores a 30-day unlock', async () => {
    const startedAt = Date.now()
    renderGate()

    await userEvent.type(screen.getByLabelText(/access password/i), 'let-me-in')
    await userEvent.click(screen.getByRole('button', { name: /continue/i }))

    expect(screen.getByTestId('app-content')).toBeInTheDocument()
    const unlockedUntil = Number(window.localStorage.getItem(APP_ACCESS_STORAGE_KEY))
    expect(unlockedUntil).toBeGreaterThanOrEqual(startedAt + APP_ACCESS_DURATION_MS)
    expect(unlockedUntil).toBeLessThanOrEqual(Date.now() + APP_ACCESS_DURATION_MS)
  })

  it('renders the app when the stored unlock is still valid', () => {
    window.localStorage.setItem(APP_ACCESS_STORAGE_KEY, String(Date.now() + 1_000))

    renderGate()

    expect(screen.getByTestId('app-content')).toBeInTheDocument()
    expect(screen.queryByLabelText(/access password/i)).not.toBeInTheDocument()
  })

  it('relocks when the stored unlock is expired', () => {
    window.localStorage.setItem(APP_ACCESS_STORAGE_KEY, String(Date.now() - 1_000))

    renderGate()

    expect(screen.getByLabelText(/access password/i)).toBeInTheDocument()
    expect(screen.queryByTestId('app-content')).not.toBeInTheDocument()
    expect(window.localStorage.getItem(APP_ACCESS_STORAGE_KEY)).toBeNull()
  })

  it('bypasses the gate when the configured password is blank', () => {
    vi.stubEnv('VITE_APP_ACCESS_PASSWORD', '')

    renderGate()

    expect(screen.getByTestId('app-content')).toBeInTheDocument()
    expect(screen.queryByLabelText(/access password/i)).not.toBeInTheDocument()
  })

  it('performs no startup probes before the access wall is unlocked', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'UP' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: 'UP' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(
      <AppAccessGate>
        <StartupBoundary><div>Trip app</div></StartupBoundary>
      </AppAccessGate>,
    )

    expect(fetchMock).not.toHaveBeenCalled()
    await userEvent.type(screen.getByLabelText(/access password/i), 'let-me-in')
    await userEvent.click(screen.getByRole('button', { name: /continue/i }))
    await screen.findByText('Trip app')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
