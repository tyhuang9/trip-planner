import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CloudOff, DatabaseZap, RefreshCw, WifiOff } from 'lucide-react'
import { checkHealth, subscribeToOutage, type OutageKind } from './outageMonitor'
import styles from './OutageBoundary.module.css'

interface OutageBoundaryProps {
  children: ReactNode
}

const COPY: Record<OutageKind, {
  title: string
  body: string
  service: string
  tone: 'server' | 'database' | 'connectivity'
  Icon: typeof CloudOff
}> = {
  server: {
    title: 'Trip planner unavailable',
    body: 'Dupert’s monthly Render free-tier allowance has been reached. Your browser is online, but the trip planner cannot respond right now.',
    service: 'Render app service',
    tone: 'server',
    Icon: CloudOff,
  },
  'server-unreachable': {
    title: 'We can’t reach Dupert',
    body: 'Dupert’s monthly Render free-tier allowance may have been reached. Your browser is online, but the trip planner did not answer its status check.',
    service: 'Render app service',
    tone: 'server',
    Icon: CloudOff,
  },
  database: {
    title: 'Trip data unavailable',
    body: 'Dupert’s monthly Neon free-tier allowance has been reached. The planner is online, but trip data cannot respond right now.',
    service: 'Neon database',
    tone: 'database',
    Icon: DatabaseZap,
  },
  connectivity: {
    title: 'You appear to be offline',
    body: 'Check your connection, then we’ll gladly pick up where you left off.',
    service: 'Internet connection',
    tone: 'connectivity',
    Icon: WifiOff,
  },
}

export function OutageBoundary({ children }: OutageBoundaryProps) {
  const [outage, setOutage] = useState<OutageKind | null>(null)
  const [isRetrying, setIsRetrying] = useState(false)
  const [retryFeedback, setRetryFeedback] = useState<{ kind: OutageKind; message: string } | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const previousOutageRef = useRef<OutageKind | null>(null)

  useEffect(() => subscribeToOutage(setOutage), [])

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

  if (outage === null) return <>{children}</>

  const { title, body, service, tone, Icon } = COPY[outage]
  const retryMessage = retryFeedback?.kind === outage ? retryFeedback.message : ''
  const retry = async () => {
    setIsRetrying(true)
    setRetryFeedback({ kind: outage, message: 'Checking Dupert again…' })
    const result = await checkHealth()
    setIsRetrying(false)
    if (result === null) {
      setRetryFeedback({ kind: outage, message: 'Dupert is back. Restoring your trip planner…' })
    } else {
      setRetryFeedback({
        kind: result,
        message: 'Still unavailable. You can try again whenever you’re ready.',
      })
    }
  }

  return (
    <main className={styles.page} id="main">
      <section className={styles.card} role="alert" aria-atomic="true" data-kind={outage}>
        <div className={`${styles.icon} ${styles[tone]}`}><Icon aria-hidden="true" /></div>
        <p className={styles.eyebrow}>A tiny travel detour</p>
        <p className={styles.service}><span aria-hidden="true" />{service}</p>
        <h1 ref={headingRef} tabIndex={-1}>{title}</h1>
        <p className={styles.body}>{body}</p>
        <button className={styles.retry} type="button" onClick={retry} disabled={isRetrying}>
          <RefreshCw aria-hidden="true" className={isRetrying ? styles.spinning : undefined} />
          {isRetrying ? 'Checking…' : 'Try again'}
        </button>
        <p className={styles.feedback} role="status" aria-atomic="true">{retryMessage}</p>
      </section>
    </main>
  )
}
