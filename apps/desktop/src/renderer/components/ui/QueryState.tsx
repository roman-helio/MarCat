import { AlertTriangle, Loader2, RotateCw } from 'lucide-react'
import { Button } from './Button'
import { useT } from '@/i18n/useT'

export function LoadingState() {
  const t = useT()
  return (
    <div role="status" aria-live="polite" className="flex items-center gap-2 py-2 text-sm text-muted">
      <Loader2 className="h-4 w-4 animate-spin text-accent" aria-hidden />
      {t('common.loading')}
    </div>
  )
}

export function QueryError({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const t = useT()
  const detail = error instanceof Error ? error.message : String(error ?? '')
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-[var(--radius)] border border-alarm bg-alarm/10 p-3 text-sm"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-alarm" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-alarm">{t('common.loadError')}</p>
        {detail && <p className="mt-0.5 break-words text-xs text-muted">{detail}</p>}
      </div>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RotateCw className="h-3.5 w-3.5" aria-hidden />
          {t('common.retry')}
        </Button>
      )}
    </div>
  )
}
