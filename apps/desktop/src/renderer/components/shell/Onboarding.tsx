import { useId, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { Cat, Gamepad2, LineChart, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useModal } from '@/lib/modal'
import { useSettings, type Lang } from '@/store/settings'
import { Button } from '@/components/ui/Button'
import { useT } from '@/i18n/useT'

/** First-run welcome — shown until dismissed (persisted in settings). */
export function Onboarding() {
  const t = useT()
  const navigate = useNavigate()
  const onboarded = useSettings((s) => s.onboarded)
  const setOnboarded = useSettings((s) => s.setOnboarded)
  const lang = useSettings((s) => s.lang)
  const setLang = useSettings((s) => s.setLang)
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const done = (path?: string) => {
    setOnboarded(true)
    if (path) navigate(path)
  }
  useModal(ref, () => done(), !onboarded)

  if (onboarded) return null
  const steps = [
    { Icon: Gamepad2, title: t('ob.s1'), desc: t('ob.s1d') },
    { Icon: Cat, title: t('ob.s2'), desc: t('ob.s2d') },
    { Icon: LineChart, title: t('ob.s3'), desc: t('ob.s3d') },
  ]

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="enter w-[min(560px,94vw)] space-y-4 rounded-[var(--radius)] border border-border bg-surface p-5 shadow-hard"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-mono text-lg text-accent">=^•‿•^=</div>
            <h2 id={titleId} className="mt-1 t-title">
              {t('ob.title')}
            </h2>
            <p className="text-sm text-muted">{t('ob.intro')}</p>
          </div>
          <div className="flex items-center gap-1">
            {(['ru', 'en'] as Lang[]).map((l) => (
              <button
                key={l}
                onClick={() => setLang(l)}
                className={cn(
                  'tap rounded px-1.5 py-0.5 t-hint transition-colors',
                  lang === l ? 'bg-accent/15 text-accent' : 'text-muted hover:text-text',
                )}
              >
                {l.toUpperCase()}
              </button>
            ))}
            <button
              onClick={() => done()}
              className="tap ml-1 inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius)] text-muted transition-colors hover:bg-surface-2 hover:text-text"
              aria-label={t('common.close')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        <div className="space-y-2">
          {steps.map((s, i) => (
            <div key={i} className="flex items-start gap-3 rounded-[var(--radius)] border border-border bg-bg p-2.5">
              <s.Icon className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
              <div>
                <div className="t-section text-balance">{s.title}</div>
                <div className="text-xs text-muted text-pretty">{s.desc}</div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={() => done('/settings')}>
            {t('ob.settings')}
          </Button>
          <Button size="sm" onClick={() => done('/')}>
            {t('ob.start')}
          </Button>
        </div>
      </div>
    </div>
  )
}
