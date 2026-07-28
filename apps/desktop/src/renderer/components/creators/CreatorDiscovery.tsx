import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  CircleCheck,
  Clock3,
  ExternalLink,
  Gauge,
  KeyRound,
  Loader2,
  Mail,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  Square,
  Trash2,
  X,
  Youtube,
} from 'lucide-react'
import { trpc } from '@/lib/trpc'
import { cn, fieldCls } from '@/lib/utils'
import { useUi } from '@/store/ui'
import { toast } from '@/store/toast'
import { Button } from '@/components/ui/Button'
import { LoadingState, QueryError } from '@/components/ui/QueryState'
import { useT } from '@/i18n/useT'

type ProfileMode = 'games' | 'topic'

type ProfileForm = {
  name: string
  mode: ProfileMode
  references: string
  languages: string
  includeTerms: string
  excludeTerms: string
  seedChannels: string
  maxSearchRequests: number
  maxChannels: number
  recentVideoLimit: number
  discoverContacts: boolean
}

const emptyForm: ProfileForm = {
  name: '',
  mode: 'games',
  references: '',
  languages: '',
  includeTerms: '',
  excludeTerms: '',
  seedChannels: '',
  maxSearchRequests: 10,
  maxChannels: 500,
  recentVideoLimit: 50,
  discoverContacts: true,
}

function listFromText(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,;]+/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ]
}

function referencesFromText(value: string) {
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [label = '', aliases = '', queries = ''] = line.split('|').map((part) => part.trim())
      return {
        label,
        aliases: listFromText(aliases),
        queryTerms: listFromText(queries || label),
        weight: 1,
      }
    })
    .filter((reference) => reference.label)
}

