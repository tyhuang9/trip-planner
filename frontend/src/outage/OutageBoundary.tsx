import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { CloudOff, DatabaseZap, RefreshCw, WifiOff } from 'lucide-react'
import { subscribeToAppLifecycle } from '../platform/runtime'
import { checkHealth, checkStartupHealth, subscribeToOutage, type OutageKind } from './outageMonitor'
import styles from './OutageBoundary.module.css'

interface OutageBoundaryProps {
  children: ReactNode
}

export const OUTAGE_RECHECK_INTERVAL_MS = 15_000

const COPY: Record<OutageKind, {
  title: string
  body: string
  service: string
  tone: 'server' | 'database' | 'connectivity'
  Icon: typeof CloudOff
}> = {
  server: {
    title: 'Our server ran out of road-trip snacks',
    body: 'Dupert has used up its monthly Render free-tier allowance, so the trip planner is parked on the shoulder. Your browser is online; our server is the one taking the scenic route.',
    service: 'Render app service',
    tone: 'server',
    Icon: CloudOff,
  },
  'server-unreachable': {
    title: 'Our server wandered off the map',
    body: 'We can’t reach Dupert’s Render service. Its monthly free-tier allowance may be empty—or the server may be sightseeing without us. Your browser is online.',
    service: 'Render app service',
    tone: 'server',
    Icon: CloudOff,
  },
  database: {
    title: 'The database sat on the suitcase',
    body: 'Dupert has used up its monthly Neon free-tier allowance. The planner is awake, but the database zipped up the trip details and refuses to hand them over.',
    service: 'Neon database',
    tone: 'database',
    Icon: DatabaseZap,
  },
  connectivity: {
    title: 'Your internet missed the bus',
    body: 'Your connection seems to be enjoying an unscheduled layover. Give it a quick check, then we’ll get this trip moving again.',
    service: 'Internet connection',
    tone: 'connectivity',
    Icon: WifiOff,
  },
}

export function OutageBoundary({ children }: OutageBoundaryProps) {
  const [outage, setOutage] = useState<OutageKind | null>(null)
  const [hasPassedStartupHealth, setHasPassedStartupHealth] = useState(false)
  const [isRetrying, setIsRetrying] = useState(false)
  const [retryFeedback, setRetryFeedback] = useState<{ kind: OutageKind; message: string } | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const previousOutageRef = useRef<OutageKind | null>(null)
  const isMountedRef = useRef(false)
  const recheckHealth = useCallback(() => {
    void checkHealth().then((result) => {
      if (isMountedRef.current && result === null) {
        setHasPassedStartupHealth(true)
      }
    })
  }, [])

  useEffect(() => subscribeToOutage((next) => {
    setRetryFeedback(null)
    setOutage(next)
  }), [])

  useEffect(() => {
    isMountedRef.current = true
    void checkStartupHealth().then((result) => {
      if (isMountedRef.current && result === null) {
        setHasPassedStartupHealth(true)
      }
    })

    return () => {
      isMountedRef.current = false
    }
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeToAppLifecycle((state) => {
      if (state === 'foreground') recheckHealth()
    })

    window.addEventListener('online', recheckHealth)
    return () => {
      unsubscribe()
      window.removeEventListener('online', recheckHealth)
    }
  }, [recheckHealth])

  useEffect(() => {
    if (outage === null) return

    const interval = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return
      recheckHealth()
    }, OUTAGE_RECHECK_INTERVAL_MS)

    return () => window.clearInterval(interval)
  }, [outage, recheckHealth])

  useEffect(() => {
    if (outage !== null) {
      headingRef.current?.focus()
    } else if (previousOutageRef.current !== null) {
      const main = document.getElementById('main')
      if (main !== null) {
        const previousTabIndex = main.getAttribute('tabindex')
        main.setAttribute('tabindex', '-1')
        main.focus()
        if (previousTabIndex === null) main.removeAttribute('tabindex')
        else main.setAttribute('tabindex', previousTabIndex)
      }
    }
    previousOutageRef.current = outage
  }, [outage])

  if (outage === null && !hasPassedStartupHealth) {
    return <StartupHealthShell />
  }

  if (outage === null) return <>{children}</>

  const { title, body, service, tone, Icon } = COPY[outage]
  const retryMessage = retryFeedback?.kind === outage ? retryFeedback.message : ''
  const retry = async () => {
    setIsRetrying(true)
    setRetryFeedback({ kind: outage, message: 'Knocking on Dupert’s door…' })
    const result = await checkHealth()
    setIsRetrying(false)
    if (result === null) {
      setRetryFeedback(null)
      setHasPassedStartupHealth(true)
    } else {
      setRetryFeedback({
        kind: result,
        message: 'Still no answer. Give it another poke whenever you’re ready.',
      })
    }
  }

  return (
    <main className={styles.page} id="main">
      <div className={styles.card} data-kind={outage}>
        <section role="alert" aria-atomic="true" data-kind={outage}>
          <div className={`${styles.icon} ${styles[tone]}`}><Icon aria-hidden="true" /></div>
          <p className={styles.eyebrow}>A tiny travel whoopsie</p>
          <p className={styles.service}><span aria-hidden="true" />{service}</p>
          <h1 ref={headingRef} tabIndex={-1}>{title}</h1>
          <p className={styles.body}>{body}</p>
        </section>
        <button className={styles.retry} type="button" onClick={retry} disabled={isRetrying}>
          <RefreshCw aria-hidden="true" className={isRetrying ? styles.spinning : undefined} />
          {isRetrying ? 'Knocking…' : 'Try again'}
        </button>
        <p className={styles.feedback} role="status" aria-atomic="true">{retryMessage}</p>
      </div>
    </main>
  )
}

function StartupHealthShell() {
  return (
    <main className={styles.page} id="main">
      <section className={styles.card} role="status" aria-live="polite" aria-busy="true">
        <h1>Checking Dupert’s route</h1>
        <p className={styles.body}>Making sure the trip planner is ready for the road…</p>
      </section>
    </main>
  )
}
