import { useState } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import styles from './PwaUpdatePrompt.module.css'

export function PwaUpdatePrompt() {
  const [isApplyingUpdate, setIsApplyingUpdate] = useState(false)
  const [updateError, setUpdateError] = useState(false)
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    offlineReady: [offlineReady, setOfflineReady],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisterError: () => setUpdateError(true),
  })

  if (!needRefresh && !offlineReady && !updateError) {
    return null
  }

  const dismiss = () => {
    setNeedRefresh(false)
    setOfflineReady(false)
    setUpdateError(false)
  }

  const applyUpdate = async () => {
    setIsApplyingUpdate(true)
    setUpdateError(false)

    try {
      await updateServiceWorker(true)
    } catch {
      setIsApplyingUpdate(false)
      setUpdateError(true)
    }
  }

  return (
    <aside className={styles.prompt} aria-live="polite" aria-atomic="true">
      <div>
        <strong className={styles.title}>
          {needRefresh ? 'A Dupert update is ready' : offlineReady ? 'Dupert is ready offline' : 'Offline setup needs attention'}
        </strong>
        <p className={styles.message}>
          {needRefresh
            ? 'Reload when you are ready to use the latest version.'
            : offlineReady
              ? 'The app shell can reopen without a connection. Trip data still requires the network.'
              : 'Dupert could not enable offline access in this browser.'}
        </p>
      </div>
      <div className={styles.actions}>
        {needRefresh ? (
          <button className={styles.primaryAction} type="button" onClick={() => void applyUpdate()} disabled={isApplyingUpdate}>
            {isApplyingUpdate ? 'Updating…' : 'Reload to update'}
          </button>
        ) : null}
        <button className={styles.secondaryAction} type="button" onClick={dismiss}>
          {needRefresh ? 'Not now' : 'Dismiss'}
        </button>
      </div>
    </aside>
  )
}
