import { useEffect } from 'react'
import { queryClient } from '@/lib/queryClient'
import { trpc } from '@/lib/trpc'

const POLL_INTERVAL_MS = 2_000
const INVALIDATION_COOLDOWN_MS = 10_000

/** Refresh cached screens after an external MCP process commits to the shared DB. */
export function DataVersionSync() {
  useEffect(() => {
    let previous: number | undefined
    let stopped = false
    let polling = false
    let lastInvalidatedAt = 0
    let invalidationTimer: number | undefined

    const invalidateActiveQueries = async () => {
      invalidationTimer = undefined
      if (stopped) return
      lastInvalidatedAt = Date.now()
      await queryClient.invalidateQueries({ refetchType: 'active' })
    }

    const scheduleInvalidation = () => {
      if (invalidationTimer !== undefined) return
      const delay = Math.max(0, INVALIDATION_COOLDOWN_MS - (Date.now() - lastInvalidatedAt))
      if (delay === 0) {
        void invalidateActiveQueries()
        return
      }
      invalidationTimer = window.setTimeout(() => void invalidateActiveQueries(), delay)
    }

    const poll = async () => {
      if (stopped || polling || document.visibilityState === 'hidden') return
      polling = true
      try {
        const current = await trpc.system.dataVersion.query()
        if (previous !== undefined && current !== previous) scheduleInvalidation()
        previous = current
      } catch {
        // The normal query error UI handles connection failures; polling stays quiet.
      } finally {
        polling = false
      }
    }

    void poll()
    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS)
    const onVisibility = () => void poll()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onVisibility)
    return () => {
      stopped = true
      window.clearInterval(timer)
      if (invalidationTimer !== undefined) window.clearTimeout(invalidationTimer)
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onVisibility)
    }
  }, [])
  return null
}
