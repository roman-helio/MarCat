import { useEffect, useId, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import ReactECharts from 'echarts-for-react'
import type { EChartsOption } from 'echarts'
import {
  ArrowDownRight,
  ArrowUpRight,
  BadgeCheck,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Eye,
  Gauge,
  Link2,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Target,
  TriangleAlert,
  Upload,
} from 'lucide-react'
import { trpc } from '@/lib/trpc'
import { cn, fieldCls } from '@/lib/utils'
import { todayIso } from '@/lib/date'
import { resolveWishlistBalance } from '@/lib/level'
import { EMPTY_SECTION_VIEW_STATE, useUi } from '@/store/ui'
import { useTheme } from '@/store/theme'
import { toast } from '@/store/toast'
import { Button } from '@/components/ui/Button'
import { DetailDrawer } from '@/components/ui/DetailDrawer'
import { Segmented } from '@/components/ui/Toggle'
import { PageHeader, Toolbar } from '@/components/ui/Screen'
import { compareListValues, SortableHeader, type SortDirection } from '@/components/ui/DataList'
import { useT } from '@/i18n/useT'
import { LoadingState, QueryError } from '@/components/ui/QueryState'
import { platformColor } from '@/components/events/meta'

function token(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

const CLASS_COLOR: Record<string, string> = {
  above_expected: '--success',
  below_expected: '--alarm',
  within_expected: '--info',
  joint_effect: '--warning',
  pending: '--warning',
  insufficient: '--muted',
}

const EVIDENCE_COLOR: Record<string, string> = {
  confirmed: '--success',
  traffic: '--info',
  weak: '--muted',
}

const sum = (values: Array<number | null | undefined>) =>
  values.reduce<number>((total, value) => total + (value ?? 0), 0)
const pct = (value: number | null | undefined) => (value == null ? '—' : `${Math.round(value * 100)}%`)

function formatMoney(cents: number | null | undefined, currency: string): string {
  if (cents == null) return '—'
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(cents / 100)
  } catch {
    return `${(cents / 100).toLocaleString()} ${currency}`
  }
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

const signed = (value: number | null | undefined) =>
  value == null ? '—' : `${value >= 0 ? '+' : ''}${value.toLocaleString()}`

type AnalyticsPeriod = '7d' | '30d' | 'all'
type AnalyticsView = 'overview' | 'campaigns' | 'activities' | 'data'
type WishlistChartMode = 'daily' | 'cumulative'
type ImpactSortKey = 'title' | 'occurredAt' | 'platform' | 'views' | 'lift' | 'classification'
type CampaignSortKey =
  | 'campaign'
  | 'trustedVisits'
  | 'trackedVisits'
  | 'wishlists'
  | 'conversion'
  | 'effectiveYield'
  | 'evidence'
type DataEntryMode = 'csv' | 'manual'
type ImportKind = 'wishlists' | 'utm_daily' | 'utm_country' | 'steam_traffic'
type CampaignObjective = 'wishlist_growth' | 'traffic' | 'sales' | 'awareness'
type CampaignStatus = 'planned' | 'active' | 'completed' | 'archived'
type FileImportResult = {
  filename: string
  kind?: ImportKind
  imported?: number
  warnings?: string[]
  provisionalRows?: number
  duplicate?: boolean
  error?: string
}

const ANALYTICS_PERIODS: AnalyticsPeriod[] = ['7d', '30d', 'all']
const ANALYTICS_VIEWS: AnalyticsView[] = ['overview', 'campaigns', 'activities', 'data']
const CHART_MODES: WishlistChartMode[] = ['daily', 'cumulative']
const IMPACT_SORT_KEYS: ImpactSortKey[] = ['title', 'occurredAt', 'platform', 'views', 'lift', 'classification']
const CAMPAIGN_SORT_KEYS: CampaignSortKey[] = [
  'campaign',
  'trustedVisits',
  'trackedVisits',
  'wishlists',
  'conversion',
  'effectiveYield',
  'evidence',
]

function storedChoice<T extends string>(value: unknown, choices: readonly T[], fallback: T): T {
  return typeof value === 'string' && choices.includes(value as T) ? (value as T) : fallback
}

function shiftDate(iso: string, days: number): string {
  const date = new Date(`${iso}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function pointNet(point: {
  net?: number | null
  adds?: number | null
  deletes?: number | null
  purchasesAndActivations?: number | null
  gifts?: number | null
}) {
  return (
    point.net ?? (point.adds ?? 0) - (point.deletes ?? 0) - (point.purchasesAndActivations ?? 0) - (point.gifts ?? 0)
  )
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

export function Analytics() {
  const t = useT()
  const { gameId } = useParams<{ gameId: string }>()
  const setCurrentGame = useUi((state) => state.setCurrentGame)
  const sectionKey = `analytics:${gameId ?? 'none'}`
  const sectionState = useUi((state) => state.sectionViewStates?.[sectionKey] ?? EMPTY_SECTION_VIEW_STATE)
  const setSectionViewState = useUi((state) => state.setSectionViewState)
  const themeMode = useTheme((state) => state.mode)
  const qc = useQueryClient()
  const navigate = useNavigate()

  const [isDraggingCsv, setIsDraggingCsv] = useState(false)
  const [importResults, setImportResults] = useState<FileImportResult[]>([])
  const [point, setPoint] = useState({ date: todayIso(), adds: '', balance: '' })
  const view = storedChoice(sectionState.view, ANALYTICS_VIEWS, 'overview')
  const period = storedChoice(sectionState.period, ANALYTICS_PERIODS, '7d')
  const periodPage =
    typeof sectionState.periodPage === 'number' && sectionState.periodPage >= 0
      ? Math.floor(sectionState.periodPage)
      : 0
  const chartMode = storedChoice(sectionState.chartMode, CHART_MODES, 'daily')
  const impactSortKey = storedChoice(sectionState.impactSortKey, IMPACT_SORT_KEYS, 'occurredAt')
  const impactSortDirection: SortDirection = sectionState.impactSortDirection === 'asc' ? 'asc' : 'desc'
  const campaignSortKey = storedChoice(sectionState.campaignSortKey, CAMPAIGN_SORT_KEYS, 'wishlists')
  const campaignSortDirection: SortDirection = sectionState.campaignSortDirection === 'asc' ? 'asc' : 'desc'
  const performanceCollapsed = sectionState.performanceCollapsed === true
  const campaignsCollapsed = sectionState.campaignsCollapsed === true
  const dataEntryMode = storedChoice(sectionState.dataEntryMode, ['csv', 'manual'] as const, 'csv')
  const selectedCampaignId =
    typeof sectionState.selectedCampaignId === 'string' ? sectionState.selectedCampaignId : null
  const selectedCampaignKey =
    typeof sectionState.selectedCampaignKey === 'string' ? sectionState.selectedCampaignKey : null
  const updateViewState = (patch: Record<string, string | number | boolean | null>) =>
    setSectionViewState(sectionKey, patch)

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
          const result = await trpc.analytics.importCsv.mutate({
            gameId: gameId!,
            csv,
            filename: file.name,
            fileModifiedAt: new Date(file.lastModified).toISOString(),
          })
          results.push({
            filename: file.name,
            kind: result.kind,
            imported: result.imported,
            warnings: result.warnings,
            provisionalRows: result.provisionalRows,
            duplicate: result.duplicate,
          })
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
    const current = sum(periodPoints.map(pointNet))
    if (!range.start || !range.days) return { current, previous: 0, delta: null }
    const previousEnd = shiftDate(range.start, -1)
    const previousStart = shiftDate(previousEnd, -(range.days - 1))
    const previous = sum(
      (series.data ?? []).filter((item) => item.date >= previousStart && item.date <= previousEnd).map(pointNet),
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
    const netChanges = dates.map((date) => {
      const point = byDate.get(date)
      return point ? pointNet(point) : null
    })
    const balances = dates.map((date) =>
      resolveWishlistBalance((series.data ?? []).filter((item) => item.date <= date)),
    )
    const allNet = new Map((series.data ?? []).map((item) => [item.date, pointNet(item)]))
    const expected = dates.map((date) => {
      const observed = Array.from({ length: 14 }, (_, index) => allNet.get(shiftDate(date, -(index + 1)))).filter(
        (value): value is number => value != null,
      )
      if (!observed.length) return null
      const centre = median(observed)
      const mad = median(observed.map((value) => Math.abs(value - centre)))
      const noise = Math.max(mad * 1.4826, Math.sqrt(Math.max(Math.abs(centre), 1)))
      return {
        centre: Math.round(centre * 10) / 10,
        lower: Math.round((centre - 1.5 * noise) * 10) / 10,
        upper: Math.round((centre + 1.5 * noise) * 10) / 10,
      }
    })
    const chartValues = chartMode === 'daily' ? netChanges : balances
    const chartMax = Math.max(
      10,
      ...chartValues.map((value) => value ?? 0),
      ...expected.map((value) => value?.upper ?? 0),
    )
    const chartMin = Math.min(
      0,
      ...chartValues.map((value) => value ?? 0),
      ...expected.map((value) => value?.lower ?? 0),
    )
    const eventData = periodEvents.map((event) => ({
      value: [event.occurredAt, chartMax * 1.08],
      symbolSize: event.views ? Math.min(30, 10 + Math.sqrt(event.views) / 5) : 12,
      itemStyle: { color: platformColor(event.platform), borderColor: surface, borderWidth: 2 },
      event,
    }))
    const detailByDate = new Map(
      dates.map((date, index) => [
        date,
        {
          point: byDate.get(date),
          balance: balances[index],
          expected: expected[index],
          events: periodEvents.filter((event) => event.occurredAt === date),
        },
      ]),
    )

    return {
      animationDuration: 280,
      grid: { left: 44, right: 20, top: 42, bottom: 42 },
      legend: { top: 4, textStyle: { color: muted, fontSize: 11 } },
      tooltip: {
        trigger: 'axis',
        confine: true,
        transitionDuration: 0.12,
        backgroundColor: surface,
        borderColor: border,
        borderWidth: 1,
        padding: 0,
        extraCssText: 'border-radius: 12px; box-shadow: 0 12px 32px rgba(0,0,0,.16);',
        textStyle: { color: text, fontSize: 12 },
        axisPointer: {
          type: 'line',
          snap: true,
          lineStyle: { color: accent, width: 1, type: 'dashed', opacity: 0.75 },
          label: { show: false },
        },
        formatter: (rawValues: any) => {
          const values = Array.isArray(rawValues) ? rawValues : [rawValues]
          const date = String(values[0]?.axisValue ?? values[0]?.name ?? '')
          const detail = detailByDate.get(date)
          if (!detail) return escapeHtml(date)
          const point = detail.point
          const expectedLabel = detail.expected
            ? `${detail.expected.lower.toLocaleString()} — ${detail.expected.upper.toLocaleString()}`
            : '—'
          const metrics = [
            [
              chartMode === 'daily' ? t('an.dailyAdds') : t('an.cumulativeBalance'),
              chartMode === 'daily'
                ? signed(point ? pointNet(point) : null)
                : (detail.balance?.toLocaleString() ?? '—'),
            ],
            [
              chartMode === 'daily' ? t('an.tooltipBalance') : t('an.dailyAdds'),
              chartMode === 'daily'
                ? (detail.balance?.toLocaleString() ?? '—')
                : signed(point ? pointNet(point) : null),
            ],
            [t('an.adds'), point?.adds?.toLocaleString() ?? '—'],
            [t('an.tooltipDeletes'), point?.deletes?.toLocaleString() ?? '—'],
            [t('an.tooltipConversions'), point?.purchasesAndActivations?.toLocaleString() ?? '—'],
            [t('an.tooltipGifts'), point?.gifts?.toLocaleString() ?? '—'],
            [t('an.expectedRange'), expectedLabel],
          ]
          const metricsHtml = metrics
            .map(
              ([label, value]) =>
                `<div style="display:flex;justify-content:space-between;gap:24px;padding:3px 0"><span style="color:${muted}">${escapeHtml(label)}</span><strong style="font-variant-numeric:tabular-nums">${escapeHtml(value)}</strong></div>`,
            )
            .join('')
          const eventsHtml = detail.events.length
            ? `<div style="margin-top:10px;padding-top:8px;border-top:1px solid ${border}"><div style="margin-bottom:5px;color:${muted};font-size:11px;text-transform:uppercase;letter-spacing:.04em">${escapeHtml(t('an.events'))}</div>${detail.events
                .map(
                  (event) =>
                    `<div style="max-width:360px;margin-top:4px;white-space:normal"><strong>${escapeHtml(event.title)}</strong>${event.views != null ? `<span style="color:${muted}"> · ${escapeHtml(event.views.toLocaleString())} ${escapeHtml(t('an.views'))}</span>` : ''}</div>`,
                )
                .join('')}</div>`
            : ''
          return `<div style="min-width:260px;padding:12px 14px"><div style="margin-bottom:8px;font-weight:700">${escapeHtml(date)}</div>${metricsHtml}${eventsHtml}</div>`
        },
      },
      xAxis: {
        type: 'category',
        data: dates,
        boundaryGap: chartMode === 'daily',
        axisLine: { lineStyle: { color: border } },
        axisTick: { show: false },
        axisLabel: { color: muted, fontSize: 11, hideOverlap: true, formatter: (value: string) => value.slice(5) },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        min: chartMode === 'daily' ? Math.floor(chartMin * 1.08) : undefined,
        max: Math.ceil(chartMax * 1.18),
        scale: chartMode === 'cumulative',
        axisLabel: { color: muted, fontSize: 11 },
        splitLine: { lineStyle: { color: border, opacity: 0.45 } },
      },
      series:
        chartMode === 'daily'
          ? [
              {
                name: t('an.dailyAdds'),
                type: 'bar',
                data: netChanges,
                itemStyle: { color: `${accent}cc`, borderRadius: [3, 3, 0, 0] },
                barMaxWidth: 22,
              },
              {
                name: t('an.expectedPace'),
                type: 'line',
                data: expected.map((value) => value?.centre ?? null),
                showSymbol: false,
                smooth: 0.25,
                lineStyle: { color: info, width: 2, type: 'dashed' },
                itemStyle: { color: info },
              },
              {
                name: t('an.expectedRange'),
                type: 'line',
                data: expected.map((value) => value?.lower ?? null),
                stack: 'expected-range',
                symbol: 'none',
                lineStyle: { opacity: 0 },
                areaStyle: { opacity: 0 },
                tooltip: { show: false },
              },
              {
                name: t('an.expectedRange'),
                type: 'line',
                data: expected.map((value) => (value ? value.upper - value.lower : null)),
                stack: 'expected-range',
                symbol: 'none',
                lineStyle: { opacity: 0 },
                areaStyle: { color: `${info}20` },
                tooltip: { show: false },
              },
              { name: t('an.events'), type: 'scatter', data: eventData, z: 5 },
            ]
          : [
              {
                name: t('an.cumulativeBalance'),
                type: 'line',
                data: balances,
                showSymbol: dates.length <= 31,
                symbolSize: 5,
                smooth: 0.2,
                lineStyle: { color: accent, width: 2.5 },
                itemStyle: { color: accent },
                areaStyle: { color: `${accent}20` },
              },
              { name: t('an.events'), type: 'scatter', data: eventData, z: 5 },
            ],
    }
  }, [chartMode, periodEvents, periodPoints, series.data, themeMode, t])

  const eventById = useMemo(() => new Map((events.data ?? []).map((event) => [event.id, event])), [events.data])
  const impactItems = impact.data?.impacts
  const impacts = useMemo(() => {
    const valueOf = (item: NonNullable<typeof impactItems>[number]) => {
      const event = eventById.get(item.eventId)
      switch (impactSortKey) {
        case 'title':
          return item.title
        case 'occurredAt':
          return item.occurredAt
        case 'platform':
          return event?.platform ?? item.platform
        case 'views':
          return event?.views
        case 'lift':
          return item.lift
        case 'classification':
          return item.classification
      }
    }
    return (impactItems ?? [])
      .filter(
        (item) => (!range.start || item.occurredAt >= range.start) && (!range.end || item.occurredAt <= range.end),
      )
      .sort((a, b) => {
        const compared = compareListValues(valueOf(a), valueOf(b), impactSortDirection)
        return compared || b.occurredAt.localeCompare(a.occurredAt) || a.title.localeCompare(b.title)
      })
  }, [eventById, impactItems, impactSortDirection, impactSortKey, range.end, range.start])
  const campaignItems = overview.data?.utm.campaigns
  const campaigns = useMemo(() => {
    const valueOf = (row: NonNullable<typeof campaignItems>[number]) => {
      switch (campaignSortKey) {
        case 'campaign':
          return [row.source, row.campaign, row.content].filter(Boolean).join(' ')
        case 'trustedVisits':
          return row.trustedVisits
        case 'trackedVisits':
          return row.trackedVisits
        case 'wishlists':
          return row.wishlists
        case 'conversion':
          return row.conversion
        case 'effectiveYield':
          return row.effectiveYield
        case 'evidence':
          return row.evidence
      }
    }
    return [...(campaignItems ?? [])].sort((a, b) => {
      const compared = compareListValues(valueOf(a), valueOf(b), campaignSortDirection)
      return compared || a.source.localeCompare(b.source) || a.campaign.localeCompare(b.campaign)
    })
  }, [campaignItems, campaignSortDirection, campaignSortKey])
  const managedCampaigns = overview.data?.managedCampaigns ?? []
  const selectedManagedCampaign = selectedCampaignId
    ? managedCampaigns.find((campaign) => campaign.id === selectedCampaignId)
    : undefined
  const selectedRawCampaign = selectedCampaignKey
    ? campaigns.find((campaign) => campaign.key === selectedCampaignKey)
    : undefined
  const campaignEditorOpen = Boolean(selectedManagedCampaign || selectedRawCampaign)
  const closeCampaignEditor = () => updateViewState({ selectedCampaignId: null, selectedCampaignKey: null })

  if (!gameId) return null
  const totals = overview.data?.utm.totals
  const traffic = overview.data?.traffic
  const isLoading = series.isLoading || events.isLoading || impact.isLoading || overview.isLoading
  const error = series.error ?? events.error ?? impact.error ?? overview.error
  const periodLabel = period === 'all' ? t('an.periodAll') : `${range.start} — ${range.end}`
  const changeImpactSort = (key: ImpactSortKey) =>
    updateViewState({
      impactSortKey: key,
      impactSortDirection:
        impactSortKey === key
          ? impactSortDirection === 'asc'
            ? 'desc'
            : 'asc'
          : key === 'title' || key === 'platform'
            ? 'asc'
            : 'desc',
    })
  const changeCampaignSort = (key: CampaignSortKey) =>
    updateViewState({
      campaignSortKey: key,
      campaignSortDirection:
        campaignSortKey === key
          ? campaignSortDirection === 'asc'
            ? 'desc'
            : 'asc'
          : key === 'campaign' || key === 'evidence'
            ? 'asc'
            : 'desc',
    })

  return (
    <div className="page-stack">
      <PageHeader title={t('nav.analytics')} subtitle={t('an.subtitle')} />

      <Toolbar
        aria-label={t('an.viewMode')}
        navigation={
          <Segmented<AnalyticsView>
            value={view}
            onChange={(value) => updateViewState({ view: value })}
            ariaLabel={t('an.viewMode')}
            items={[
              { value: 'overview', label: t('an.viewOverview') },
              { value: 'campaigns', label: t('an.viewCampaigns') },
              { value: 'activities', label: t('an.viewActivities') },
              { value: 'data', label: t('an.viewData') },
            ]}
          />
        }
      />

      {view !== 'data' && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-[16px] bg-surface p-2 shadow-hard">
          <Segmented
            value={period}
            onChange={(value) => {
              updateViewState({ period: value, periodPage: 0 })
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
                onClick={() => updateViewState({ periodPage: periodPage + 1 })}
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
                onClick={() => updateViewState({ periodPage: Math.max(0, periodPage - 1) })}
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
      )}

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

      {view === 'overview' && (
        <>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" aria-label={t('an.summary')}>
            <MetricCard
              label={t('an.currentBalance')}
              value={latestBalance?.toLocaleString() ?? '—'}
              note={balanceEstimated ? t('an.calculatedBalance') : t('an.wishlists')}
            />
            <MetricCard
              label={period === 'all' ? t('an.allTimeNet') : t('an.periodNet', { n: range.days ?? 0 })}
              value={`${velocity.current >= 0 ? '+' : ''}${velocity.current.toLocaleString()}`}
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
              note={
                overview.data?.utm.source?.filename
                  ? t('an.sourceFile', { filename: overview.data.utm.source.filename })
                  : t('an.importUtmHint')
              }
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
            <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="t-section text-balance">{t('an.trendTitle')}</h2>
                <p className="mt-0.5 t-hint text-pretty">
                  {t(chartMode === 'daily' ? 'an.trendSubtitleDaily' : 'an.trendSubtitleCumulative')}
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                {periodPoints.at(-1)?.date && (
                  <span className="nums px-1 t-hint">{t('an.updatedTo', { date: periodPoints.at(-1)!.date })}</span>
                )}
                <Segmented
                  value={chartMode}
                  onChange={(value) => updateViewState({ chartMode: value })}
                  ariaLabel={t('an.chartMode')}
                  items={[
                    { value: 'daily', label: t('an.chartDaily') },
                    { value: 'cumulative', label: t('an.chartCumulative') },
                  ]}
                />
              </div>
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
        </>
      )}

      {view === 'activities' && (
        <CollapsibleSection
          title={t('an.performance')}
          subtitle={t('an.performanceSubtitle')}
          count={impacts.length}
          collapsed={performanceCollapsed}
          onToggle={() => updateViewState({ performanceCollapsed: !performanceCollapsed })}
        >
          {impacts.length ? (
            <div className="max-h-[620px] overflow-y-auto">
              <table className="w-full table-fixed border-collapse text-left text-xs">
                <colgroup>
                  <col className="w-[45%]" />
                  <col className="w-[11%]" />
                  <col className="w-[10%]" />
                  <col className="w-[9%]" />
                  <col className="w-[9%]" />
                  <col className="w-[16%]" />
                </colgroup>
                <thead className="sticky top-0 z-10 bg-surface-2 shadow-[0_1px_0_var(--border)]">
                  <tr>
                    {(
                      [
                        ['title', t('an.activity'), 'left'],
                        ['occurredAt', t('an.date'), 'left'],
                        ['platform', t('an.platform'), 'left'],
                        ['views', t('an.views'), 'right'],
                        ['lift', t('an.lift'), 'right'],
                        ['classification', t('an.evidence'), 'left'],
                      ] as Array<[ImpactSortKey, string, 'left' | 'right']>
                    ).map(([key, label, align], index) => (
                      <th key={key} scope="col" className={cn('px-1.5 py-1 font-normal', index === 0 && 'pl-4')}>
                        <SortableHeader
                          label={label}
                          active={impactSortKey === key}
                          direction={impactSortDirection}
                          onClick={() => changeImpactSort(key)}
                          align={align}
                          wrap
                          className="h-10 w-full min-w-0 whitespace-normal leading-tight"
                        />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {impacts.map((item) => {
                    const event = eventById.get(item.eventId)
                    const color = token(CLASS_COLOR[item.classification])
                    const diagnostic =
                      item.lift == null
                        ? t('an.needBaseline')
                        : t('an.actualVsExpected', {
                            actual: item.netAfter ?? 0,
                            expected: item.baseline ?? 0,
                          })
                    return (
                      <tr
                        key={item.eventId}
                        className="align-top transition-[background-color] duration-150 ease-out hover:bg-surface-2/55"
                      >
                        <td className="py-2.5 pr-2 pl-4">
                          <button
                            type="button"
                            onClick={() => navigate(`/g/${gameId}/events?activity=${item.eventId}`)}
                            className="tap block min-h-10 w-full min-w-0 rounded-[8px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                          >
                            <span
                              className="block truncate text-sm font-medium text-text hover:text-accent"
                              title={item.title}
                            >
                              {item.title}
                            </span>
                            <span className="mt-0.5 block truncate text-muted" title={diagnostic}>
                              {diagnostic}
                              {item.confounders ? ` · ${t('an.overlaps', { n: item.confounders })}` : ''}
                            </span>
                          </button>
                        </td>
                        <td className="nums px-1.5 py-3 text-muted">{item.occurredAt}</td>
                        <td className="truncate px-1.5 py-3 text-muted" title={event?.platform || item.platform || '—'}>
                          {event?.platform || item.platform || '—'}
                        </td>
                        <td className="nums px-1.5 py-3 text-right text-text">
                          {event?.views?.toLocaleString() ?? '—'}
                        </td>
                        <td className="nums px-1.5 py-3 text-right font-medium text-text">{signed(item.lift)}</td>
                        <td className="px-1.5 py-2.5">
                          <span
                            className="inline-flex max-w-full rounded-full px-2 py-1 text-center t-hint"
                            style={{ color, backgroundColor: `${color}18` }}
                            title={t(`classReason.${item.classification}`)}
                          >
                            <span className="truncate">{t(`class.${item.classification}`)}</span>
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="p-4">
              <EmptyState text={t('an.noEvents')} />
            </div>
          )}
        </CollapsibleSection>
      )}

      {view === 'campaigns' && (
        <>
          {overview.data?.highlights.length ? (
            <section className="space-y-3" aria-label={t('an.highlightsTitle')}>
              <div>
                <h2 className="t-section text-balance">{t('an.highlightsTitle')}</h2>
                <p className="mt-0.5 t-hint text-pretty">{t('an.highlightsSubtitle')}</p>
              </div>
              <div className="space-y-3">
                {overview.data.highlights.map((item, index) => {
                  const row = campaigns.find((campaign) => campaign.key === item.campaignKey)
                  return (
                    <CampaignHighlightCard
                      key={item.kind}
                      item={item}
                      priority={index + 1}
                      onOpen={() =>
                        updateViewState({
                          selectedCampaignId: row?.managedCampaignId ?? null,
                          selectedCampaignKey: item.campaignKey,
                        })
                      }
                    />
                  )
                })}
              </div>
            </section>
          ) : null}

          <section className="space-y-3" aria-label={t('an.managedCampaignsTitle')}>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="t-section text-balance">{t('an.managedCampaignsTitle')}</h2>
                <p className="mt-0.5 max-w-3xl t-hint text-pretty">{t('an.managedCampaignsSubtitle')}</p>
              </div>
              <span className="nums rounded-full bg-surface px-2.5 py-1 text-xs text-muted shadow-hard">
                {t('an.managedCampaignCount', { n: managedCampaigns.length })}
              </span>
            </div>

            {managedCampaigns.length ? (
              <div className="grid gap-3 lg:grid-cols-2">
                {managedCampaigns.map((campaign) => (
                  <button
                    key={campaign.id}
                    type="button"
                    onClick={() => updateViewState({ selectedCampaignId: campaign.id, selectedCampaignKey: null })}
                    className="tap min-h-32 rounded-[16px] bg-surface p-4 text-left shadow-hard transition-[transform,background-color,box-shadow] duration-150 ease-out hover:bg-surface-2/55 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                  >
                    <span className="flex items-start justify-between gap-3">
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-text">{campaign.name}</span>
                        <span className="mt-1 block t-hint">
                          {t(`an.campaignStatus.${campaign.status}`)} ·{' '}
                          {t(`an.campaignObjective.${campaign.objective}`)}
                        </span>
                      </span>
                      <span className="shrink-0 rounded-full bg-accent/10 px-2 py-1 text-xs font-medium text-accent">
                        {t('an.touchpointCount', { n: campaign.touchpoints.length })}
                      </span>
                    </span>
                    <span className="mt-4 grid grid-cols-3 gap-3">
                      <CampaignMiniMetric
                        label={t('an.wishlists')}
                        value={campaign.performance.wishlists.toLocaleString()}
                      />
                      <CampaignMiniMetric
                        label={t('an.spendVsBudget')}
                        value={`${formatMoney(campaign.spendCents, campaign.currency)} / ${formatMoney(campaign.budgetCents, campaign.currency)}`}
                      />
                      <CampaignMiniMetric
                        label={t('an.costPerWishlist')}
                        value={formatMoney(campaign.costPerWishlistCents, campaign.currency)}
                      />
                    </span>
                    <span className="nums mt-3 block truncate text-xs text-muted">
                      {t('an.campaignPlanMeta', {
                        start: campaign.plannedStart ?? '—',
                        end: campaign.plannedEnd ?? '—',
                        n: campaign.evaluationWindowDays,
                      })}
                      {campaign.budgetUtilization != null ? ` · ${pct(campaign.budgetUtilization)}` : ''}
                    </span>
                    {!campaign.economicsComparable && campaign.spendCents != null && (
                      <span className="mt-3 block text-xs text-warning">{t('an.economicsAllTimeOnly')}</span>
                    )}
                  </button>
                ))}
              </div>
            ) : (
              <div className="rounded-[16px] bg-surface p-4 shadow-hard">
                <p className="text-sm font-medium text-text">{t('an.noManagedCampaigns')}</p>
                <p className="mt-1 t-hint text-pretty">{t('an.noManagedCampaignsHint')}</p>
              </div>
            )}
          </section>

          <CollapsibleSection
            title={t('an.campaignsTitle')}
            subtitle={t('an.campaignsSubtitle')}
            count={campaigns.length}
            meta={
              overview.data?.utm.source?.filename
                ? t('an.sourceFile', { filename: overview.data.utm.source.filename })
                : undefined
            }
            collapsed={campaignsCollapsed}
            onToggle={() => updateViewState({ campaignsCollapsed: !campaignsCollapsed })}
          >
            {campaigns.length ? (
              <div className="max-h-[660px] overflow-y-auto">
                <table className="w-full table-fixed border-collapse text-left text-xs">
                  <colgroup>
                    <col className="w-[30%]" />
                    <col className="w-[9%]" />
                    <col className="w-[10%]" />
                    <col className="w-[8%]" />
                    <col className="w-[12%]" />
                    <col className="w-[12%]" />
                    <col className="w-[14%]" />
                    <col className="w-[5%]" />
                  </colgroup>
                  <thead className="sticky top-0 z-10 bg-surface-2 shadow-[0_1px_0_var(--border)]">
                    <tr>
                      {(
                        [
                          ['campaign', t('an.campaign'), 'left'],
                          ['trustedVisits', t('an.trusted'), 'right'],
                          ['trackedVisits', t('an.tracked'), 'right'],
                          ['wishlists', t('an.wishlists'), 'right'],
                          ['conversion', t('an.conversion'), 'right'],
                          ['effectiveYield', t('an.effectiveYield'), 'right'],
                          ['evidence', t('an.evidence'), 'left'],
                        ] as Array<[CampaignSortKey, string, 'left' | 'right']>
                      ).map(([key, label, align], index) => (
                        <th key={key} scope="col" className={cn('px-1.5 py-1 font-normal', index === 0 && 'pl-4')}>
                          <SortableHeader
                            label={label}
                            active={campaignSortKey === key}
                            direction={campaignSortDirection}
                            onClick={() => changeCampaignSort(key)}
                            align={align}
                            wrap
                            className="h-10 w-full min-w-0 whitespace-normal leading-tight"
                          />
                        </th>
                      ))}
                      <th scope="col" className="px-1 py-1">
                        <span className="sr-only">{t('an.configureCampaign')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {campaigns.map((row) => {
                      const color = token(EVIDENCE_COLOR[row.evidence])
                      const label = [row.campaign, row.content, row.term].filter(Boolean).join(' · ') || '—'
                      return (
                        <tr
                          key={row.key}
                          className="align-top transition-[background-color] duration-150 ease-out hover:bg-surface-2/55"
                        >
                          <td className="py-2.5 pr-2 pl-4">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <span
                                className="truncate text-sm font-semibold text-text"
                                title={row.source || t('an.unmarked')}
                              >
                                {row.source || t('an.unmarked')}
                              </span>
                              {row.managedCampaignName && (
                                <span
                                  className="max-w-[45%] shrink-0 truncate rounded-full bg-accent/10 px-1.5 py-0.5 t-caption font-medium text-accent"
                                  title={row.managedCampaignName}
                                >
                                  {row.managedCampaignName}
                                </span>
                              )}
                            </div>
                            <p className="mt-0.5 truncate text-muted" title={label}>
                              {label}
                            </p>
                          </td>
                          <td className="nums px-1.5 py-3 text-right text-text">
                            {row.trustedVisits.toLocaleString()}
                          </td>
                          <td className="nums px-1.5 py-3 text-right text-text">
                            {row.trackedVisits.toLocaleString()}
                            <span className="mt-0.5 block text-muted">{pct(row.trackedCoverage)}</span>
                          </td>
                          <td className="nums px-1.5 py-3 text-right font-medium text-accent">
                            {row.wishlists.toLocaleString()}
                          </td>
                          <td className="nums px-1.5 py-3 text-right text-text">{pct(row.conversion)}</td>
                          <td className="nums px-1.5 py-3 text-right text-text">{pct(row.effectiveYield)}</td>
                          <td className="px-1.5 py-2.5">
                            <span
                              className="inline-flex max-w-full rounded-full px-2 py-1 t-hint"
                              style={{ color, backgroundColor: `${color}18` }}
                              title={t(`an.evidence.${row.evidence}`)}
                            >
                              <span className="truncate">{t(`an.evidence.${row.evidence}`)}</span>
                            </span>
                          </td>
                          <td className="px-1 py-2">
                            <button
                              type="button"
                              onClick={() =>
                                updateViewState({
                                  selectedCampaignId: row.managedCampaignId,
                                  selectedCampaignKey: row.key,
                                })
                              }
                              className="tap inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius)] text-muted transition-[transform,background-color,color] duration-150 ease-out hover:bg-surface-2 hover:text-text active:scale-[0.96] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
                              aria-label={t(row.managedCampaignId ? 'an.editCampaign' : 'an.configureCampaign')}
                              title={t(row.managedCampaignId ? 'an.editCampaign' : 'an.configureCampaign')}
                            >
                              <Pencil className="h-4 w-4" aria-hidden />
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="p-4">
                <EmptyState text={t('an.importUtmHint')} />
              </div>
            )}
          </CollapsibleSection>

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
        </>
      )}

      {view === 'overview' && (
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
      )}

      {view === 'data' && (
        <>
          <DataQualityPanel quality={overview.data?.dataQuality} source={overview.data?.utm.source} />
          <section className="rounded-[16px] bg-surface p-4 shadow-hard">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="t-section text-balance">{t('an.dataTitle')}</h2>
                <p className="mt-0.5 max-w-2xl t-hint text-pretty">{t('an.dataSubtitle')}</p>
              </div>
              <Segmented<DataEntryMode>
                value={dataEntryMode}
                onChange={(value) => updateViewState({ dataEntryMode: value })}
                ariaLabel={t('an.dataMode')}
                items={[
                  { value: 'csv', label: t('an.dataTabCsv') },
                  { value: 'manual', label: t('an.dataTabManual') },
                ]}
              />
            </div>

            {dataEntryMode === 'csv' ? (
              <div className="mt-4 space-y-3">
                <label
                  className={cn(
                    'flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-[12px] border border-dashed px-4 py-5 text-center active:scale-[0.96]',
                    'transition-[scale,background-color,border-color,box-shadow] duration-150 ease-out',
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
                    {importData.isPending
                      ? t('an.importing')
                      : isDraggingCsv
                        ? t('an.dropCsvActive')
                        : t('an.dropAnyCsv')}
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
                          <span className="min-w-0 max-w-[62%] truncate text-right text-alarm" title={result.error}>
                            {result.error.includes('WISHLIST_COHORT_REPORT')
                              ? t('an.importCohortUnsupported')
                              : t('an.importUnrecognized')}
                          </span>
                        ) : (
                          <span className="nums shrink-0 text-accent">
                            {result.duplicate
                              ? t('an.importDuplicate')
                              : `${t(`an.importKind.${result.kind}`)} · ${result.imported}`}
                            {result.warnings?.length
                              ? ` · ${t('an.importWarnings', { n: result.warnings.length })}`
                              : ''}
                            {result.provisionalRows ? ` · ${t('an.importProvisional')}` : ''}
                          </span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ) : (
              <div className="mt-4 rounded-[12px] bg-surface-2 p-4">
                <div>
                  <h3 className="text-sm font-medium text-text">{t('an.manualPoint')}</h3>
                  <p className="mt-1 t-hint text-pretty">{t('an.manualPointHint')}</p>
                </div>
                <div className="mt-4 grid gap-3 sm:grid-cols-3">
                  <label className="space-y-1.5 text-xs font-medium text-muted">
                    <span>{t('an.date')}</span>
                    <input
                      type="date"
                      className={fieldCls}
                      value={point.date}
                      onChange={(event) => setPoint({ ...point, date: event.target.value })}
                    />
                  </label>
                  <label className="space-y-1.5 text-xs font-medium text-muted">
                    <span>{t('an.adds')}</span>
                    <input
                      type="number"
                      className={fieldCls}
                      value={point.adds}
                      onChange={(event) => setPoint({ ...point, adds: event.target.value })}
                    />
                  </label>
                  <label className="space-y-1.5 text-xs font-medium text-muted">
                    <span>{t('an.balance')}</span>
                    <input
                      type="number"
                      className={fieldCls}
                      value={point.balance}
                      onChange={(event) => setPoint({ ...point, balance: event.target.value })}
                    />
                  </label>
                </div>
                <Button
                  className="mt-4"
                  size="sm"
                  onClick={() => addPoint.mutate()}
                  disabled={!point.date || addPoint.isPending}
                >
                  {t('an.addPoint')}
                </Button>
              </div>
            )}
          </section>
        </>
      )}

      {campaignEditorOpen && (
        <CampaignEditor
          gameId={gameId}
          plan={selectedManagedCampaign}
          initialRow={selectedRawCampaign}
          rows={campaigns}
          onSaved={() => {
            closeCampaignEditor()
            void qc.invalidateQueries({ queryKey: ['analytics-overview', gameId] })
          }}
          onClose={closeCampaignEditor}
        />
      )}
    </div>
  )
}

function CampaignMiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <span className="min-w-0 rounded-[10px] bg-surface-2 px-3 py-2">
      <span className="block truncate t-hint">{label}</span>
      <span className="nums mt-0.5 block truncate text-sm font-semibold text-text" title={value}>
        {value}
      </span>
    </span>
  )
}

type RawCampaign = {
  key: string
  source: string
  campaign: string
  medium: string
  content: string
  term: string
  managedCampaignId: string | null
  managedCampaignName: string | null
}

type ManagedCampaign = {
  id: string
  name: string
  objective: CampaignObjective
  status: CampaignStatus
  plannedStart: string | null
  plannedEnd: string | null
  evaluationWindowDays: number
  budgetCents: number | null
  spendCents: number | null
  currency: string
  notes: string | null
  touchpoints: Array<{
    canonicalKey: string
    source: string
    campaign: string
    medium: string
    content: string
    term?: string | null
    eventId: string | null
  }>
}

type CampaignTouchpointDraft = {
  key: string
  source: string
  campaign: string
  medium: string
  content: string
  term: string
  eventId: string | null
  assignedTo: string | null
  assignedName: string | null
}

function moneyInputToCents(value: string): number | null {
  if (!value.trim()) return null
  const number = Number(value.replace(',', '.'))
  return Number.isFinite(number) && number >= 0 ? Math.round(number * 100) : null
}

function CampaignEditor({
  gameId,
  plan,
  initialRow,
  rows,
  onSaved,
  onClose,
}: {
  gameId: string
  plan?: ManagedCampaign
  initialRow?: RawCampaign
  rows: RawCampaign[]
  onSaved: () => void
  onClose: () => void
}) {
  const t = useT()
  const options = useMemo<CampaignTouchpointDraft[]>(() => {
    const result = new Map<string, CampaignTouchpointDraft>()
    for (const point of plan?.touchpoints ?? []) {
      result.set(point.canonicalKey, {
        key: point.canonicalKey,
        source: point.source,
        campaign: point.campaign,
        medium: point.medium,
        content: point.content,
        term: point.term ?? '',
        eventId: point.eventId,
        assignedTo: plan?.id ?? null,
        assignedName: plan?.name ?? null,
      })
    }
    for (const row of rows) {
      result.set(row.key, {
        key: row.key,
        source: row.source,
        campaign: row.campaign,
        medium: row.medium,
        content: row.content,
        term: row.term,
        eventId: result.get(row.key)?.eventId ?? null,
        assignedTo: row.managedCampaignId,
        assignedName: row.managedCampaignName,
      })
    }
    return [...result.values()]
  }, [plan, rows])
  const initialKeys = plan?.touchpoints.map((point) => point.canonicalKey) ?? (initialRow ? [initialRow.key] : [])
  const [selectedKeys, setSelectedKeys] = useState(() => new Set(initialKeys))
  const [showValidation, setShowValidation] = useState(false)
  const editorRef = useRef<HTMLDivElement>(null)
  const validationId = useId().replace(/:/g, '')
  const [draft, setDraft] = useState({
    name: plan?.name ?? initialRow?.campaign ?? initialRow?.content ?? initialRow?.source ?? '',
    objective: plan?.objective ?? ('wishlist_growth' as CampaignObjective),
    status: plan?.status ?? ('active' as CampaignStatus),
    plannedStart: plan?.plannedStart ?? '',
    plannedEnd: plan?.plannedEnd ?? '',
    evaluationWindowDays: String(plan?.evaluationWindowDays ?? 3),
    budget: plan?.budgetCents == null ? '' : String(plan.budgetCents / 100),
    spend: plan?.spendCents == null ? '' : String(plan.spendCents / 100),
    currency: plan?.currency ?? 'USD',
    notes: plan?.notes ?? '',
  })
  const budgetCents = moneyInputToCents(draft.budget)
  const spendCents = moneyInputToCents(draft.spend)
  const invalidBudget = draft.budget.trim() !== '' && budgetCents == null
  const invalidSpend = draft.spend.trim() !== '' && spendCents == null
  const invalidMoney = invalidBudget || invalidSpend
  const invalidName = draft.name.trim().length === 0
  const invalidWindow =
    !/^\d+$/.test(draft.evaluationWindowDays) ||
    Number(draft.evaluationWindowDays) < 1 ||
    Number(draft.evaluationWindowDays) > 60
  const invalidCurrency = !/^[A-Z]{3}$/.test(draft.currency.trim().toUpperCase())
  const invalidDateRange = Boolean(draft.plannedStart && draft.plannedEnd && draft.plannedEnd < draft.plannedStart)
  const selectedTouchpoints = options.filter((option) => selectedKeys.has(option.key))
  const save = useMutation({
    mutationFn: () =>
      trpc.analytics.upsertCampaign.mutate({
        id: plan?.id,
        gameId,
        name: draft.name.trim(),
        objective: draft.objective,
        status: draft.status,
        plannedStart: draft.plannedStart || null,
        plannedEnd: draft.plannedEnd || null,
        evaluationWindowDays: Number(draft.evaluationWindowDays),
        budgetCents,
        spendCents,
        currency: draft.currency.trim().toUpperCase(),
        notes: draft.notes.trim() || null,
        touchpoints: selectedTouchpoints.map((point) => ({
          source: point.source,
          campaign: point.campaign,
          medium: point.medium,
          content: point.content,
          term: point.term,
          eventId: point.eventId,
        })),
      }),
    onSuccess: () => {
      toast.success(t('an.campaignSaved'))
      onSaved()
    },
    onError: toast.fromError,
  })
  const canSave =
    !invalidName &&
    selectedTouchpoints.length > 0 &&
    !invalidMoney &&
    !invalidWindow &&
    !invalidCurrency &&
    !invalidDateRange

  const submit = () => {
    if (canSave) {
      save.mutate()
      return
    }
    setShowValidation(true)
    window.setTimeout(() => {
      editorRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus()
    }, 0)
  }

  return (
    <DetailDrawer
      label={plan ? t('an.editCampaign') : t('an.configureCampaign')}
      meta={plan ? <span className="rounded-full bg-surface-2 px-2 py-1 t-hint">{plan.name}</span> : undefined}
      onClose={onClose}
    >
      <div ref={editorRef} className="contents">
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1.5 text-xs font-medium text-muted sm:col-span-2">
            <span>{t('an.campaignName')}</span>
            <input
              autoFocus
              className={fieldCls}
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              required
              aria-invalid={(showValidation && invalidName) || undefined}
              aria-describedby={showValidation && invalidName ? `${validationId}-name` : undefined}
            />
            {showValidation && invalidName && (
              <span id={`${validationId}-name`} className="font-normal text-alarm">
                {t('an.requiredCampaignName')}
              </span>
            )}
          </label>
          <label className="space-y-1.5 text-xs font-medium text-muted">
            <span>{t('an.objective')}</span>
            <select
              className={fieldCls}
              value={draft.objective}
              onChange={(event) => setDraft({ ...draft, objective: event.target.value as CampaignObjective })}
            >
              {(['wishlist_growth', 'traffic', 'sales', 'awareness'] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`an.campaignObjective.${value}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5 text-xs font-medium text-muted">
            <span>{t('an.status')}</span>
            <select
              className={fieldCls}
              value={draft.status}
              onChange={(event) => setDraft({ ...draft, status: event.target.value as CampaignStatus })}
            >
              {(['planned', 'active', 'completed', 'archived'] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`an.campaignStatus.${value}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1.5 text-xs font-medium text-muted">
            <span>{t('an.plannedStart')}</span>
            <input
              type="date"
              className={fieldCls}
              value={draft.plannedStart}
              onChange={(event) => setDraft({ ...draft, plannedStart: event.target.value })}
            />
          </label>
          <label className="space-y-1.5 text-xs font-medium text-muted">
            <span>{t('an.plannedEnd')}</span>
            <input
              type="date"
              className={fieldCls}
              value={draft.plannedEnd}
              onChange={(event) => setDraft({ ...draft, plannedEnd: event.target.value })}
              aria-invalid={(showValidation && invalidDateRange) || undefined}
              aria-describedby={showValidation && invalidDateRange ? `${validationId}-dates` : undefined}
            />
          </label>
          {showValidation && invalidDateRange && (
            <p id={`${validationId}-dates`} className="text-xs text-alarm sm:col-span-2">
              {t('an.invalidDateRange')}
            </p>
          )}
          <label className="space-y-1.5 text-xs font-medium text-muted sm:col-span-2">
            <span>{t('an.evaluationWindow')}</span>
            <input
              type="number"
              min={1}
              max={60}
              className={fieldCls}
              value={draft.evaluationWindowDays}
              onChange={(event) => setDraft({ ...draft, evaluationWindowDays: event.target.value })}
              aria-invalid={(showValidation && invalidWindow) || undefined}
              aria-describedby={`${validationId}-window-hint${showValidation && invalidWindow ? ` ${validationId}-window-error` : ''}`}
            />
            <span id={`${validationId}-window-hint`} className="block font-normal t-hint">
              {t('an.evaluationWindowHint')}
            </span>
            {showValidation && invalidWindow && (
              <span id={`${validationId}-window-error`} className="block font-normal text-alarm">
                {t('an.invalidEvaluationWindow')}
              </span>
            )}
          </label>
        </div>

        <section className="rounded-[12px] bg-surface-2 p-3">
          <h3 className="text-sm font-semibold text-text">{t('an.economics')}</h3>
          <p className="mt-1 t-hint text-pretty">{t('an.economicsHint')}</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_96px]">
            <label className="space-y-1.5 text-xs font-medium text-muted">
              <span>{t('an.budget')}</span>
              <input
                inputMode="decimal"
                className={fieldCls}
                value={draft.budget}
                onChange={(event) => setDraft({ ...draft, budget: event.target.value })}
                aria-invalid={(showValidation && invalidBudget) || undefined}
                aria-describedby={showValidation && invalidBudget ? `${validationId}-money` : undefined}
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium text-muted">
              <span>{t('an.spend')}</span>
              <input
                inputMode="decimal"
                className={fieldCls}
                value={draft.spend}
                onChange={(event) => setDraft({ ...draft, spend: event.target.value })}
                aria-invalid={(showValidation && invalidSpend) || undefined}
                aria-describedby={showValidation && invalidSpend ? `${validationId}-money` : undefined}
              />
            </label>
            <label className="space-y-1.5 text-xs font-medium text-muted">
              <span>{t('an.currency')}</span>
              <input
                maxLength={3}
                className={cn(fieldCls, 'uppercase')}
                value={draft.currency}
                onChange={(event) => setDraft({ ...draft, currency: event.target.value.toUpperCase() })}
                aria-invalid={(showValidation && invalidCurrency) || undefined}
                aria-describedby={showValidation && invalidCurrency ? `${validationId}-currency` : undefined}
              />
              {showValidation && invalidCurrency && (
                <span id={`${validationId}-currency`} className="block font-normal text-alarm">
                  {t('an.invalidCurrency')}
                </span>
              )}
            </label>
          </div>
          {showValidation && invalidMoney && (
            <p id={`${validationId}-money`} className="mt-2 text-xs text-alarm">
              {t('an.invalidMoney')}
            </p>
          )}
        </section>

        <section
          tabIndex={-1}
          aria-invalid={(showValidation && selectedTouchpoints.length === 0) || undefined}
          aria-describedby={
            showValidation && selectedTouchpoints.length === 0 ? `${validationId}-touchpoints` : undefined
          }
          className="outline-none"
        >
          <h3 className="text-sm font-semibold text-text">{t('an.touchpoints')}</h3>
          <p className="mt-1 t-hint text-pretty">{t('an.touchpointsHint')}</p>
          <div className="mt-3 max-h-64 space-y-1 overflow-auto rounded-[12px] bg-surface-2 p-2">
            {options.map((option) => {
              const assignedElsewhere = Boolean(option.assignedTo && option.assignedTo !== plan?.id)
              const label = [option.source || t('an.unmarked'), option.campaign, option.content, option.term]
                .filter(Boolean)
                .join(' · ')
              return (
                <label
                  key={option.key}
                  className={cn(
                    'flex min-h-10 items-center gap-3 rounded-[9px] px-2 py-1.5 text-sm transition-[background-color,opacity] duration-150 ease-out',
                    assignedElsewhere ? 'cursor-not-allowed opacity-45' : 'cursor-pointer hover:bg-surface',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={selectedKeys.has(option.key)}
                    disabled={assignedElsewhere}
                    onChange={(event) => {
                      const next = new Set(selectedKeys)
                      if (event.target.checked) next.add(option.key)
                      else next.delete(option.key)
                      setSelectedKeys(next)
                    }}
                  />
                  <span className="min-w-0 flex-1 truncate text-text" title={label}>
                    {label}
                  </span>
                  {assignedElsewhere && <span className="max-w-28 truncate t-hint">{option.assignedName}</span>}
                </label>
              )
            })}
          </div>
          <p className="nums mt-2 text-xs text-muted">
            {t('an.touchpointsSelected', { n: selectedTouchpoints.length })}
          </p>
          {showValidation && selectedTouchpoints.length === 0 && (
            <p id={`${validationId}-touchpoints`} className="mt-1 text-xs text-alarm">
              {t('an.selectTouchpoint')}
            </p>
          )}
        </section>

        <label className="space-y-1.5 text-xs font-medium text-muted">
          <span>{t('an.notes')}</span>
          <textarea
            className={cn(fieldCls, 'min-h-24 resize-y py-2')}
            value={draft.notes}
            onChange={(event) => setDraft({ ...draft, notes: event.target.value })}
          />
        </label>

        <div className="sticky bottom-0 -mx-4 -mb-4 flex justify-end gap-2 border-t border-border bg-surface px-4 py-3">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="button" size="sm" onClick={submit} disabled={save.isPending}>
            {save.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </div>
    </DetailDrawer>
  )
}

type CampaignHighlightItem = {
  kind: 'scale_winner' | 'efficient_candidate' | 'tracking_gap'
  campaignKey: string
  source: string
  campaign: string
  content: string
  wishlists: number
  trustedVisits: number
  trackedVisits: number
  trackedCoverage: number | null
  conversion: number | null
  confidence: 'high' | 'medium' | 'low'
}

function CampaignHighlightCard({
  item,
  priority,
  onOpen,
}: {
  item: CampaignHighlightItem
  priority: number
  onOpen: () => void
}) {
  const t = useT()
  const Icon = item.kind === 'scale_winner' ? BadgeCheck : item.kind === 'efficient_candidate' ? Gauge : TriangleAlert
  const tone = item.kind === 'tracking_gap' ? 'text-warning bg-warning/10' : 'text-success bg-success/10'
  const label = [item.source || t('an.unmarked'), item.campaign, item.content].filter(Boolean).join(' · ')
  const remainingTracked = Math.max(0, 30 - item.trackedVisits)
  const trackingGap = Math.max(0, item.trustedVisits - item.trackedVisits)
  const actionKey =
    item.kind === 'efficient_candidate' && remainingTracked === 0
      ? 'an.highlight.efficient_candidate.action_mature'
      : `an.highlight.${item.kind}.action`
  return (
    <article className="rounded-[16px] bg-surface p-4 shadow-hard">
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(300px,1fr)]">
        <div className="min-w-0">
          <div className="flex items-start gap-3">
            <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px]', tone)}>
              <Icon className="h-5 w-5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="nums rounded-full bg-surface-2 px-2 py-1 text-xs font-semibold text-text">
                  {t('an.highlightPriority', { n: priority })}
                </span>
                <h3 className="t-section text-balance">{t(`an.highlight.${item.kind}.title`)}</h3>
                <span className="rounded-full bg-surface-2 px-2 py-1 t-hint">
                  {t(`an.confidence.${item.confidence}`)}
                </span>
              </div>
              <p className="mt-1 break-words text-sm font-medium text-text text-pretty">{label}</p>
            </div>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2">
            <AnalyticsValue label={t('an.wishlists')} value={item.wishlists.toLocaleString()} numeric emphasis />
            <AnalyticsValue label={t('an.conversion')} value={pct(item.conversion)} numeric />
            <AnalyticsValue label={t('an.trackedCoverage')} value={pct(item.trackedCoverage)} numeric />
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-1">
          <div className="rounded-[12px] bg-surface-2 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">{t('an.whyThisDecision')}</p>
            <p className="mt-1 text-sm text-text text-pretty">
              {t(`an.highlight.${item.kind}.body`, {
                wishlists: item.wishlists,
                tracked: item.trackedVisits,
                trusted: item.trustedVisits,
                conversion: pct(item.conversion),
                coverage: pct(item.trackedCoverage),
                remaining: remainingTracked,
                gap: trackingGap,
              })}
            </p>
          </div>
          <div className="rounded-[12px] bg-surface-2 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted">{t('an.nextCheck')}</p>
            <p className="mt-1 text-sm font-medium text-text text-pretty">
              {t(actionKey, {
                remaining: remainingTracked,
                gap: trackingGap,
              })}
            </p>
            <Button type="button" variant="ghost" size="sm" className="mt-2 -ml-3 text-accent" onClick={onOpen}>
              {t('an.openCampaignData')}
            </Button>
          </div>
        </div>
      </div>
    </article>
  )
}

type DataQuality = {
  sourceKind: string | null
  timezone: string | null
  maturity: 'maturing' | 'mature' | 'unknown'
  latestCompleteDate: string | null
  reconciliation: {
    status: 'matched' | 'mismatch' | 'not_comparable' | 'missing'
    sameScope: boolean
    deltas: { visits: number; trustedVisits: number; trackedVisits: number; wishlists: number }
  }
  warningCount: number
}

function DataQualityPanel({
  quality,
  source,
}: {
  quality?: DataQuality
  source?: { filename: string | null; importedAt: string; warnings: string[] } | null
}) {
  const t = useT()
  const reconciliationTone =
    quality?.reconciliation.status === 'matched'
      ? 'success'
      : quality?.reconciliation.status === 'mismatch'
        ? 'alarm'
        : 'warning'
  return (
    <section className="space-y-3" aria-label={t('an.dataQualityTitle')}>
      <div>
        <h2 className="t-section text-balance">{t('an.dataQualityTitle')}</h2>
        <p className="mt-0.5 t-hint text-pretty">{t('an.dataQualitySubtitle')}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <QualityCard
          icon={RefreshCw}
          label={t('an.qualitySource')}
          value={source?.filename ?? t('an.qualityMissing')}
          note={quality?.sourceKind ? `${quality.sourceKind} · ${quality.timezone}` : t('an.importUtmHint')}
          tone={source ? 'success' : 'warning'}
        />
        <QualityCard
          icon={ShieldCheck}
          label={t('an.qualityMaturity')}
          value={t(`an.maturity.${quality?.maturity ?? 'unknown'}`)}
          note={
            quality?.latestCompleteDate ? t('an.completeThrough', { date: quality.latestCompleteDate }) : t('an.noUtm')
          }
          tone={quality?.maturity === 'mature' ? 'success' : 'warning'}
        />
        <QualityCard
          icon={BadgeCheck}
          label={t('an.qualityReconciliation')}
          value={t(`an.reconciliation.${quality?.reconciliation.status ?? 'missing'}`)}
          note={
            quality?.reconciliation.status === 'mismatch'
              ? t('an.reconciliationDelta', { n: quality.reconciliation.deltas.wishlists })
              : t('an.reconciliationHint')
          }
          tone={reconciliationTone}
        />
        <QualityCard
          icon={TriangleAlert}
          label={t('an.qualityWarnings')}
          value={(quality?.warningCount ?? 0).toLocaleString()}
          note={source?.warnings?.[0] ?? t('an.noParserWarnings')}
          tone={(quality?.warningCount ?? 0) > 0 ? 'warning' : 'success'}
        />
      </div>
    </section>
  )
}

function QualityCard({
  icon: Icon,
  label,
  value,
  note,
  tone,
}: {
  icon: typeof ShieldCheck
  label: string
  value: string
  note: string
  tone: 'success' | 'warning' | 'alarm'
}) {
  const toneClass = {
    success: 'bg-success/10 text-success',
    warning: 'bg-warning/10 text-warning',
    alarm: 'bg-alarm/10 text-alarm',
  }[tone]
  return (
    <article className="rounded-[16px] bg-surface p-4 shadow-hard">
      <div className="flex items-start gap-3">
        <span className={cn('flex h-10 w-10 shrink-0 items-center justify-center rounded-[12px]', toneClass)}>
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="t-hint text-pretty">{label}</p>
          <p className="nums mt-1 truncate text-sm font-medium text-text" title={value}>
            {value}
          </p>
        </div>
      </div>
      <p className="mt-3 line-clamp-2 t-hint text-pretty" title={note}>
        {note}
      </p>
    </article>
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
      <div className="mt-2 t-metric">{value}</div>
      <div className="mt-1 truncate t-hint" title={note}>
        {note}
      </div>
    </div>
  )
}

function EmptyState({ text }: { text: string }) {
  return <div className="rounded-[12px] bg-surface-2 px-4 py-8 text-center text-sm text-muted">{text}</div>
}

function AnalyticsValue({
  label,
  value,
  numeric,
  emphasis,
}: {
  label: string
  value: string
  numeric?: boolean
  emphasis?: boolean
}) {
  return (
    <div className="min-w-0 rounded-[10px] bg-surface-2 px-3 py-2">
      <p className="truncate t-hint" title={label}>
        {label}
      </p>
      <p
        className={cn('mt-0.5 truncate text-sm font-medium text-text', numeric && 'nums', emphasis && 'text-accent')}
        title={value}
      >
        {value}
      </p>
    </div>
  )
}

function CollapsibleSection({
  title,
  subtitle,
  count,
  meta,
  collapsed,
  onToggle,
  children,
}: {
  title: string
  subtitle: string
  count: number
  meta?: string
  collapsed: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <section className="overflow-hidden rounded-[16px] bg-surface shadow-hard">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="tap flex min-h-16 w-full items-center gap-3 px-4 py-3 text-left hover:bg-surface-2/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
      >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="t-section text-balance">{title}</span>
            <span className="nums inline-flex min-w-6 items-center justify-center rounded-full bg-surface-2 px-2 py-0.5 t-hint text-text">
              {count}
            </span>
          </span>
          <span className="mt-0.5 block t-hint text-pretty">{subtitle}</span>
          {meta && <span className="mt-1 block truncate t-hint text-info">{meta}</span>}
        </span>
        <ChevronDown
          className={cn(
            'h-5 w-5 shrink-0 text-muted transition-transform duration-200 ease-out',
            collapsed && '-rotate-90',
          )}
          aria-hidden
        />
      </button>
      {!collapsed && <div className="border-t border-border">{children}</div>}
    </section>
  )
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
