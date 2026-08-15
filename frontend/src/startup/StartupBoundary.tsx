import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { CheckCircle2, CircleX, Database, KeyRound, LoaderCircle, RefreshCw, Server } from 'lucide-react'
import { AuthProvider } from '../auth/AuthContext'
import { AuthBootstrapShell } from '../auth/AuthBootstrapShell'
import { useAuth } from '../auth/useAuth'
import { OutageBoundary } from '../outage/OutageBoundary'
import { type StartupFailure, type StartupPhase, waitForReadiness } from './readiness'
import styles from './StartupBoundary.module.css'

export function StartupBoundary({ children }: { children: ReactNode }) {
  const [attempt, setAttempt] = useState(0)
  const [focusAfterKeyboardRetry, setFocusAfterKeyboardRetry] = useState(false)
  return (
    <StartupRun
      key={attempt}
      focusAfterKeyboardRetry={focusAfterKeyboardRetry}
      onRetry={(initiatedWithKeyboard) => {
        setFocusAfterKeyboardRetry(initiatedWithKeyboard)
        setAttempt((value) => value + 1)
      }}
    >
      {children}
    </StartupRun>
  )
}

/**
 * Keeps runtime outage replacement behind auth restoration. A refresh failure
 * therefore remains in the fail-closed auth shell until the session resolves,
 * while loaded routes still receive the normal runtime outage boundary.
 */
export function StartupApplicationBoundary({ children }: { children: ReactNode }) {
  return (
    <StartupBoundary>
      <AuthProvider>
        <StartupAuthGate>
          <OutageBoundary>{children}</OutageBoundary>
        </StartupAuthGate>
      </AuthProvider>
    </StartupBoundary>
  )
}

function StartupRun({
  children,
  focusAfterKeyboardRetry,
  onRetry,
}: {
  children: ReactNode
  focusAfterKeyboardRetry: boolean
  onRetry: (initiatedWithKeyboard: boolean) => void
}) {
  const [phase, setPhase] = useState<StartupPhase>('liveness')
  const [failure, setFailure] = useState<StartupFailure | null>(null)
  const [ready, setReady] = useState(false)
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const controller = new AbortController()
    const slowTimer = window.setTimeout(() => setSlow(true), 8_000)
    const startTimer = window.setTimeout(() => {
      void waitForReadiness(controller.signal, setPhase).then((result) => {
        if (controller.signal.aborted) return
        window.clearTimeout(slowTimer)
        if (result) setFailure(result)
        else setReady(true)
      }).catch(() => {
        if (controller.signal.aborted) return
        window.clearTimeout(slowTimer)
        setFailure(navigator.onLine === false ? 'offline' : 'timeout')
      })
    }, 0)
    return () => { controller.abort(); window.clearTimeout(slowTimer); window.clearTimeout(startTimer) }
  }, [])
  if (ready) {
    return (
      <StartupRecoveryFocus focusAfterKeyboardRetry={focusAfterKeyboardRetry}>
        {children}
      </StartupRecoveryFocus>
    )
  }
  return <StartupChecklist focusAfterKeyboardRetry={focusAfterKeyboardRetry} phase={phase} failure={failure} slow={slow} onRetry={onRetry} />
}

/** Keeps application routes hidden while AuthProvider settles its one refresh probe. */
export function StartupAuthGate({ children }: { children: ReactNode }) {
  const { authStatus, isInitializing } = useAuth()
  const keyboardRetryRequested = useRef(false)
  const focusAfterKeyboardRetry = useRef(false)
  const retryButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!focusAfterKeyboardRetry.current) return
    if (authStatus === 'offline-unknown') {
      const animationFrame = window.requestAnimationFrame(() => {
        focusAfterKeyboardRetry.current = false
        retryButton.current?.focus()
      })
      return () => window.cancelAnimationFrame(animationFrame)
    }
    if (isInitializing) return
    const animationFrame = window.requestAnimationFrame(() => {
      focusAfterKeyboardRetry.current = false
      focusRecoveredMain()
    })
    return () => window.cancelAnimationFrame(animationFrame)
  }, [authStatus, isInitializing])
  if (!isInitializing) return <>{children}</>
  if (authStatus === 'offline-unknown') {
    return (
      <div
        onClickCapture={(event: MouseEvent<HTMLElement>) => {
          if (keyboardRetryRequested.current && event.target instanceof HTMLButtonElement) {
            focusAfterKeyboardRetry.current = true
          }
          keyboardRetryRequested.current = false
        }}
        onKeyDownCapture={(event: KeyboardEvent<HTMLElement>) => {
          if (event.target instanceof HTMLButtonElement && (event.key === 'Enter' || event.key === ' ')) {
            keyboardRetryRequested.current = true
          }
        }}
        onPointerDownCapture={() => { keyboardRetryRequested.current = false }}
      >
        <AuthBootstrapShell retryButtonRef={retryButton} />
      </div>
    )
  }
  return <StartupAuthLoading />
}

