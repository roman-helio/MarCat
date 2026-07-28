import { useRef } from 'react'
import { TriangleAlert } from 'lucide-react'
import { useConfirm } from '@/store/confirm'
import { useModal } from '@/lib/modal'
import { useT } from '@/i18n/useT'
import { Button } from './Button'

/** Single app-wide confirmation dialog driven by the confirm store. */
export function ConfirmHost() {
  const t = useT()
  const current = useConfirm((s) => s.current)
  const settle = useConfirm((s) => s.settle)
  const ref = useRef<HTMLDivElement>(null)
  useModal(ref, () => settle(false), !!current)
  if (!current) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) settle(false)
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        className="enter w-full max-w-md rounded-[14px] bg-surface p-2 shadow-2xl"
      >
        <div className={current.danger ? 'flex gap-3 rounded-[10px] bg-red-50 p-3 dark:bg-red-950/25' : 'p-3'}>
          {current.danger && (
            <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[8px] bg-red-100 text-alarm dark:bg-red-900/35">
              <TriangleAlert className="h-5 w-5" />
            </span>
          )}
          <div className="min-w-0 flex-1">
            <h2 className="text-base font-semibold text-balance text-text">{current.title}</h2>
            {current.body && <p className="mt-1.5 text-sm text-pretty text-muted">{current.body}</p>}
          </div>
        </div>
        <div className="flex justify-end gap-2 px-2 pb-1 pt-3">
          <Button size="sm" variant="ghost" onClick={() => settle(false)}>
            {current.cancelLabel ?? t('common.cancel')}
          </Button>
          <Button size="sm" variant={current.danger ? 'danger' : 'primary'} onClick={() => settle(true)}>
            {current.confirmLabel ?? t('common.confirm')}
          </Button>
        </div>
      </div>
    </div>
  )
}
