import { useRef } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { X } from 'lucide-react'
import { useModal } from '@/lib/modal'
import { useT } from '@/i18n/useT'
import { Button } from '@/components/ui/Button'

export function WhatsNewDialog({
  open,
  version,
  changelog,
  onClose,
}: {
  open: boolean
  version: string
  changelog: string
  onClose: () => void
}) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  useModal(ref, onClose, open)
  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        className="enter flex max-h-[82vh] w-full max-w-2xl flex-col overflow-hidden rounded-[20px] bg-surface p-4 shadow-hard"
      >
        <header className="flex items-start gap-3 border-b border-border pb-3">
          <div className="min-w-0 flex-1">
            <h2 id="whats-new-title" className="text-balance t-title">
              {t('set.whatsNew')}
            </h2>
            <p className="mt-1 text-sm text-muted">{t('set.currentVersion', { version })}</p>
          </div>
          <Button size="icon" variant="ghost" aria-label={t('common.close')} onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>
        <div className="changelog-content markdown-content mt-3 overflow-y-auto rounded-[12px] bg-bg px-4 py-3 text-sm leading-relaxed text-text shadow-[inset_0_0_0_1px_var(--border)]">
          {changelog ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{changelog}</ReactMarkdown>
          ) : (
            <p>{t('set.noChangelog')}</p>
          )}
        </div>
      </div>
    </div>
  )
}