function StartupAuthLoading() {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    const timer = window.setTimeout(() => setSlow(true), 8_000)
    return () => window.clearTimeout(timer)
  }, [])
  return <StartupChecklist focusAfterKeyboardRetry={false} phase="session" failure={null} slow={slow} />
}

function StartupChecklist({
  phase,
  failure,
  slow,
  focusAfterKeyboardRetry,
  onRetry,
}: {
  phase: StartupPhase
  failure: StartupFailure | null
  slow: boolean
  focusAfterKeyboardRetry: boolean
  onRetry?: (initiatedWithKeyboard: boolean) => void
}) {
  const failed = failure !== null
  const heading = useRef<HTMLHeadingElement>(null)
  const retryButton = useRef<HTMLButtonElement>(null)
  const keyboardRetryRequested = useRef(false)
  useEffect(() => {
    if (focusAfterKeyboardRetry && !failed) heading.current?.focus()
  }, [failed, focusAfterKeyboardRetry])
  useEffect(() => {
    if (focusAfterKeyboardRetry && failed) retryButton.current?.focus()
  }, [failed, focusAfterKeyboardRetry])
  const body = failed ? (failure === 'offline' ? 'Check your connection, then try again.' : 'The service is taking longer than expected. Please try again.') : phase === 'session' ? 'Your services are ready. Restoring your session.' : 'We are checking the route before restoring your session.'
  const phaseAnnouncement = `Startup: ${phase === 'liveness' ? 'connecting to the service' : phase === 'database' ? 'preparing trip data' : 'restoring your session'}.`
  const announcement = failed ? `${failure === 'offline' ? 'Offline.' : 'Readiness timed out.'} ${body}` : `${phaseAnnouncement}${slow ? ' This is taking a little longer than usual. We are still trying.' : ''}`
  return <main className={styles.page} id="main"><section className={styles.card}><p className={styles.eyebrow}>Getting your trip ready</p><h1 ref={heading} tabIndex={focusAfterKeyboardRetry ? -1 : undefined}>{failed ? 'We could not get ready yet' : 'Preparing Dupert'}</h1><p className={styles.body}>{body}</p><p className={styles.announcement} role="status" aria-atomic="true">{announcement}</p><ol className={styles.steps} role="list" aria-label="Startup checklist"><Step icon={Server} label="Connecting to the service" state={stepState('liveness', phase, failed)} /><Step icon={Database} label="Preparing trip data" state={stepState('database', phase, failed)} /><Step icon={KeyRound} label="Restoring your session" state={stepState('session', phase, failed)} /></ol>{failed ? <button ref={retryButton} className={styles.retry} type="button" onClick={() => { onRetry?.(keyboardRetryRequested.current); keyboardRetryRequested.current = false }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') keyboardRetryRequested.current = true }} onPointerDown={() => { keyboardRetryRequested.current = false }}><RefreshCw aria-hidden="true" />Try again</button> : <p className={styles.slow}>{slow ? 'This is taking a little longer than usual. We are still trying.' : ''}</p>}</section></main>
}

type StepState = 'pending' | 'active' | 'completed' | 'failed'

function stepState(
  step: StartupPhase,
  currentPhase: StartupPhase,
  failed: boolean,
): StepState {
  const phases: StartupPhase[] = ['liveness', 'database', 'session']
  const stepIndex = phases.indexOf(step)
  const currentIndex = phases.indexOf(currentPhase)
  if (stepIndex === currentIndex) return failed ? 'failed' : 'active'
  return stepIndex < currentIndex ? 'completed' : 'pending'
}

function StartupRecoveryFocus({ children, focusAfterKeyboardRetry }: { children: ReactNode; focusAfterKeyboardRetry: boolean }) {
  useEffect(() => {
    if (!focusAfterKeyboardRetry) return
    const animationFrame = window.requestAnimationFrame(focusRecoveredMain)
    return () => window.cancelAnimationFrame(animationFrame)
  }, [focusAfterKeyboardRetry])
  return <>{children}</>
}

function focusRecoveredMain() {
  const main = document.getElementById('main')
  const focusTarget = main?.querySelector('h1') ?? main
  if (focusTarget instanceof HTMLElement) {
    focusTarget.tabIndex = -1
    focusTarget.focus()
  }
}

function Step({ icon: Icon, label, state }: { icon: typeof Server; label: string; state: StepState }) {
  return <li className={`${styles.step} ${state === 'active' ? styles.active : ''} ${state === 'completed' ? styles.complete : ''} ${state === 'failed' ? styles.failed : ''}`} aria-label={`${label}: ${state}`} aria-current={state === 'active' ? 'step' : undefined}>{state === 'completed' ? <CheckCircle2 aria-hidden="true" /> : state === 'failed' ? <CircleX aria-hidden="true" /> : state === 'active' ? <LoaderCircle aria-hidden="true" /> : <Icon aria-hidden="true" />}<span>{label}</span></li>
}
