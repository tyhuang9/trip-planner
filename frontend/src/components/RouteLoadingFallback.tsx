import styles from './RouteLoadingFallback.module.css'

type RouteLoadingKind = 'auth' | 'secure-link' | 'trips' | 'workspace' | 'members'

const labels: Record<RouteLoadingKind, string> = {
  auth: 'Loading sign-in page',
  'secure-link': 'Opening secure link',
  trips: 'Loading your trips',
  workspace: 'Loading trip workspace',
  members: 'Loading trip members',
}

export function RouteLoadingFallback({ kind }: { kind: RouteLoadingKind }) {
  return (
    <main id="main" className={styles.page} aria-busy="true" aria-label={labels[kind]}>
      <section className={styles.content}>
        <p className={styles.status} role="status" aria-live="polite">
          {labels[kind]}…
        </p>
        <span className={`${styles.line} ${styles.title}`} />
        <span className={styles.line} />
        <span className={styles.line} />
        {kind === 'workspace' ? <span className={styles.map} /> : null}
      </section>
    </main>
  )
}
