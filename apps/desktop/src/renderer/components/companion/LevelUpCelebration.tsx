import { useEffect, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useT } from '@/i18n/useT'

const PIECES = Array.from({ length: 28 }, (_, index) => ({
  left: `${(index * 37) % 100}%`,
  delay: `${(index % 7) * 45}ms`,
  duration: `${820 + (index % 5) * 120}ms`,
  rotate: `${(index * 47) % 180}deg`,
  color: ['var(--accent)', 'var(--info)', 'var(--warning)', 'var(--success)'][index % 4],
}))

export function LevelUpCelebration({
  fromLevel,
  level,
  onClose,
}: {
  fromLevel: number
  level: number
  onClose: () => void
}) {
  const t = useT()

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return createPortal(
    <div
      className="level-up-backdrop fixed inset-0 z-[100] grid place-items-center bg-black/35 p-5"
      role="presentation"
    >
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        {PIECES.map((piece, index) => (
          <span
            key={index}
            className="level-up-confetti absolute -top-5 h-3 w-1.5 rounded-sm"
            style={
              {
                left: piece.left,
                backgroundColor: piece.color,
                animationDelay: piece.delay,
                animationDuration: piece.duration,
                '--confetti-rotate': piece.rotate,
              } as CSSProperties
            }
          />
        ))}
      </div>

      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="level-up-title"
        className="level-up-card relative w-full max-w-sm overflow-hidden rounded-[20px] bg-surface p-6 text-center shadow-hard"
      >
        <button
          type="button"
          onClick={onClose}
          className="tap absolute right-2 top-2 inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius)] text-muted hover:bg-surface-2 hover:text-text"
          aria-label={t('common.close')}
        >
          <X className="h-4 w-4" />
        </button>

        <div className="level-up-spark mx-auto flex h-16 w-16 items-center justify-center rounded-[20px] bg-accent/10 text-accent">
          <Sparkles className="h-8 w-8" />
        </div>
        <p className="mt-4 font-mono text-sm text-accent">/^._.^\</p>
        <h2 id="level-up-title" className="mt-2 text-balance t-title">
          {t('levelup.title', { level })}
        </h2>
        <p className="mt-2 text-pretty t-body text-muted">{t('levelup.body')}</p>

        <div className="mx-auto mt-5 flex w-fit items-center gap-3 rounded-[14px] bg-surface-2 px-5 py-3 nums">
          <span className="text-muted">Lv{fromLevel}</span>
          <span aria-hidden className="text-accent">
            →
          </span>
          <span className="t-subtitle text-accent">Lv{level}</span>
        </div>

        <Button className="mt-5 w-full" onClick={onClose} autoFocus>
          {t('levelup.cta')}
        </Button>
      </section>
    </div>,
    document.body,
  )
}
