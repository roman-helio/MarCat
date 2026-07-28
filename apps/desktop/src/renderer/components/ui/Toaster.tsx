import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import { useToasts, type ToastKind } from '@/store/toast'
import { cn } from '@/lib/utils'
import { useT } from '@/i18n/useT'

const TONE: Record<ToastKind, { cls: string; Icon: typeof Info }> = {
  success: { cls: 'border-accent/50 text-accent', Icon: CheckCircle2 },
  error: { cls: 'border-alarm/60 text-alarm', Icon: AlertTriangle },
  info: { cls: 'border-info/50 text-info', Icon: Info },
}

/** Bottom-right toast stack for success / error / info feedback. */
export function Toaster() {
  const t = useT()
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)
  if (!toasts.length) return null

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((tt) => {
        const { cls, Icon } = TONE[tt.kind]
        return (
          <div
            key={tt.id}
            role="status"
            className={cn(
              'enter pointer-events-auto flex items-start gap-2 rounded-[var(--radius)] border bg-surface px-3 py-2 text-sm shadow-hard',
              cls,
            )}
          >
            <Icon className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 break-words text-text">{tt.msg}</span>
            <button
              onClick={() => dismiss(tt.id)}
              aria-label={t('common.dismiss')}
              className="tap -my-2 -mr-2 inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius)] text-muted transition-colors hover:bg-surface-2 hover:text-text"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
