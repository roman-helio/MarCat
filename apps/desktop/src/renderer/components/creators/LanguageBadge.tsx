import { memo, useMemo } from 'react'
import getCountryFlag from 'country-flag-icons/unicode'
import { cn } from '@/lib/utils'

const DEFAULT_LANGUAGE_REGIONS: Record<string, string> = {
  af: 'ZA',
  ar: 'SA',
  be: 'BY',
  bg: 'BG',
  bn: 'BD',
  ca: 'ES',
  cs: 'CZ',
  da: 'DK',
  de: 'DE',
  el: 'GR',
  en: 'GB',
  es: 'ES',
  et: 'EE',
  fa: 'IR',
  fi: 'FI',
  fil: 'PH',
  fr: 'FR',
  he: 'IL',
  hi: 'IN',
  hr: 'HR',
  hu: 'HU',
  id: 'ID',
  is: 'IS',
  it: 'IT',
  ja: 'JP',
  ko: 'KR',
  lt: 'LT',
  lv: 'LV',
  ms: 'MY',
  nl: 'NL',
  no: 'NO',
  pl: 'PL',
  pt: 'PT',
  ro: 'RO',
  ru: 'RU',
  sk: 'SK',
  sl: 'SI',
  sr: 'RS',
  sv: 'SE',
  sw: 'KE',
  ta: 'IN',
  te: 'IN',
  th: 'TH',
  tr: 'TR',
  uk: 'UA',
  ur: 'PK',
  vi: 'VN',
  zh: 'CN',
}

function normalizeRegion(value?: string | null): string | undefined {
  const region = value?.trim().toUpperCase()
  return region && /^[A-Z]{2}$/.test(region) ? region : undefined
}

export function languagePresentation(language?: string | null, creatorRegion?: string | null) {
  const value = language?.trim().replaceAll('_', '-')
  if (!value) return null

  let tag = value
  let languageCode = value.split('-')[0]?.toLowerCase() ?? value.toLowerCase()
  let languageRegion: string | undefined

  try {
    const locale = new Intl.Locale(value)
    tag = locale.toString()
    languageCode = locale.language.toLowerCase()
    languageRegion = normalizeRegion(locale.region)
  } catch {
    // Keep uncommon provider codes visible even when Intl cannot canonicalize them.
  }

  const region = languageRegion ?? normalizeRegion(creatorRegion) ?? DEFAULT_LANGUAGE_REGIONS[languageCode]
  return {
    tag,
    region,
  }
}

export const LanguageBadge = memo(function LanguageBadge({
  language,
  region,
  label,
  compact = false,
  className,
}: {
  language?: string | null
  region?: string | null
  label: string
  compact?: boolean
  className?: string
}) {
  const presentation = useMemo(() => languagePresentation(language, region), [language, region])
  if (!presentation) return null

  const accessibleLabel = `${label}: ${presentation.tag}`
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center text-text',
        compact ? 'h-4 w-5 text-[12px]' : 'h-6 gap-1.5 text-sm',
        className,
      )}
      title={accessibleLabel}
      aria-label={accessibleLabel}
    >
      {presentation.region ? (
        <span className="leading-none" aria-hidden>
          {getCountryFlag(presentation.region)}
        </span>
      ) : (
        <span className="leading-none" aria-hidden>
          🌐
        </span>
      )}
      {!compact && <span className="font-mono text-[11px] font-medium leading-none">{presentation.tag}</span>}
    </span>
  )
})
