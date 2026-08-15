import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { act, render, screen, waitFor } from '@testing-library/react'
import { StrictMode, type ReactNode } from 'react'
import userEvent from '@testing-library/user-event'
import MockAdapter from 'axios-mock-adapter'
import axios from 'axios'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StartupBoundary, StartupAuthGate } from './StartupBoundary'
import { AuthProvider } from '../auth/AuthContext'
import { __resetRefreshSingletonForTests } from '../api/client'
import { useAuthStore } from '../auth/authStore'

const authBootstrapShellCss = readFileSync(
  'src/auth/AuthBootstrapShell.module.css',
  'utf8',
)

vi.mock('./readiness', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./readiness')>()),
  waitForReadiness: vi.fn(),
}))

import { waitForReadiness } from './readiness'

function withQueryClient(children: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return (
    <QueryClientProvider client={queryClient}>
      {children}
    </QueryClientProvider>
  )
}

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

    render(withQueryClient(<StartupBoundary><AuthProvider><StartupAuthGate><span>Application content</span></StartupAuthGate></AuthProvider></StartupBoundary>))
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

  it('keeps phase-specific status announcements after the slow threshold', async () => {
    vi.useFakeTimers()
    let reportPhase: ((phase: 'liveness' | 'database' | 'session') => void) | undefined
    vi.mocked(waitForReadiness).mockImplementation(async (_signal, onPhase) => {
      reportPhase = onPhase
      return new Promise(() => undefined)
    })
    render(<StartupBoundary><span>Application content</span></StartupBoundary>)
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000) })

    expect(screen.getByRole('status')).toHaveTextContent(/startup: connecting to the service.*taking a little longer/i)
    act(() => { reportPhase?.('database') })
    expect(screen.getByRole('status')).toHaveTextContent(/startup: preparing trip data.*taking a little longer/i)
  })

  it('clears the slow timer when readiness settles', async () => {
    vi.useFakeTimers()
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout')
    vi.mocked(waitForReadiness).mockResolvedValue(null)

    render(<StartupBoundary><span>Application content</span></StartupBoundary>)
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })

    expect(screen.getByText('Application content')).toBeInTheDocument()
    expect(clearTimeoutSpy).toHaveBeenCalled()
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

  it.each([
    { online: true, error: new DOMException('Coordinator aborted unexpectedly', 'AbortError'), expectedStatus: /readiness timed out/i },
    { online: false, error: new Error('Coordinator rejected'), expectedStatus: /offline/i },
  ])('renders terminal retry UI for a mounted coordinator rejection when online is $online', async ({ online, error, expectedStatus }) => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: online })
    vi.mocked(waitForReadiness).mockRejectedValue(error)

    render(<StartupBoundary><span>Application content</span></StartupBoundary>)

    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent(expectedStatus)
  })

  it('shows and cleans the auth-gate slow note without a late update', async () => {
    vi.useFakeTimers()
    const refreshMock = new MockAdapter(axios)
    let finish: ((value: [number, object]) => void) | undefined
    refreshMock.onPost('/api/auth/refresh').reply(() => new Promise((resolve) => { finish = resolve }))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { unmount } = render(withQueryClient(<AuthProvider><StartupAuthGate><span>Application content</span></StartupAuthGate></AuthProvider>))
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000) })
    expect(screen.getAllByText(/taking a little longer/i)).toHaveLength(2)
    unmount(); finish?.([401, {}]); await Promise.resolve()
    expect(errorSpy).not.toHaveBeenCalled()
    refreshMock.restore()
  })

  it('turns a lock deadline into a retryable auth shell and recovers', async () => {
    const user = userEvent.setup()
    const originalLocks = Object.getOwnPropertyDescriptor(
      globalThis.navigator,
      'locks',
    )
    let lockRequests = 0
    Object.defineProperty(globalThis.navigator, 'locks', {
      configurable: true,
      value: {
        request: vi.fn(
          (
            _name: string,
            _options: unknown,
            callback: () => Promise<unknown>,
          ) => {
            lockRequests += 1
            return lockRequests === 1
              ? Promise.reject(
                  new DOMException('Lock acquisition timed out', 'TimeoutError'),
                )
              : Promise.resolve().then(callback)
          },
        ),
      },
    })
    const refreshMock = new MockAdapter(axios)
    refreshMock.onPost('/api/auth/refresh').reply(401, {
      error: 'unauthenticated',
    })
    const rendered = render(withQueryClient(
      <AuthProvider>
        <StartupAuthGate><main id="main"><h1>Application content</h1></main></StartupAuthGate>
      </AuthProvider>,
    ))

    try {
      expect(
        await screen.findByRole('heading', {
          name: /could not confirm your session/i,
        }),
      ).toBeInTheDocument()
      await user.tab()
      await user.keyboard('{Enter}')

      const appHeading = await screen.findByRole('heading', { name: /application content/i })
      await waitFor(() => expect(appHeading).toHaveFocus())
      expect(lockRequests).toBe(2)
      expect(refreshMock.history.post).toHaveLength(1)
    } finally {
      rendered.unmount()
      refreshMock.restore()
      if (originalLocks) {
        Object.defineProperty(globalThis.navigator, 'locks', originalLocks)
      } else {
        Reflect.deleteProperty(globalThis.navigator, 'locks')
      }
    }
  })

  it('hands keyboard retry focus to the recovered route without moving pointer focus', async () => {
    vi.mocked(waitForReadiness).mockResolvedValueOnce('timeout').mockResolvedValueOnce(null)
    const user = userEvent.setup()
    const keyboardRender = render(<StartupBoundary><main id="main"><h1>Trip workspace</h1></main></StartupBoundary>)
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument()
    await user.tab()
    await user.keyboard('{Enter}')
    await waitFor(() => expect(screen.getByRole('heading', { name: /trip workspace/i })).toHaveFocus())
    expect(waitForReadiness).toHaveBeenCalledTimes(2)
    keyboardRender.unmount()

    vi.mocked(waitForReadiness).mockResolvedValueOnce('timeout').mockResolvedValueOnce(null)
    const pointerRender = render(<StartupBoundary><main id="main"><h1>Pointer workspace</h1></main></StartupBoundary>)
    await user.click(await screen.findByRole('button', { name: /try again/i }))
    await screen.findByRole('heading', { name: /pointer workspace/i })
    expect(screen.getByRole('heading', { name: /pointer workspace/i })).not.toHaveFocus()
    pointerRender.unmount()
  })

  it('exposes semantic step state, a concise status, explicit list semantics, and does not force focus on terminal failure', async () => {
    vi.mocked(waitForReadiness).mockResolvedValue('offline')
    render(<StartupBoundary><span>Application content</span></StartupBoundary>)
    const heading = await screen.findByRole('heading', { name: /could not get ready/i })
    expect(heading).not.toHaveFocus()
    expect(screen.getByRole('list', { name: /startup checklist/i })).toHaveAttribute('role', 'list')
    expect(screen.getByRole('listitem', { name: /connecting to the service: active/i })).toHaveAttribute('aria-current', 'step')
    expect(screen.getByRole('status')).toHaveTextContent(/offline/i)
    expect(screen.getByRole('status').closest('[aria-busy]')).toBeNull()
  })

  it('uses an opaque, defined three-pixel retry focus treatment', () => {
    expect(authBootstrapShellCss).toMatch(/\.retryButton:focus-visible\s*\{[^}]*outline:\s*3px solid var\(--color-primary\);[^}]*outline-offset:\s*4px;/s)
    expect(authBootstrapShellCss).not.toContain('--color-focus-ring')
  })
})
