import { useEffect } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { ActivityLog } from '@/components/activities/ActivityLog'
import { useT } from '@/i18n/useT'
import { useUi } from '@/store/ui'

/** Project-wide journal. Wishlist events are ordinary entries with the chart flag on. */
export function Events() {
  const t = useT()
  const { gameId } = useParams<{ gameId: string }>()
  const [params] = useSearchParams()
  const setCurrentGame = useUi((state) => state.setCurrentGame)

  useEffect(() => {
    if (gameId) setCurrentGame(gameId)
  }, [gameId, setCurrentGame])

  if (!gameId) return null
  return (
    <div className="enter mx-auto max-w-5xl space-y-5">
      <h1 className="t-title">{t('nav.events')}</h1>
      <ActivityLog gameId={gameId} showFilters focusId={params.get('activity') ?? undefined} />
    </div>
  )
}
