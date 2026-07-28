import { useEffect, useState, type ReactNode } from 'react'
import { CloudOff, DatabaseZap, RefreshCw, WifiOff } from 'lucide-react'
import { checkHealth, subscribeToOutage, type OutageKind } from './outageMonitor'
import styles from './OutageBoundary.module.css'

interface OutageBoundaryProps {
  children: ReactNode
}

const COPY: Record<OutageKind, { title: string; body: string; Icon: typeof CloudOff }> = {
  app: {
    title: 'Dupert is taking a quick breather',
    body: 'Dupert’s monthly Render free-tier allowance has been reached. Your browser is online, but the trip planner cannot respond right now.',
    Icon: CloudOff,
  },
  database: {
    title: 'Your trips are safely waiting',
    body: 'Dupert’s monthly Neon free-tier allowance has been reached. The planner is online, but trip data cannot respond right now.',
    Icon: DatabaseZap,
  },
  connectivity: {
    title: 'You appear to be offline',
    body: 'Check your connection, then we’ll gladly pick up where you left off.',
    Icon: WifiOff,
  },
}

export function OutageBoundary({ children }: OutageBoundaryProps) {
  const [outage, setOutage] = useState<OutageKind | null>(null)
  const [isRetrying, setIsRetrying] = useState(false)
  const [retryMessage, setRetryMessage] = useState('')

  useEffect(() => subscribeToOutage(setOutage), [])

  if (outage === null) return <>{children}</>

  const { title, body, Icon } = COPY[outage]
  const retry = async () => {
    setIsRetrying(true)
    setRetryMessage('Checking Dupert again…')
    const result = await checkHealth()
    setIsRetrying(false)
    if (result === null) {
      setRetryMessage('Dupert is back. Restoring your trip planner…')
    } else {
      setRetryMessage('Still unavailable. We’ll keep your place ready.')
    }
  }

  return (
    <main className={styles.page} id="main">
      <section className={styles.card} role="alert" aria-live="assertive" aria-atomic="true">
        <div className={styles.icon}><Icon aria-hidden="true" /></div>
        <p className={styles.eyebrow}>A tiny travel detour</p>
        <h1>{title}</h1>
        <p className={styles.body}>{body}</p>
        <button className={styles.retry} type="button" onClick={retry} disabled={isRetrying}>
          <RefreshCw aria-hidden="true" className={isRetrying ? styles.spinning : undefined} />
          {isRetrying ? 'Checking…' : 'Try again'}
        </button>
        <p className={styles.feedback} aria-live="polite" aria-atomic="true">{retryMessage}</p>
      </section>
      <div className={styles.srOnly} aria-live="polite">{retryMessage}</div>
    </main>
  )
}
