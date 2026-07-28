import { useEffect, useMemo, useState, type DragEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import ReactECharts from 'echarts-for-react'
import type { EChartsOption } from 'echarts'
import {
  ArrowDownRight,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Eye,
  Link2,
  ShieldCheck,
  Target,
  Upload,
} from 'lucide-react'
import { trpc } from '@/lib/trpc'
import { cn, fieldCls } from '@/lib/utils'
import { todayIso } from '@/lib/date'
import { resolveWishlistBalance } from '@/lib/level'
import { useUi } from '@/store/ui'
import { useTheme } from '@/store/theme'
import { toast } from '@/store/toast'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Toggle'
import { useT } from '@/i18n/useT'
import { LoadingState, QueryError } from '@/components/ui/QueryState'
import { platformColor } from '@/components/events/meta'

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

const CLASS_COLOR: Record<string, string> = {
  hit: '--success',
  fail: '--alarm',
  neutral: '--info',
  ambiguous: '--warning',
  unknown: '--muted',
}

const EVIDENCE_COLOR: Record<string, string> = {
  confirmed: '--success',
  traffic: '--info',
  weak: '--muted',
}

const sum = (values: Array<number | null | undefined>) =>
  values.reduce<number>((total, value) => total + (value ?? 0), 0)
const pct = (value: number | null | undefined) => (value == null ? '—' : `${Math.round(value * 100)}%`)

type AnalyticsPeriod = '7d' | '30d' | 'all'
type ImportKind = 'wishlists' | 'utm_daily' | 'utm_country' | 'steam_traffic'
type FileImportResult = { filename: string; kind?: ImportKind; imported?: number; error?: string }

function shiftDate(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

export function Analytics() {
  const t = useT()
  const { gameId } = useParams<{ gameId: string }>()
  const setCurrentGame = useUi((state) => state.setCurrentGame)
  const themeMode = useTheme((state) => state.mode)
  const qc = useQueryClient()
  const navigate = useNavigate()

  const [isDraggingCsv, setIsDraggingCsv] = useState(false)
  const [importResults, setImportResults] = useState<FileImportResult[]>([])
  const [point, setPoint] = useState({ date: todayIso(), adds: '', balance: '' })
  const [period, setPeriod] = useState<AnalyticsPeriod>('7d')
  const [periodPage, setPeriodPage] = useState(0)

  const range = useMemo(() => {
    if (period === 'all') return { start: null, end: null, days: null }
    const days = period === '7d' ? 7 : 30
    const end = shiftDate(todayIso(), -periodPage * days)
    return { start: shiftDate(end, -(days - 1)), end, days }
  }, [period, periodPage])

  useEffect(() => {
    if (gameId) setCurrentGame(gameId)
  }, [gameId, setCurrentGame])

  const series = useQuery({
    queryKey: ['wishlist', gameId],
    queryFn: () => trpc.wishlists.series.query({ gameId: gameId! }),
    enabled: !!gameId,
  })
  const events = useQuery({
    queryKey: ['events', gameId],
    queryFn: () => trpc.events.list.query({ gameId: gameId! }),
    enabled: !!gameId,
  })
  const impact = useQuery({
    queryKey: ['impact', gameId],
    queryFn: () => trpc.analytics.impact.query({ gameId: gameId! }),
    enabled: !!gameId,
  })
  const overview = useQuery({
    queryKey: ['analytics-overview', gameId, range.start, range.end],
    queryFn: () =>
      trpc.analytics.overview.query({
        gameId: gameId!,
        dateFrom: range.start ?? undefined,
        dateTo: range.end ?? undefined,
      }),
    enabled: !!gameId,
  })
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['wishlist', gameId] })
    void qc.invalidateQueries({ queryKey: ['impact', gameId] })
    void qc.invalidateQueries({ queryKey: ['analytics-overview', gameId] })
    void qc.invalidateQueries({ queryKey: ['companion-snapshot', gameId] })
  }

  const importData = useMutation({
    mutationFn: async (files: File[]): Promise<FileImportResult[]> => {
      const results: FileImportResult[] = []
      for (const file of files) {
        if (!file.name.toLowerCase().endsWith('.csv')) {
          results.push({ filename: file.name, error: t('an.csvOnly') })
          continue
        }
        try {
          const csv = await file.text()
          const result = await trpc.analytics.importCsv.mutate({ gameId: gameId!, csv, filename: file.name })
          results.push({ filename: file.name, kind: result.kind, imported: result.imported })
        } catch (error) {
          results.push({ filename: file.name, error: error instanceof Error ? error.message : String(error) })
        }
      }
      return results
    },
    onSuccess: (results) => {
      setImportResults(results)
      const successful = results.filter((result) => !result.error)
      const failed = results.length - successful.length
      if (successful.length) {
        toast.success(
          t('an.importComplete', {
            files: successful.length,
            rows: sum(successful.map((result) => result.imported)),
          }),
        )
        refresh()
      }
      if (failed) toast.error(t('an.importFailed', { n: failed }))
    },
  })
  const addPoint = useMutation({
    mutationFn: () =>
      trpc.wishlists.addPoint.mutate({
        gameId: gameId!,
        date: point.date,
        adds: point.adds ? Number(point.adds) : null,
        balance: point.balance ? Number(point.balance) : null,
      }),
    onSuccess: () => {
      setPoint({ date: todayIso(), adds: '', balance: '' })
      refresh()
    },
    onError: toast.fromError,
  })
  const onFiles = (files: FileList | File[]) => {
    const selected = Array.from(files)
    if (selected.length) importData.mutate(selected)
  }
  const onCsvDrag = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (
      event.type === 'dragleave' &&
      event.relatedTarget instanceof Node &&
      event.currentTarget.contains(event.relatedTarget)
    )
      return
    setIsDraggingCsv(event.type === 'dragenter' || event.type === 'dragover')
  }
  const onCsvDrop = (event: DragEvent<HTMLLabelElement>) => {
    onCsvDrag(event)
    setIsDraggingCsv(false)
    onFiles(event.dataTransfer.files)
  }

  const periodPoints = useMemo(
    () =>
      (series.data ?? []).filter(
        (item) => (!range.start || item.date >= range.start) && (!range.end || item.date <= range.end),
      ),
    [range.end, range.start, series.data],
  )
  const periodEvents = useMemo(
    () =>
      (events.data ?? []).filter(
        (item) => (!range.start || item.occurredAt >= range.start) && (!range.end || item.occurredAt <= range.end),
      ),
    [events.data, range.end, range.start],
  )
  const balancePoints = useMemo(
    () => (series.data ?? []).filter((item) => !range.end || item.date <= range.end),
    [range.end, series.data],
  )
  const latestBalance = useMemo(() => resolveWishlistBalance(balancePoints), [balancePoints])
  const balanceEstimated = Boolean(balancePoints.length && !balancePoints.some((item) => item.balance != null))
  const velocity = useMemo(() => {
    const current = sum(periodPoints.map((item) => item.adds))
    if (!range.start || !range.days) return { current, previous: 0, delta: null }
    const previousEnd = shiftDate(range.start, -1)
    const previousStart = shiftDate(previousEnd, -(range.days - 1))
    const previous = sum(
      (series.data ?? [])
        .filter((item) => item.date >= previousStart && item.date <= previousEnd)
        .map((item) => item.adds),
    )
    return { current, previous, delta: previous ? (current - previous) / previous : null }
  }, [periodPoints, range.days, range.start, series.data])

  const earliestDate = useMemo(
    () =>
      [
        ...(series.data ?? []).map((item) => item.date),
        ...(events.data ?? []).map((item) => item.occurredAt),
        ...(overview.data?.imports.utmDaily?.dateFrom ? [overview.data.imports.utmDaily.dateFrom] : []),
      ].sort()[0] ?? null,
    [events.data, overview.data?.imports.utmDaily?.dateFrom, series.data],
  )
  const canPageBack = Boolean(range.start && earliestDate && range.start > earliestDate)

  const chartOption = useMemo(() => {
    void themeMode
    const accent = token('--accent') || '#ff6a3d'
    const info = token('--info') || '#4d9dff'
    const muted = token('--muted') || '#888'
    const border = token('--border') || '#ccc'
    const text = token('--text') || '#111'
    const surface = token('--surface') || '#fff'
    const points = periodPoints
    const dates = [
      ...new Set([...points.map((item) => item.date), ...periodEvents.map((item) => item.occurredAt)]),
    ].sort()
    const byDate = new Map(points.map((item) => [item.date, item]))
    const adds = dates.map((date) => byDate.get(date)?.adds ?? null)
    const allAdds = new Map(
      (series.data ?? []).filter((item) => item.adds != null).map((item) => [item.date, item.adds!]),
    )
    const baseline = dates.map((date) => {
      const observed = Array.from({ length: 7 }, (_, index) => allAdds.get(shiftDate(date, -index))).filter(
        (value): value is number => value != null,
      )
      return observed.length ? Math.round((sum(observed) / observed.length) * 10) / 10 : null
    })
    const maxAdds = Math.max(10, ...adds.map((value) => value ?? 0))
    const eventData = periodEvents.map((event) => ({
      value: [event.occurredAt, maxAdds * 1.08],
      symbolSize: event.views ? Math.min(30, 10 + Math.sqrt(event.views) / 5) : 12,
      itemStyle: { color: platformColor(event.platform), borderColor: surface, borderWidth: 2 },
      event,
    }))

    return {
      animationDuration: 280,
      grid: { left: 44, right: 20, top: 42, bottom: 42 },
      legend: { top: 4, textStyle: { color: muted, fontSize: 11 } },
      tooltip: {
        trigger: 'item',
        backgroundColor: surface,
        borderColor: border,
        textStyle: { color: text, fontSize: 12 },
        formatter: (value: any) => {
          if (value.seriesType === 'scatter' && value.data?.event) {
            const event = value.data.event
            return [
              event.occurredAt,
              event.title,
              event.views != null ? `${event.views.toLocaleString()} ${t('an.views')}` : '',
            ]
              .filter(Boolean)
              .join('<br/>')
          }
          return `${value.name}<br/>${value.seriesName}: ${value.value ?? '—'}`
        },
      },
      xAxis: {
        type: 'category',
        data: dates,
        boundaryGap: true,
        axisLine: { lineStyle: { color: border } },
        axisTick: { show: false },
        axisLabel: { color: muted, fontSize: 11, hideOverlap: true, formatter: (value: string) => value.slice(5) },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        max: Math.ceil(maxAdds * 1.18),
        axisLabel: { color: muted, fontSize: 11 },
        splitLine: { lineStyle: { color: border, opacity: 0.45 } },
      },
      series: [
        {
          name: t('an.dailyAdds'),
          type: 'bar',
          data: adds,
          itemStyle: { color: `${accent}cc`, borderRadius: [3, 3, 0, 0] },
          barMaxWidth: 22,
        },
        {
          name: t('an.baseline'),
          type: 'line',
          data: baseline,
          showSymbol: false,
          smooth: 0.25,
          lineStyle: { color: info, width: 2, type: 'dashed' },
          itemStyle: { color: info },
        },
        { name: t('an.events'), type: 'scatter', data: eventData, z: 5 },
      ],
    }
  }, [periodEvents, periodPoints, series.data, themeMode, t])

  if (!gameId) return null
  const impacts = (impact.data?.impacts ?? []).filter(
    (item) => (!range.start || item.occurredAt >= range.start) && (!range.end || item.occurredAt <= range.end),
  )
  const campaigns = overview.data?.utm.campaigns ?? []
  const totals = overview.data?.utm.totals
  const traffic = overview.data?.traffic
  const isLoading = series.isLoading || events.isLoading || impact.isLoading || overview.isLoading
  const error = series.error ?? events.error ?? impact.error ?? overview.error
  const periodLabel = period === 'all' ? t('an.periodAll') : `${range.start} — ${range.end}`

  return (
    <div className="enter-stagger mx-auto max-w-6xl space-y-6">
      <header>
        <h1 className="t-title text-balance">{t('nav.analytics')}</h1>
        <p className="mt-1 max-w-2xl t-body text-pretty text-muted">{t('an.subtitle')}</p>
      </header>

      <section className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] bg-surface p-2 shadow-hard">
        <Segmented
          value={period}
          onChange={(value) => {
            setPeriod(value)
            setPeriodPage(0)
          }}
          ariaLabel={t('an.period')}
          items={[
            { value: '7d', label: t('an.period7') },
            { value: '30d', label: t('an.period30') },
            { value: 'all', label: t('an.periodAll') },
          ]}
        />
        <div className="flex min-h-10 items-center gap-1">
          {period !== 'all' && (
            <button
              type="button"
              onClick={() => setPeriodPage((page) => page + 1)}
              disabled={!canPageBack}
              className="tap inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius)] text-muted hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-35"
              aria-label={t('an.periodPrevious')}
              title={t('an.periodPrevious')}
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
          )}
          <span className="nums min-w-48 px-2 text-center t-hint text-text">{periodLabel}</span>
          {period !== 'all' && (
            <button
              type="button"
              onClick={() => setPeriodPage((page) => Math.max(0, page - 1))}
              disabled={periodPage === 0}
              className="tap inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius)] text-muted hover:bg-surface-2 hover:text-text disabled:cursor-not-allowed disabled:opacity-35"
              aria-label={t('an.periodNext')}
              title={t('an.periodNext')}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          )}
        </div>
      </section>

      {error && (
        <QueryError
          error={error}
          onRetry={() => {
            void series.refetch()
            void events.refetch()
            void impact.refetch()
            void overview.refetch()
          }}
        />
      )}
      {isLoading && <LoadingState />}

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label={t('an.summary')}>
        <MetricCard
          label={t('an.currentBalance')}
          value={latestBalance?.toLocaleString() ?? '—'}
          note={balanceEstimated ? t('an.calculatedBalance') : t('an.wishlists')}
        />
        <MetricCard
          label={period === 'all' ? t('an.allTimeAdds') : t('an.periodAdds', { n: range.days ?? 0 })}
          value={`+${velocity.current.toLocaleString()}`}
          note={
            velocity.delta == null
              ? t('an.noComparison')
              : t('an.vsPreviousPeriod', {
                  n: `${velocity.delta >= 0 ? '+' : ''}${Math.round(velocity.delta * 100)}%`,
                })
          }
          trend={velocity.delta}
        />
        <MetricCard
          label={t('an.utmWishlists')}
          value={totals ? totals.wishlists.toLocaleString() : '—'}
          note={overview.data?.imports.utmDaily ? t('an.direct72h') : t('an.importUtmHint')}
        />
        <MetricCard
          label={t('an.trackedCoverage')}
          value={pct(totals?.trackedCoverage)}
          note={
            totals
              ? t('an.trackedOfTrusted', { tracked: totals.trackedVisits, trusted: totals.trustedVisits })
              : t('an.noUtm')
          }
        />
      </section>

      <section className="rounded-[16px] bg-surface p-4 shadow-hard">
        <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="t-section text-balance">{t('an.trendTitle')}</h2>
            <p className="mt-0.5 t-hint text-pretty">{t('an.trendSubtitle')}</p>
          </div>
          {periodPoints.at(-1)?.date && (
            <span className="nums t-hint">{t('an.updatedTo', { date: periodPoints.at(-1)!.date })}</span>
          )}
        </div>
        {periodPoints.length > 0 ? (
          <ReactECharts
            option={chartOption as unknown as EChartsOption}
            style={{ height: 320 }}
            notMerge
            onEvents={{
              click: (value: any) => {
                if (value.seriesType === 'scatter' && value.data?.event?.id)
                  navigate(`/g/${gameId}/events?activity=${value.data.event.id}`)
              },
            }}
          />
        ) : (
          <EmptyState text={t('an.noData')} />
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="t-section text-balance">{t('an.performance')}</h2>
          <p className="mt-0.5 t-hint text-pretty">{t('an.performanceSubtitle')}</p>
        </div>
        {impacts.length ? (
          <div className="overflow-hidden rounded-[16px] bg-surface shadow-hard">
            {impacts.map((item) => {
              const event = (events.data ?? []).find((value) => value.id === item.eventId)
              const color = token(CLASS_COLOR[item.classification])
              return (
                <button
                  type="button"
                  key={item.eventId}
                  onClick={() => navigate(`/g/${gameId}/events?activity=${item.eventId}`)}
                  className="hoverlift flex min-h-16 w-full items-center gap-3 border-b border-border px-4 py-3 text-left last:border-b-0"
                >
                  <span className="h-8 w-1 shrink-0 rounded-full" style={{ backgroundColor: color }} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate t-body font-medium">{item.title}</span>
                    <span className="mt-0.5 block truncate t-hint">
                      {item.occurredAt}
                      {event?.platform ? ` · ${event.platform}` : ''}
                      {event?.views != null ? ` · ${event.views.toLocaleString()} ${t('an.views')}` : ''}
                      {item.confounders ? ` · ${t('an.overlaps', { n: item.confounders })}` : ''}
                    </span>
                  </span>
                  <span className="hidden text-right sm:block">
                    <span className="nums block t-body font-medium">
                      {item.lift == null ? '—' : `${item.lift >= 0 ? '+' : ''}${item.lift}`}
                    </span>
                    <span className="block t-hint">
                      {item.lift == null
                        ? t('an.needBaseline')
                        : t('an.actualVsExpected', { actual: item.addsAfter ?? 0, expected: item.baseline ?? 0 })}
                    </span>
                  </span>
                  <span
                    className="shrink-0 rounded-full px-2 py-1 t-hint"
                    style={{ color, backgroundColor: `${color}18` }}
                    title={t(`classReason.${item.classification}`)}
                  >
                    {t(`class.${item.classification}`)}
                  </span>
                </button>
              )
            })}
          </div>
        ) : (
          <EmptyState text={t('an.noEvents')} />
        )}
      </section>

      <section className="space-y-3">
        <div>
          <h2 className="t-section text-balance">{t('an.campaignsTitle')}</h2>
          <p className="mt-0.5 t-hint text-pretty">{t('an.campaignsSubtitle')}</p>
        </div>
        {campaigns.length ? (
          <div className="overflow-x-auto rounded-[16px] bg-surface shadow-hard">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead className="text-left t-hint">
                <tr className="border-b border-border">
                  <th className="px-4 py-3 font-medium">{t('an.campaign')}</th>
                  <th className="px-3 py-3 text-right font-medium">{t('an.trusted')}</th>
                  <th className="px-3 py-3 text-right font-medium">{t('an.tracked')}</th>
                  <th className="px-3 py-3 text-right font-medium">{t('an.wishlists')}</th>
                  <th className="px-3 py-3 text-right font-medium">{t('an.conversion')}</th>
                  <th className="px-4 py-3 text-right font-medium">{t('an.evidence')}</th>
                </tr>
              </thead>
              <tbody>
                {campaigns.map((row) => {
                  const color = token(EVIDENCE_COLOR[row.evidence])
                  return (
                    <tr key={row.key} className="border-b border-border last:border-b-0">
                      <td className="px-4 py-3">
                        <div className="font-medium">{row.source || t('an.unmarked')}</div>
                        <div className="max-w-md truncate t-hint">
                          {[row.campaign, row.content].filter(Boolean).join(' · ') || '—'}
                        </div>
                      </td>
                      <td className="nums px-3 py-3 text-right">{row.trustedVisits.toLocaleString()}</td>
                      <td className="nums px-3 py-3 text-right">
                        {row.trackedVisits.toLocaleString()}{' '}
                        <span className="text-muted">({pct(row.trackedCoverage)})</span>
                      </td>
                      <td className="nums px-3 py-3 text-right font-medium text-accent">
                        {row.wishlists.toLocaleString()}
                      </td>
                      <td className="nums px-3 py-3 text-right">{pct(row.conversion)}</td>
                      <td className="px-4 py-3 text-right">
                        <span
                          className="rounded-full px-2 py-1 t-hint"
                          style={{ color, backgroundColor: `${color}18` }}
                        >
                          {t(`an.evidence.${row.evidence}`)}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState text={t('an.importUtmHint')} />
        )}
      </section>

      {period === 'all' && (traffic?.external.length || traffic?.discovery.length) && (
        <section className="space-y-3">
          <div>
            <h2 className="t-section text-balance">{t('an.trafficTitle')}</h2>
            <p className="mt-0.5 t-hint text-pretty">{t('an.trafficSubtitle')}</p>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <TrafficList
              title={t('an.externalTraffic')}
              rows={traffic.external.map((row) => ({ label: row.feature || row.category, value: row.visits }))}
            />
            <TrafficList
              title={t('an.steamDiscovery')}
              rows={traffic.discovery.map((row) => ({ label: row.feature || row.category, value: row.visits }))}
            />
          </div>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="t-section text-balance">{t('an.methodology')}</h2>
        <div className="grid gap-3 md:grid-cols-3">
          <MethodCard
            icon={Link2}
            title={t('an.methodDirectTitle')}
            body={t('an.methodDirectBody')}
            badge={t('an.strongEvidence')}
          />
          <MethodCard
            icon={Target}
            title={t('an.methodLiftTitle')}
            body={t('an.methodLiftBody')}
            badge={t('an.mediumEvidence')}
          />
          <MethodCard
            icon={Eye}
            title={t('an.methodContextTitle')}
            body={t('an.methodContextBody')}
            badge={t('an.contextOnly')}
          />
        </div>
        <p className="t-hint text-pretty">{t('an.methodFootnote')}</p>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-3 rounded-[16px] bg-surface p-4 shadow-hard">
          <div>
            <h2 className="t-section">{t('an.importData')}</h2>
            <p className="mt-0.5 t-hint text-pretty">{t('an.importDataHint')}</p>
          </div>
          <label
            className={cn(
              'flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-[12px] border border-dashed px-4 py-5 text-center',
              'transition-[background-color,border-color,box-shadow] duration-150 ease-out',
              isDraggingCsv
                ? 'border-accent bg-accent/10 shadow-[inset_0_0_0_1px_var(--accent)]'
                : 'border-border-strong bg-surface-2/50 hover:border-accent hover:bg-surface-2',
              importData.isPending && 'pointer-events-none opacity-60',
            )}
            onDragEnter={onCsvDrag}
            onDragOver={onCsvDrag}
            onDragLeave={onCsvDrag}
            onDrop={onCsvDrop}
            aria-busy={importData.isPending}
          >
            <Upload
              className={cn(
                'h-5 w-5 text-accent transition-transform duration-150 ease-out',
                isDraggingCsv && 'scale-110',
              )}
            />
            <span className="text-sm font-medium">
              {importData.isPending ? t('an.importing') : isDraggingCsv ? t('an.dropCsvActive') : t('an.dropAnyCsv')}
            </span>
            <span className="max-w-md text-pretty text-xs text-muted">{t('an.dropAnyCsvHint')}</span>
            <input
              type="file"
              accept=".csv,text/csv"
              multiple
              className="hidden"
              disabled={importData.isPending}
              onChange={(event) => {
                if (event.currentTarget.files) onFiles(event.currentTarget.files)
                event.currentTarget.value = ''
              }}
            />
          </label>
          {importResults.length > 0 && (
            <ul className="space-y-1" aria-live="polite">
              {importResults.map((result) => (
                <li
                  key={result.filename}
                  className="flex min-h-10 items-center justify-between gap-3 rounded-[10px] bg-surface-2 px-3 py-2 text-xs"
                >
                  <span className="min-w-0 truncate text-text">{result.filename}</span>
                  {result.error ? (
                    <span className="shrink-0 text-alarm">{t('an.importUnrecognized')}</span>
                  ) : (
                    <span className="nums shrink-0 text-accent">
                      {t(`an.importKind.${result.kind}`)} · {result.imported}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <details className="group rounded-[16px] bg-surface p-4 shadow-hard">
          <summary className="tap flex min-h-10 cursor-pointer list-none items-center justify-between gap-3">
            <div>
              <h2 className="t-section">{t('an.manualPoint')}</h2>
              <p className="mt-0.5 t-hint">{t('an.manualPointHint')}</p>
            </div>
            <CircleHelp className="h-4 w-4 text-muted" />
          </summary>
          <div className="mt-4 space-y-3 border-t border-border pt-4">
            <input
              type="date"
              className={fieldCls}
              value={point.date}
              onChange={(event) => setPoint({ ...point, date: event.target.value })}
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                type="number"
                className={fieldCls}
                placeholder={t('an.adds')}
                value={point.adds}
                onChange={(event) => setPoint({ ...point, adds: event.target.value })}
              />
              <input
                type="number"
                className={fieldCls}
                placeholder={t('an.balance')}
                value={point.balance}
                onChange={(event) => setPoint({ ...point, balance: event.target.value })}
              />
            </div>
            <Button size="sm" onClick={() => addPoint.mutate()} disabled={!point.date || addPoint.isPending}>
              {t('an.addPoint')}
            </Button>
          </div>
        </details>
      </section>
    </div>
  )
}

function MetricCard({
  label,
  value,
  note,
  trend,
}: {
  label: string
  value: string
  note: string
  trend?: number | null
}) {
  const TrendIcon = trend != null && trend < 0 ? ArrowDownRight : ArrowUpRight
  return (
    <div className="rounded-[16px] bg-surface p-4 shadow-hard">
      <div className="flex items-start justify-between gap-2">
        <span className="t-hint text-pretty">{label}</span>
        {trend != null && <TrendIcon className={cn('h-4 w-4', trend < 0 ? 'text-alarm' : 'text-success')} />}
      </div>
      <div className="nums mt-2 text-2xl font-medium tracking-tight text-text">{value}</div>
      <div className="mt-1 truncate t-hint">{note}</div>
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return <div className="rounded-[12px] bg-surface-2 px-4 py-8 text-center text-sm text-muted">{text}</div>
}

function MethodCard({
  icon: Icon,
  title,
  body,
  badge,
}: {
  icon: typeof Link2
  title: string
  body: string
  badge: string
}) {
  return (
    <article className="rounded-[16px] bg-surface p-4 shadow-hard">
      <div className="flex h-10 w-10 items-center justify-center rounded-[12px] bg-accent/10 text-accent">
        <Icon className="h-5 w-5" />
      </div>
      <h3 className="mt-3 t-section text-balance">{title}</h3>
      <p className="mt-1 t-body text-pretty text-muted">{body}</p>
      <span className="mt-3 inline-flex items-center gap-1 rounded-full bg-surface-2 px-2 py-1 t-hint">
        <ShieldCheck className="h-3.5 w-3.5" />
        {badge}
      </span>
    </article>
  )
}

function TrafficList({ title, rows }: { title: string; rows: Array<{ label: string; value: number }> }) {
  const max = Math.max(1, ...rows.map((row) => row.value))
  return (
    <div className="rounded-[16px] bg-surface p-4 shadow-hard">
      <h3 className="t-section">{title}</h3>
      <div className="mt-3 space-y-3">
        {rows.slice(0, 6).map((row) => (
          <div key={`${row.label}-${row.value}`}>
            <div className="mb-1 flex items-center justify-between gap-3 t-hint">
              <span className="truncate">{row.label}</span>
              <span className="nums shrink-0 text-text">{row.value.toLocaleString()}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-info"
                style={{ width: `${Math.max(2, (row.value / max) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
