import { useT } from '@/i18n/useT'

interface PlaceholderProps {
  titleKey: string
  phase?: string
}

export function Placeholder({ titleKey, phase }: PlaceholderProps) {
  const t = useT()
  return (
    <div className="enter flex h-full flex-col items-center justify-center gap-2 text-center">
      <div className="font-mono text-2xl text-accent">=^·_·^=</div>
      <h1 className="t-title">{t(titleKey)}</h1>
      <p className="max-w-sm text-sm text-muted">{phase ? t('soon.note', { phase }) : ''}</p>
    </div>
  )
}
