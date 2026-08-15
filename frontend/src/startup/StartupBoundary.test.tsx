import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import userEvent from '@testing-library/user-event'
import MockAdapter from 'axios-mock-adapter'
import axios from 'axios'
import { StartupBoundary, StartupAuthGate } from './StartupBoundary'
import { AuthProvider } from '../auth/AuthContext'
import { __resetRefreshSingletonForTests } from '../api/client'
import { useAuthStore } from '../auth/authStore'

vi.mock('./readiness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./readiness')>()),
  waitForReadiness: vi.fn(),
}))

import { waitForReadiness } from './readiness'

beforeEach(() => {
  vi.mocked(waitForReadiness).mockReset()
})

afterEach(() => {
  __resetRefreshSingletonForTests()
  useAuthStore.getState().clearSession()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('<StartupBoundary>', () => {
  it('keeps every checklist phase visible and gates the app until auth initialization settles', async () => {
    let completeReadiness: (() => void) | undefined
    vi.mocked(waitForReadiness).mockImplementation(async (_signal, onPhase) => {
      onPhase('liveness')
      onPhase('database')
      await new Promise<void>((resolve) => { completeReadiness = resolve })
      return null
    })
    const refreshMock = new MockAdapter(axios)
    let completeRefresh: ((value: [number, object]) => void) | undefined
    refreshMock.onPost('/api/auth/refresh').reply(() => new Promise((resolve) => {
      completeRefresh = resolve
    }))

    render(<StartupBoundary><AuthProvider><StartupAuthGate><span>Application content</span></StartupAuthGate></AuthProvider></StartupBoundary>)
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(screen.getByRole('list', { name: /startup checklist/i })).toHaveTextContent(/connecting to the service/i)
    expect(screen.getByRole('list')).toHaveTextContent(/preparing trip data/i)
    expect(screen.getByRole('list')).toHaveTextContent(/restoring your session/i)
    expect(screen.queryByText('Application content')).not.toBeInTheDocument()
    completeReadiness?.()
    await waitFor(() => expect(screen.getAllByText(/restoring your session/i)).not.toHaveLength(0))
    expect(screen.queryByText('Application content')).not.toBeInTheDocument()
    await waitFor(() => expect(refreshMock.history.post).toHaveLength(1))
    completeRefresh?.([401, { error: 'unauthenticated' }])
    await waitFor(() => expect(screen.getByText('Application content')).toBeInTheDocument())
    refreshMock.restore()
  })

  it('starts one readiness run in React StrictMode', async () => {
    vi.mocked(waitForReadiness).mockResolvedValue(null)
    render(<StrictMode><StartupBoundary><span>Application content</span></StartupBoundary></StrictMode>)
    await waitFor(() => expect(waitForReadiness).toHaveBeenCalledTimes(1))
    expect(await screen.findByText('Application content')).toBeInTheDocument()
  })

  it('cancels an in-flight run on unmount without rendering afterward', async () => {
    vi.useFakeTimers()
    let complete: ((value: null) => void) | undefined
    let suppliedSignal: AbortSignal | undefined
    vi.mocked(waitForReadiness).mockImplementation((signal) => { suppliedSignal = signal; return new Promise((resolve) => { complete = resolve }) })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { unmount } = render(<StartupBoundary><span>Application content</span></StartupBoundary>)
    await vi.advanceTimersByTimeAsync(0)
    expect(waitForReadiness).toHaveBeenCalledTimes(1)
    unmount()
    expect(suppliedSignal?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000) })
    await act(async () => { complete?.(null) })
    expect(screen.queryByText('Application content')).not.toBeInTheDocument()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('shows and cleans the auth-gate slow note without a late update', async () => {
    vi.useFakeTimers()
    const refreshMock = new MockAdapter(axios)
    let finish: ((value: [number, object]) => void) | undefined
    refreshMock.onPost('/api/auth/refresh').reply(() => new Promise((resolve) => { finish = resolve }))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { unmount } = render(<AuthProvider><StartupAuthGate><span>Application content</span></StartupAuthGate></AuthProvider>)
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000) })
    expect(screen.getAllByText(/taking a little longer/i)).toHaveLength(2)
    unmount(); finish?.([401, {}]); await Promise.resolve()
    expect(errorSpy).not.toHaveBeenCalled()
    refreshMock.restore()
  })

  it('starts a fresh readiness run after a terminal retry', async () => {
    vi.mocked(waitForReadiness).mockResolvedValueOnce('timeout').mockResolvedValueOnce(null)
    render(<StartupBoundary><span>Application content</span></StartupBoundary>)
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(await screen.findByText('Application content')).toBeInTheDocument()
    expect(waitForReadiness).toHaveBeenCalledTimes(2)
  })

  it('exposes semantic step state, a concise status, and focuses terminal failure', async () => {
    vi.mocked(waitForReadiness).mockResolvedValue('offline')
    render(<StartupBoundary><span>Application content</span></StartupBoundary>)
    const heading = await screen.findByRole('heading', { name: /could not get ready/i })
    expect(heading).toHaveFocus()
    expect(screen.getByRole('listitem', { name: /connecting to the service: active/i })).toHaveAttribute('aria-current', 'step')
    expect(screen.getByRole('status')).toHaveTextContent(/offline/i)
    expect(screen.getByRole('status').closest('[aria-busy]')).toBeNull()
  })
})
