import { useEffect, useState, type ReactNode } from 'react'
import { CheckCircle2, Database, LoaderCircle, RefreshCw, Server } from 'lucide-react'
import { useAuth } from '../auth/useAuth'
import { type StartupFailure, type StartupPhase, waitForReadiness } from './readiness'
import styles from './StartupBoundary.module.css'

export function StartupBoundary({ children }: { children: ReactNode }) {
  const [attempt, setAttempt] = useState(0)
  return <StartupRun key={attempt} onRetry={() => setAttempt((value) => value + 1)}>{children}</StartupRun>
}

function StartupRun({ children, onRetry }: { children: ReactNode; onRetry: () => void }) {
  const [phase, setPhase] = useState<StartupPhase>('liveness')
  const [failure, setFailure] = useState<StartupFailure | null>(null)
  const [ready, setReady] = useState(false)
  const [slow, setSlow] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    const slowTimer = window.setTimeout(() => setSlow(true), 8_000)
    const startTimer = window.setTimeout(() => {
      void waitForReadiness(controller.signal, setPhase)
        .then((result) => {
          if (controller.signal.aborted) return
          if (result) setFailure(result)
          else setReady(true)
        })
        .catch((error) => {
          if (error?.name !== 'AbortError') throw error
        })
    }, 0)
    return () => {
      controller.abort()
      window.clearTimeout(slowTimer)
      window.clearTimeout(startTimer)
    }
  }, [])

  if (ready) return <>{children}</>
  return <StartupChecklist phase={phase} failure={failure} slow={slow} onRetry={onRetry} />
}

/** Keeps application routes hidden while AuthProvider settles its one refresh probe. */
export function StartupAuthGate({ children }: { children: ReactNode }) {
  const { isInitializing } = useAuth()
  if (!isInitializing) return <>{children}</>
  return <StartupChecklist phase="session" failure={null} slow={false} />
}

function StartupChecklist({ phase, failure, slow, onRetry }: { phase: StartupPhase; failure: StartupFailure | null; slow: boolean; onRetry?: () => void }) {
  const failed = failure !== null
  return <main className={styles.page} id="main"><section className={styles.card} aria-live="polite" aria-busy={!failed}><p className={styles.eyebrow}>Getting your trip ready</p><h1>{failed ? 'We could not get ready yet' : 'Preparing Dupert'}</h1><p className={styles.body}>{failed ? (failure === 'offline' ? 'Check your connection, then try again.' : 'The service is taking longer than expected. Please try again.') : phase === 'session' ? 'Your services are ready. Restoring your session.' : 'We are checking the route before restoring your session.'}</p><ol className={styles.steps} aria-label="Startup checklist"><Step icon={Server} label="Connecting to the service" active={phase === 'liveness'} complete={phase !== 'liveness'} /><Step icon={Database} label="Preparing trip data" active={phase === 'database'} complete={phase === 'session'} /><Step icon={LoaderCircle} label="Restoring your session" active={phase === 'session'} complete={false} /></ol>{failed ? <button className={styles.retry} type="button" onClick={onRetry}><RefreshCw aria-hidden="true" />Try again</button> : <p className={styles.slow} role="status">{slow ? 'This is taking a little longer than usual. We are still trying.' : ''}</p>}</section></main>
}

function Step({ icon: Icon, label, active, complete }: { icon: typeof Server; label: string; active: boolean; complete: boolean }) { return <li className={`${styles.step} ${active ? styles.active : ''} ${complete ? styles.complete : ''}`}>{complete ? <CheckCircle2 aria-hidden="true" /> : active ? <LoaderCircle aria-hidden="true" /> : <Icon aria-hidden="true" />}<span>{label}</span></li> }
