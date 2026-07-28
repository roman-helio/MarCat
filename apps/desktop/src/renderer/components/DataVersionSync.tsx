import { useEffect } from 'react'
import { queryClient } from '@/lib/queryClient'
import { trpc } from '@/lib/trpc'

/** Refresh cached screens after an external MCP process commits to the shared DB. */
export function DataVersionSync() {
  useEffect(() => {
    let previous: number | undefined
    let stopped = false
    let polling = false

    const poll = async () => {
      if (stopped || polling || document.visibilityState === 'hidden') return
      polling = true
      try {
        const current = await trpc.system.dataVersion.query()
        if (previous !== undefined && current !== previous) await queryClient.invalidateQueries()
        previous = current
      } catch {
        // The normal query error UI handles connection failures; polling stays quiet.
      } finally {
        polling = false
      }
    }

    void poll()
    const timer = window.setInterval(() => void poll(), 2_000)
    const onVisibility = () => void poll()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onVisibility)
    return () => {
      stopped = true
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onVisibility)
    }
  }, [])
  return null
}
