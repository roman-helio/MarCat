import { useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { useModal } from '@/lib/modal'
import { useT } from '@/i18n/useT'

export function DetailDrawer({
  label,
  meta,
  onClose,
  children,
}: {
  label: string
  meta?: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  const t = useT()
  const panelRef = useRef<HTMLDivElement>(null)
  useModal(panelRef, onClose)

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-black/30"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="enter flex h-full w-[min(520px,100vw)] flex-col overflow-auto border-l border-border bg-surface shadow-2xl"
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border bg-surface px-4 py-2.5">
          <span className="flex min-w-0 items-center gap-2">
            <span className="t-hint truncate">{label}</span>
            {meta}
          </span>
          <button
            onClick={onClose}
            className="tap inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius)] text-muted hover:bg-surface-2 hover:text-text"
            aria-label={t('common.close')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4 p-4">{children}</div>
      </div>
    </div>
  )
}
