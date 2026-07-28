import { useEffect, useState } from 'react'
import { Repeat2 } from 'lucide-react'
import { cn, fieldCls } from '@/lib/utils'
import { useT } from '@/i18n/useT'
import type { RecurrenceUnit } from './meta'

export interface RecurrenceValue {
  every: number
  unit: RecurrenceUnit
}

export function TaskRecurrenceControl({
  value,
  onChange,
  className,
}: {
  value: RecurrenceValue | null
  onChange: (value: RecurrenceValue | null) => void
  className?: string
}) {
  const t = useT()
  const [everyDraft, setEveryDraft] = useState(String(value?.every ?? 1))

  useEffect(() => setEveryDraft(String(value?.every ?? 1)), [value?.every])

  const commitEvery = () => {
    if (!value) return
    const parsed = Number(everyDraft)
    const every = Number.isInteger(parsed) ? Math.min(3650, Math.max(1, parsed)) : value.every
    setEveryDraft(String(every))
    if (every !== value.every) onChange({ ...value, every })
  }

  return (
    <div className={cn('min-w-0', className)}>
      <button
        type="button"
        role="switch"
        aria-checked={!!value}
        onClick={() => onChange(value ? null : { every: 1, unit: 'week' })}
        className="tap flex min-h-10 w-full items-center gap-2 rounded-[8px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      >
        <Repeat2
          className={cn(
            'h-4 w-4 shrink-0 transition-colors duration-150 ease-out',
            value ? 'text-accent' : 'text-muted',
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-text">{t('task.recurring')}</span>
          <span className="block text-[11px] leading-relaxed text-muted">{t('task.recurringShortHint')}</span>
        </span>
        <span
          aria-hidden
          className={cn(
            'relative h-5 w-9 shrink-0 rounded-[10px] shadow-[inset_0_0_0_1px_rgba(0,0,0,.12)] transition-[background-color,box-shadow] duration-150 ease-out dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,.14)]',
            value ? 'bg-accent-fill' : 'bg-surface-2',
          )}
        >
          <span
            className={cn(
              'absolute left-0.5 top-0.5 h-4 w-4 rounded-[8px] bg-white shadow-sm transition-transform duration-150 ease-out',
              value && 'translate-x-4',
            )}
          />
        </span>
      </button>

      {value && (
        <div className="mt-2 grid grid-cols-[minmax(0,.8fr)_minmax(0,1.2fr)] gap-2 pl-6">
          <label className="grid min-w-0 gap-1 text-[11px] text-muted">
            {t('task.repeatEvery')}
            <input
              type="number"
              min={1}
              max={3650}
              inputMode="numeric"
              value={everyDraft}
              onChange={(event) => setEveryDraft(event.target.value)}
              onBlur={commitEvery}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  commitEvery()
                  event.currentTarget.blur()
                }
              }}
              className={cn(fieldCls, 'min-w-0 nums')}
            />
          </label>
          <label className="grid min-w-0 gap-1 text-[11px] text-muted">
            {t('task.repeatUnit')}
            <select
              value={value.unit}
              onChange={(event) => onChange({ ...value, unit: event.target.value as RecurrenceUnit })}
              className={cn(fieldCls, 'min-w-0')}
            >
              <option value="day">{t('task.repeatUnit.day')}</option>
              <option value="week">{t('task.repeatUnit.week')}</option>
              <option value="month">{t('task.repeatUnit.month')}</option>
              <option value="year">{t('task.repeatUnit.year')}</option>
            </select>
          </label>
          <p className="col-span-2 text-[11px] leading-relaxed text-muted text-pretty">{t('task.recurringHint')}</p>
        </div>
      )}
    </div>
  )
}
