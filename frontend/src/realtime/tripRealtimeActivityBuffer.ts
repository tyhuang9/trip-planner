import { createContext, useContext, useEffect } from 'react'

export const ActivityBufferContext =
  createContext<((buffering: boolean) => void) | null>(null)

/** Publish drag buffering to the route-level realtime owner, when present. */
export function useTripRealtimeActivityBuffer(buffering: boolean) {
  const setBuffering = useContext(ActivityBufferContext)

  useEffect(() => {
    setBuffering?.(buffering)
  }, [buffering, setBuffering])

  useEffect(() => {
    return () => setBuffering?.(false)
  }, [setBuffering])
}