function compact(value: number | null | undefined): string {
  if (value == null) return '—'
  return new Intl.NumberFormat(undefined, {
    notation: value >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(value)
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : value
}

function runTone(status: string): string {
  if (status === 'completed') return 'bg-success/10 text-success'
  if (status === 'running') return 'bg-info/10 text-info'
  if (status === 'queued' || status === 'paused') return 'bg-warning/10 text-warning'
  if (status === 'waiting_for_quota' || status === 'partial') return 'bg-accent/10 text-accent'
  if (status === 'failed' || status === 'cancelled') return 'bg-alarm/10 text-alarm'
  return 'bg-surface-2 text-muted'
}

function QuotaMeter({
  label,
  used,
  limit,
  remaining,
  remainingLabel,
}: {
  label: string
  used: number
  limit: number
  remaining: number
  remainingLabel: string
}) {
  const percent = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0
  return (
    <div className="rounded-[calc(var(--radius)+4px)] bg-bg p-3 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="t-hint">{label}</span>
        <strong className="tabular-nums text-sm">
          {remaining} {remainingLabel}
        </strong>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-2">
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="mt-1.5 text-right text-[11px] text-muted tabular-nums">
        {used} / {limit}
      </div>
    </div>
  )
}

export function CreatorDiscovery({ gameId }: { gameId: string }) {
  const t = useT()
  const qc = useQueryClient()
  const sectionKey = `creator-discovery:${gameId}`
  const sectionState = useUi((state) => state.sectionViewStates?.[sectionKey] ?? {})
  const setSectionState = useUi((state) => state.setSectionViewState)
  const selectedProfileId = typeof sectionState.profileId === 'string' ? sectionState.profileId : null
  const selectedRunId = typeof sectionState.runId === 'string' ? sectionState.runId : null
  const minFit = typeof sectionState.minFit === 'number' ? sectionState.minFit : 0
  const candidateStatus =
    sectionState.candidateStatus === 'promoted' || sectionState.candidateStatus === 'dismissed'
      ? sectionState.candidateStatus
      : 'staged'
  const formOpen = sectionState.formOpen === true
  const [form, setForm] = useState<ProfileForm>(emptyForm)
  const [youtubeKey, setYoutubeKey] = useState('')

  const profiles = useQuery({
    queryKey: ['creator-discovery-profiles', gameId],
    queryFn: () => trpc.creatorDiscovery.profiles.query({ gameId }),
  })
  const runs = useQuery({
    queryKey: ['creator-discovery-runs', gameId],
    queryFn: () => trpc.creatorDiscovery.runs.query({ gameId, limit: 50 }),
    refetchInterval: 3_000,
  })
  const quota = useQuery({
    queryKey: ['creator-discovery-quota'],
    queryFn: () => trpc.creatorDiscovery.quota.query(),
    refetchInterval: 5_000,
  })
  const candidates = useQuery({
    queryKey: ['creator-discovery-candidates', selectedRunId, candidateStatus, minFit],
    queryFn: () =>
      trpc.creatorDiscovery.candidates.query({
        runId: selectedRunId!,
        status: candidateStatus,
        minFit,
        limit: 1_000,
      }),
    enabled: !!selectedRunId,
    refetchInterval: 3_000,
  })

  useEffect(() => {
    if (!selectedProfileId && profiles.data?.[0]) {
      setSectionState(sectionKey, { profileId: profiles.data[0].id })
    }
  }, [profiles.data, sectionKey, selectedProfileId, setSectionState])

  useEffect(() => {
    const matchingRun = runs.data?.find((run) => !selectedProfileId || run.profileId === selectedProfileId)
    if (!selectedRunId && matchingRun) setSectionState(sectionKey, { runId: matchingRun.id })
  }, [runs.data, sectionKey, selectedProfileId, selectedRunId, setSectionState])

  const selectedRun = runs.data?.find((run) => run.id === selectedRunId) ?? null
  const profileRuns = useMemo(
    () => (runs.data ?? []).filter((run) => !selectedProfileId || run.profileId === selectedProfileId),
    [runs.data, selectedProfileId],
  )

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['creator-discovery-profiles', gameId] })
    qc.invalidateQueries({ queryKey: ['creator-discovery-runs', gameId] })
    qc.invalidateQueries({ queryKey: ['creator-discovery-quota'] })
    qc.invalidateQueries({ queryKey: ['creator-discovery-candidates'] })
    qc.invalidateQueries({ queryKey: ['connector-keys'] })
  }

  const saveYoutubeKey = useMutation({
    mutationFn: () => trpc.sources.setApiKey.mutate({ provider: 'youtube', key: youtubeKey.trim() }),
    onSuccess: () => {
      setYoutubeKey('')
      invalidate()
      toast.success(t('discovery.keySaved'))
    },
    onError: toast.fromError,
  })

  const createProfile = useMutation({
    mutationFn: () =>
      trpc.creatorDiscovery.createProfile.mutate({
        gameId,
        name: form.name.trim(),
        mode: form.mode,
        languages: listFromText(form.languages),
        includeTerms: listFromText(form.includeTerms),
        excludeTerms: listFromText(form.excludeTerms),
        seedChannels: listFromText(form.seedChannels),
        maxSearchRequests: form.maxSearchRequests,
        maxChannels: form.maxChannels,
        recentVideoLimit: form.recentVideoLimit,
        discoverContacts: form.discoverContacts,
        references: referencesFromText(form.references),
      }),
    onSuccess: (result) => {
      setForm(emptyForm)
      setSectionState(sectionKey, { profileId: result.id, formOpen: false })
      invalidate()
      toast.success(t('discovery.profileCreated'))
    },
    onError: toast.fromError,
  })
  const removeProfile = useMutation({
    mutationFn: (id: string) => trpc.creatorDiscovery.removeProfile.mutate({ id }),
    onSuccess: () => {
      setSectionState(sectionKey, { profileId: null })
      invalidate()
    },
    onError: toast.fromError,
  })
  const start = useMutation({
    mutationFn: (forceNew: boolean) => trpc.creatorDiscovery.start.mutate({ profileId: selectedProfileId!, forceNew }),
    onSuccess: (result) => {
      setSectionState(sectionKey, { runId: result.run.id })
      invalidate()
      toast.success(result.duplicate ? t('discovery.duplicateReused') : t('discovery.runQueued'))
    },
    onError: toast.fromError,
  })
  const pause = useMutation({
    mutationFn: (id: string) => trpc.creatorDiscovery.pause.mutate({ id }),
    onSuccess: invalidate,
    onError: toast.fromError,
  })
  const resume = useMutation({
    mutationFn: (id: string) => trpc.creatorDiscovery.resume.mutate({ id }),
    onSuccess: invalidate,
    onError: toast.fromError,
  })
  const cancel = useMutation({
    mutationFn: (id: string) => trpc.creatorDiscovery.cancel.mutate({ id }),
    onSuccess: invalidate,
    onError: toast.fromError,
  })
  const promote = useMutation({
    mutationFn: (candidateId: string) => trpc.creatorDiscovery.promote.mutate({ runId: selectedRunId!, candidateId }),
    onSuccess: () => {
      invalidate()
      qc.invalidateQueries({ queryKey: ['creators'] })
      qc.invalidateQueries({ queryKey: ['creator-picks', gameId] })
      toast.success(t('discovery.promoted'))
    },
    onError: toast.fromError,
  })
  const dismiss = useMutation({
    mutationFn: (candidateId: string) => trpc.creatorDiscovery.dismiss.mutate({ runId: selectedRunId!, candidateId }),
    onSuccess: invalidate,
    onError: toast.fromError,
  })

  if (profiles.isLoading || runs.isLoading || quota.isLoading) return <LoadingState />
  if (profiles.error || runs.error || quota.error) {
    return <QueryError error={profiles.error ?? runs.error ?? quota.error} onRetry={invalidate} />
  }

  const references = referencesFromText(form.references)
  const progress = selectedRun
    ? selectedRun.status === 'completed'
      ? 100
      : Math.round((selectedRun.channelsScanned / Math.max(1, selectedRun.channelsFound)) * 100)
    : 0
  const hasProfile = !!profiles.data?.length
  const needsSetup = !quota.data?.configured || !hasProfile

  return (
    <div className="space-y-5">
      {needsSetup && (
        <section className="rounded-[calc(var(--radius)+8px)] bg-surface p-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_2px_4px_rgba(0,0,0,0.04)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius)] bg-alarm/10 text-alarm">
              <Youtube className="h-5 w-5" aria-hidden />
            </div>
            <div className="min-w-0">
              <h2 className="text-balance text-lg font-semibold">{t('discovery.setupTitle')}</h2>
              <p className="mt-1 max-w-3xl text-pretty text-sm text-muted">{t('discovery.setupSubtitle')}</p>
            </div>
          </div>

          <div className="mt-5 grid gap-3 lg:grid-cols-2">
            <div className="rounded-[calc(var(--radius)+4px)] bg-bg p-4 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
              <div className="flex items-center gap-2">
                {quota.data?.configured ? (
                  <CircleCheck className="h-5 w-5 text-success" aria-hidden />
                ) : (
                  <KeyRound className="h-5 w-5 text-warning" aria-hidden />
                )}
                <h3 className="text-balance font-semibold">{t('discovery.setupKeyTitle')}</h3>
              </div>
              {quota.data?.configured ? (
                <p className="mt-2 text-pretty text-sm text-success">{t('discovery.setupKeyReady')}</p>
              ) : (
                <>
                  <ol className="mt-2 list-decimal space-y-1 pl-5 text-pretty text-xs leading-relaxed text-muted">
                    <li>{t('discovery.setupKeyStep1')}</li>
                    <li>{t('discovery.setupKeyStep2')}</li>
                    <li>{t('discovery.setupKeyStep3')}</li>
                  </ol>
                  <a
                    href="https://console.cloud.google.com/apis/library/youtube.googleapis.com"
                    target="_blank"
                    rel="noreferrer"
                    className="mt-3 inline-flex min-h-10 items-center gap-1.5 text-sm text-accent hover:underline"
                  >
                    {t('discovery.openGoogleCloud')}
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  </a>
                  <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                    <input
                      type="password"
                      value={youtubeKey}
                      onChange={(event) => setYoutubeKey(event.target.value)}
                      placeholder={t('discovery.apiKeyPlaceholder')}
                      autoComplete="off"
                      spellCheck={false}
                      className={fieldCls}
                    />
                    <Button
                      size="sm"
                      onClick={() => saveYoutubeKey.mutate()}
                      disabled={!youtubeKey.trim() || saveYoutubeKey.isPending}
                    >
                      {saveYoutubeKey.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                      {t('set.save')}
                    </Button>
                  </div>
                  <p className="mt-2 text-pretty text-[11px] leading-relaxed text-muted">
                    {t('discovery.setupKeyPrivacy')}
                  </p>
                </>
              )}
            </div>

            <div className="rounded-[calc(var(--radius)+4px)] bg-bg p-4 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
              <div className="flex items-center gap-2">
                {hasProfile ? (
                  <CircleCheck className="h-5 w-5 text-success" aria-hidden />
                ) : (
                  <Search className="h-5 w-5 text-warning" aria-hidden />
                )}
                <h3 className="text-balance font-semibold">{t('discovery.setupProfileTitle')}</h3>
              </div>
              <p className={cn('mt-2 text-pretty text-sm', hasProfile ? 'text-success' : 'text-muted')}>
                {t(hasProfile ? 'discovery.setupProfileReady' : 'discovery.setupProfileMissing')}
              </p>
              <p className="mt-2 text-pretty text-[11px] leading-relaxed text-muted">
                {t('discovery.setupProfileLocation')}
              </p>
            </div>
          </div>
        </section>
      )}

      {!needsSetup && (
        <section className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="rounded-[calc(var(--radius)+8px)] bg-surface p-4 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_2px_4px_rgba(0,0,0,0.04)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2">
                  <Youtube className="h-5 w-5 text-alarm" aria-hidden />
                  <h2 className="text-balance text-lg font-semibold">{t('discovery.title')}</h2>
                </div>
                <p className="mt-1 max-w-2xl text-pretty text-sm text-muted">{t('discovery.subtitle')}</p>
              </div>
              <Button size="sm" variant="outline" onClick={() => setSectionState(sectionKey, { formOpen: !formOpen })}>
                <Plus className="h-4 w-4" />
                {t('discovery.newProfile')}
              </Button>
            </div>

            {profiles.data?.length ? (
              <div className="mt-4 flex flex-wrap items-end gap-2">
                <label className="min-w-64 flex-1 t-hint">
                  {t('discovery.profile')}
                  <select
                    value={selectedProfileId ?? ''}
                    onChange={(event) => setSectionState(sectionKey, { profileId: event.target.value, runId: null })}
                    className={cn(fieldCls, 'mt-1')}
                  >
                    {profiles.data.map((profile) =>
                      profile ? (
                        <option key={profile.id} value={profile.id}>
                          {profile.name} · {profile.references.length} {t('discovery.referencesShort')}
                        </option>
                      ) : null,
                    )}
                  </select>
                </label>
                <Button
                  size="sm"
                  onClick={() => start.mutate(false)}
                  disabled={!selectedProfileId || !quota.data?.configured || start.isPending}
                >
                  {start.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                  {t('discovery.start')}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  title={t('discovery.deleteProfile')}
                  aria-label={t('discovery.deleteProfile')}
                  onClick={() => selectedProfileId && removeProfile.mutate(selectedProfileId)}
                  disabled={!selectedProfileId || removeProfile.isPending}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ) : (
              <div className="mt-4 rounded-[var(--radius)] bg-bg p-4 text-pretty text-sm text-muted">
                {t('discovery.emptyProfiles')}
              </div>
            )}
          </div>

          <aside className="rounded-[calc(var(--radius)+8px)] bg-surface p-4 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_2px_4px_rgba(0,0,0,0.04)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
            <div className="flex items-center gap-2">
              <Gauge className="h-4 w-4 text-accent" aria-hidden />
              <h2 className="text-balance font-semibold">{t('discovery.quotaToday')}</h2>
            </div>
            {quota.data?.configured ? (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <QuotaMeter
                  label={t('discovery.quotaSearch')}
                  remainingLabel={t('discovery.remaining')}
                  {...quota.data.search}
                />
                <QuotaMeter
                  label={t('discovery.quotaData')}
                  remainingLabel={t('discovery.remaining')}
                  {...quota.data.data}
                />
              </div>
            ) : (
              <p className="mt-3 text-pretty text-sm text-warning">{t('discovery.keyMissing')}</p>
            )}
            <p className="mt-2 text-pretty text-[11px] text-muted">{t('discovery.quotaHint')}</p>
          </aside>
        </section>
      )}

      {(formOpen || !hasProfile) && (
        <section className="rounded-[calc(var(--radius)+8px)] bg-surface p-4 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_2px_4px_rgba(0,0,0,0.04)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
          <div className="grid gap-3 md:grid-cols-2">
            <label className="t-hint">
              {t('discovery.profileName')}
              <input
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                className={cn(fieldCls, 'mt-1')}
              />
            </label>
            <label className="t-hint">
              {t('discovery.mode')}
              <select
                value={form.mode}
                onChange={(event) => setForm({ ...form, mode: event.target.value as ProfileMode })}
                className={cn(fieldCls, 'mt-1')}
              >
                <option value="games">{t('discovery.modeGames')}</option>
                <option value="topic">{t('discovery.modeTopic')}</option>
              </select>
            </label>
            <label className="t-hint md:col-span-2">
              {t(form.mode === 'topic' ? 'discovery.topicFacets' : 'discovery.references')}
              <textarea
                value={form.references}
                onChange={(event) => setForm({ ...form, references: event.target.value })}
                rows={5}
                placeholder={t(form.mode === 'topic' ? 'discovery.topicFacetsHint' : 'discovery.referencesHint')}
                className={cn(fieldCls, 'mt-1 resize-y')}
              />
              <span className="mt-1 block text-[11px] text-muted tabular-nums">
                {references.length} {t('discovery.referencesShort')}
              </span>
              {form.mode === 'topic' && (
                <span className="mt-1 block text-pretty text-[11px] leading-relaxed text-muted">
                  {t('discovery.topicFacetsExplain')}
                </span>
              )}
            </label>
            <label className="t-hint">
              {t('discovery.languages')}
              <input
                value={form.languages}
                onChange={(event) => setForm({ ...form, languages: event.target.value })}
                placeholder="en, ru"
                className={cn(fieldCls, 'mt-1')}
              />
            </label>
            <label className="t-hint">
              {t('discovery.seedChannels')}
              <input
                value={form.seedChannels}
                onChange={(event) => setForm({ ...form, seedChannels: event.target.value })}
                placeholder="UC…"
                className={cn(fieldCls, 'mt-1')}
              />
            </label>
            <label className="t-hint">
              {t('discovery.includeTerms')}
              <input
                value={form.includeTerms}
                onChange={(event) => setForm({ ...form, includeTerms: event.target.value })}
                className={cn(fieldCls, 'mt-1')}
              />
            </label>
            <label className="t-hint">
              {t('discovery.excludeTerms')}
              <input
                value={form.excludeTerms}
                onChange={(event) => setForm({ ...form, excludeTerms: event.target.value })}
                className={cn(fieldCls, 'mt-1')}
              />
            </label>
            <label className="t-hint">
              {t('discovery.searchBudget')}
              <input
                type="number"
                min={1}
                max={100}
                value={form.maxSearchRequests}
                onChange={(event) => setForm({ ...form, maxSearchRequests: Number(event.target.value) })}
                className={cn(fieldCls, 'mt-1 tabular-nums')}
              />
            </label>
            <label className="t-hint">
              {t('discovery.channelLimit')}
              <input
                type="number"
                min={10}
                max={5000}
                value={form.maxChannels}
                onChange={(event) => setForm({ ...form, maxChannels: Number(event.target.value) })}
                className={cn(fieldCls, 'mt-1 tabular-nums')}
              />
            </label>
            <label className="t-hint">
              {t('discovery.videoLimit')}
              <input
                type="number"
                min={10}
                max={100}
                value={form.recentVideoLimit}
                onChange={(event) => setForm({ ...form, recentVideoLimit: Number(event.target.value) })}
                className={cn(fieldCls, 'mt-1 tabular-nums')}
              />
            </label>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <label className="flex min-h-10 items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.discoverContacts}
                onChange={(event) => setForm({ ...form, discoverContacts: event.target.checked })}
                className="h-4 w-4 accent-accent"
              />
              {t('discovery.findContacts')}
            </label>
            <div className="flex gap-2">
              {hasProfile && (
                <Button variant="ghost" size="sm" onClick={() => setSectionState(sectionKey, { formOpen: false })}>
                  {t('common.cancel')}
                </Button>
              )}
              <Button
                size="sm"
                onClick={() => createProfile.mutate()}
                disabled={!form.name.trim() || !references.length || createProfile.isPending}
              >
                {createProfile.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('common.create')}
              </Button>
            </div>
          </div>
        </section>
      )}

      {!needsSetup && (
        <section className="grid min-h-[360px] gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="rounded-[calc(var(--radius)+8px)] bg-surface p-3 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_2px_4px_rgba(0,0,0,0.04)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
            <h2 className="px-1 text-balance font-semibold">{t('discovery.runs')}</h2>
            <div className="mt-2 space-y-1">
              {profileRuns.map((run) => (
                <button
                  key={run.id}
                  onClick={() => setSectionState(sectionKey, { runId: run.id })}
                  className={cn(
                    'min-h-14 w-full rounded-[var(--radius)] px-3 py-2 text-left transition-[background-color,box-shadow,scale] duration-150 ease-out active:scale-[0.96]',
                    selectedRunId === run.id
                      ? 'bg-accent/10 shadow-[inset_0_0_0_1px_rgba(39,194,129,0.35)]'
                      : 'hover:bg-surface-2',
                  )}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm font-medium">{formatDate(run.createdAt)}</span>
                    <span className={cn('rounded-full px-2 py-0.5 text-[10px]', runTone(run.status))}>
                      {t(`discovery.status.${run.status}`)}
                    </span>
                  </span>
                  <span className="mt-1 block text-[11px] text-muted tabular-nums">
                    {run.candidatesStaged} {t('discovery.candidatesShort')} · {run.searchRequestsUsed}{' '}
                    {t('discovery.requestsShort')}
                  </span>
                </button>
              ))}
              {!profileRuns.length && <p className="p-3 text-pretty text-sm text-muted">{t('discovery.emptyRuns')}</p>}
            </div>
          </aside>

          <div className="min-w-0 space-y-3">
            {selectedRun ? (
              <div className="rounded-[calc(var(--radius)+8px)] bg-surface p-4 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_2px_4px_rgba(0,0,0,0.04)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      {selectedRun.status === 'running' && <Loader2 className="h-4 w-4 animate-spin text-info" />}
                      <h2 className="text-balance font-semibold">{t(`discovery.phase.${selectedRun.phase}`)}</h2>
                    </div>
                    <p className="mt-1 text-sm text-muted tabular-nums">
                      {selectedRun.channelsScanned}/{selectedRun.channelsFound} {t('discovery.channels')} ·{' '}
                      {selectedRun.videosScanned} {t('discovery.videos')} · {selectedRun.contactsFound}{' '}
                      {t('discovery.emails')}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    {['queued', 'running', 'waiting_for_quota'].includes(selectedRun.status) && (
                      <Button
                        size="icon"
                        variant="outline"
                        onClick={() => pause.mutate(selectedRun.id)}
                        title={t('discovery.pause')}
                      >
                        <Pause className="h-4 w-4" />
                      </Button>
                    )}
                    {['paused', 'waiting_for_quota', 'failed'].includes(selectedRun.status) && (
                      <Button
                        size="icon"
                        variant="outline"
                        onClick={() => resume.mutate(selectedRun.id)}
                        title={t('discovery.resume')}
                      >
                        <RotateCcw className="h-4 w-4" />
                      </Button>
                    )}
                    {!['completed', 'failed', 'cancelled', 'partial'].includes(selectedRun.status) && (
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => cancel.mutate(selectedRun.id)}
                        title={t('discovery.cancelRun')}
                      >
                        <Square className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </div>
                </div>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-bg">
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
                    style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
                  />
                </div>
                {selectedRun.error && <p className="mt-2 text-pretty text-xs text-alarm">{selectedRun.error}</p>}
              </div>
            ) : (
              <div className="rounded-[calc(var(--radius)+8px)] bg-surface p-8 text-center text-pretty text-sm text-muted shadow-[0_0_0_1px_rgba(0,0,0,0.06)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
                {t('discovery.selectRun')}
              </div>
            )}

            {selectedRun && (
              <div className="rounded-[calc(var(--radius)+8px)] bg-surface p-4 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_2px_4px_rgba(0,0,0,0.04)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Search className="h-4 w-4 text-accent" />
                    <h2 className="text-balance font-semibold">{t('discovery.staging')}</h2>
                    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted tabular-nums">
                      {candidates.data?.length ?? 0}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={candidateStatus}
                      onChange={(event) => setSectionState(sectionKey, { candidateStatus: event.target.value })}
                      className={cn(fieldCls, 'w-auto min-w-32')}
                    >
                      <option value="staged">{t('discovery.filterStaged')}</option>
                      <option value="promoted">{t('discovery.filterPromoted')}</option>
                      <option value="dismissed">{t('discovery.filterDismissed')}</option>
                    </select>
                    <label className="flex items-center gap-2 text-xs text-muted">
                      {t('discovery.minFit')}
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={5}
                        value={minFit}
                        onChange={(event) => setSectionState(sectionKey, { minFit: Number(event.target.value) })}
                      />
                      <span className="w-7 text-right tabular-nums">{minFit}</span>
                    </label>
                  </div>
                </div>

                {candidates.isLoading ? (
                  <LoadingState />
                ) : candidates.error ? (
                  <QueryError error={candidates.error} onRetry={() => candidates.refetch()} />
                ) : candidates.data?.length ? (
                  <div className="mt-3 space-y-2">
                    {candidates.data.map(({ candidate, result, contacts, evidence }) => {
                      const emails = contacts.filter((contact) => contact.type === 'business_email')
                      return (
                        <article
                          key={candidate.id}
                          className="rounded-[calc(var(--radius)+4px)] bg-bg p-3 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06)] transition-[box-shadow] duration-150 ease-out hover:shadow-[0_0_0_1px_rgba(0,0,0,0.09),0_2px_4px_rgba(0,0,0,0.05)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]"
                        >
                          <div className="flex gap-3">
                            {candidate.thumbnailUrl ? (
                              <img
                                src={candidate.thumbnailUrl}
                                alt=""
                                className="h-12 w-12 shrink-0 rounded-[var(--radius)] object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
                              />
                            ) : (
                              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[var(--radius)] bg-surface-2">
                                <Youtube className="h-5 w-5 text-muted" />
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <a
                                    href={candidate.channelUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="inline-flex max-w-full items-center gap-1 font-medium hover:text-accent"
                                  >
                                    <span className="truncate">{candidate.name}</span>
                                    <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                                  </a>
                                  <p className="mt-0.5 text-xs text-muted tabular-nums">
                                    {compact(candidate.subscriberCount)} {t('discovery.subscribers')} ·{' '}
                                    {compact(candidate.avgViews)} {t('discovery.avgViews')}
                                  </p>
                                </div>
                                <span className="rounded-full bg-accent/10 px-2.5 py-1 text-sm font-semibold text-accent tabular-nums">
                                  {result.fitScore}
                                </span>
                              </div>
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {(JSON.parse(result.matchedReferencesJson) as string[]).map((reference) => (
                                  <span
                                    key={reference}
                                    className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-muted"
                                  >
                                    {reference}
                                  </span>
                                ))}
                              </div>
                              <div className="mt-2 grid gap-1 text-xs text-muted sm:grid-cols-3">
                                <span className="flex items-center gap-1 tabular-nums">
                                  <Check className="h-3.5 w-3.5 text-success" /> {result.matchedVideoCount}{' '}
                                  {t('discovery.matches')}
                                </span>
                                <span className="flex items-center gap-1 tabular-nums">
                                  <Clock3 className="h-3.5 w-3.5" /> {formatDate(candidate.latestVideoAt)}
                                </span>
                                <span className="flex items-center gap-1 truncate">
                                  <Mail className="h-3.5 w-3.5" /> {emails[0]?.value ?? t('discovery.noEmail')}
                                </span>
                              </div>
                              {evidence[0] && (
                                <a
                                  href={evidence[0].videoUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-2 block truncate text-xs text-info hover:underline"
                                >
                                  {evidence[0].videoTitle}
                                </a>
                              )}
                            </div>
                            {result.status === 'staged' && (
                              <div className="flex shrink-0 flex-col gap-1">
                                <Button
                                  size="icon"
                                  title={t('discovery.promote')}
                                  aria-label={t('discovery.promote')}
                                  onClick={() => promote.mutate(candidate.id)}
                                  disabled={promote.isPending}
                                >
                                  <Check className="h-4 w-4" />
                                </Button>
                                <Button
                                  size="icon"
                                  variant="ghost"
                                  title={t('discovery.dismiss')}
                                  aria-label={t('discovery.dismiss')}
                                  onClick={() => dismiss.mutate(candidate.id)}
                                  disabled={dismiss.isPending}
                                >
                                  <X className="h-4 w-4" />
                                </Button>
                              </div>
                            )}
                          </div>
                        </article>
                      )
                    })}
                  </div>
                ) : (
                  <p className="mt-4 rounded-[var(--radius)] bg-bg p-6 text-center text-pretty text-sm text-muted">
                    {t('discovery.emptyCandidates')}
                  </p>
                )}
              </div>
            )}
          </div>
        </section>
      )}
    </div>
  )
}
