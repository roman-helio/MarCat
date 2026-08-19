import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Check,
  CircleAlert,
  CircleCheck,
  Clock3,
  ExternalLink,
  EyeOff,
  FolderOpen,
  KeyRound,
  Loader2,
  Mail,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Search,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  UserPlus,
  Youtube,
} from 'lucide-react'
import { trpc } from '@/lib/trpc'
import { cn, fieldCls } from '@/lib/utils'
import { EMPTY_SECTION_VIEW_STATE, useUi } from '@/store/ui'
import { confirm } from '@/store/confirm'
import { toast } from '@/store/toast'
import { Button } from '@/components/ui/Button'
import { DetailDrawer } from '@/components/ui/DetailDrawer'
import { LoadingState, QueryError } from '@/components/ui/QueryState'
import { CARD_STATE_STYLES, CardStateBadge, type CardStateTone } from '@/components/ui/CardState'
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

function runTone(status: string): CardStateTone {
  if (status === 'completed') return 'success'
  if (status === 'running' || status === 'waiting_for_quota') return 'info'
  if (status === 'paused' || status === 'partial') return 'warning'
  if (status === 'failed' || status === 'cancelled') return 'danger'
  return 'neutral'
}

function QuotaBadge({
  label,
  used,
  limit,
  remaining,
}: {
  label: string
  used: number
  limit: number
  remaining: number
}) {
  return (
    <div
      className="flex min-h-10 items-center gap-1.5 rounded-[var(--radius)] bg-bg px-2 shadow-[0_0_0_1px_rgba(0,0,0,0.06)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]"
      title={`${used} / ${limit}`}
    >
      <span className="whitespace-nowrap t-caption text-muted">{label}</span>
      <strong className="whitespace-nowrap text-sm tabular-nums">{remaining}</strong>
    </div>
  )
}

function CreditBadge({ remaining, used }: { remaining: number | null; used: number }) {
  return (
    <div
      className="flex min-h-10 items-center gap-1.5 rounded-[var(--radius)] bg-bg px-2 shadow-[0_0_0_1px_rgba(0,0,0,0.06)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]"
      title={`${used} credits used today`}
    >
      <span className="whitespace-nowrap t-caption text-muted">Social</span>
      <strong className="whitespace-nowrap text-sm tabular-nums">{remaining ?? '—'}</strong>
    </div>
  )
}

function platformLabel(platform: string): string {
  if (platform === 'youtube') return 'YouTube'
  if (platform === 'instagram') return 'Instagram'
  if (platform === 'tiktok') return 'TikTok'
  if (platform === 'twitter') return 'X'
  return platform
}

export function CreatorDiscovery({ gameId }: { gameId: string }) {
  const t = useT()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const sectionKey = `creator-discovery:${gameId}`
  const sectionState = useUi((state) => state.sectionViewStates?.[sectionKey] ?? EMPTY_SECTION_VIEW_STATE)
  const setSectionState = useUi((state) => state.setSectionViewState)
  const selectedProfileId = typeof sectionState.profileId === 'string' ? sectionState.profileId : null
  const selectedRunId = typeof sectionState.runId === 'string' ? sectionState.runId : null
  const minFit = typeof sectionState.minFit === 'number' ? sectionState.minFit : 50
  const minReferenceMatches =
    typeof sectionState.minReferenceMatches === 'number' ? sectionState.minReferenceMatches : 1
  const requireBusinessEmail = sectionState.requireBusinessEmail === true
  const candidateStatus =
    sectionState.candidateStatus === 'promoted' || sectionState.candidateStatus === 'dismissed'
      ? sectionState.candidateStatus
      : 'staged'
  const formOpen = sectionState.formOpen === true
  const setSeedPrompt = useUi((state) => state.setSeedPrompt)
  const [form, setForm] = useState<ProfileForm>(emptyForm)
  const [youtubeKey, setYoutubeKey] = useState('')
  const [socialKey, setSocialKey] = useState('')

  const profiles = useQuery({
    queryKey: ['creator-discovery-profiles', gameId],
    queryFn: () => trpc.creatorDiscovery.profiles.query({ gameId }),
  })
  const runs = useQuery({
    queryKey: ['creator-discovery-runs', gameId],
    queryFn: () =>
      trpc.creatorDiscovery.runs.query({
        gameId,
        limit: 5_000,
      }),
    refetchInterval: 3_000,
  })
  const archiveLocation = useQuery({
    queryKey: ['creator-discovery-archive-location', gameId],
    queryFn: () => trpc.creatorDiscovery.archiveLocation.query({ gameId }),
    refetchInterval: 30_000,
  })
  const quota = useQuery({
    queryKey: ['creator-discovery-quota'],
    queryFn: () => trpc.creatorDiscovery.quota.query(),
    refetchInterval: 5_000,
  })
  const candidates = useQuery({
    queryKey: [
      'creator-discovery-candidates',
      selectedRunId,
      candidateStatus,
      minFit,
      minReferenceMatches,
      requireBusinessEmail,
    ],
    queryFn: () =>
      trpc.creatorDiscovery.candidates.query({
        runId: selectedRunId!,
        status: candidateStatus,
        minFit,
        minReferenceMatches,
        requireBusinessEmail,
        limit: 1_000,
      }),
    enabled: !!selectedRunId,
    refetchInterval: 3_000,
  })
  const selectionPreview = useQuery({
    queryKey: ['creator-discovery-selection', selectedRunId, minFit, minReferenceMatches, requireBusinessEmail],
    queryFn: () =>
      trpc.creatorDiscovery.reviewPreview.query({
        runId: selectedRunId!,
        minFit,
        minReferenceMatches,
        requireBusinessEmail,
        batchLimit: 1_000,
      }),
    enabled: !!selectedRunId && candidateStatus === 'staged',
    refetchInterval: 3_000,
  })
  const promotionOperations = useQuery({
    queryKey: ['creator-promotion-operations', gameId, selectedRunId],
    queryFn: () =>
      trpc.creatorDiscovery.promotionOperations.query({
        gameId,
        runId: selectedRunId!,
        limit: 50,
      }),
    enabled: !!selectedRunId,
    refetchInterval: 1_000,
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
  const selectedProfile = profiles.data?.find((profile) => profile?.id === selectedProfileId) ?? null
  const profileById = useMemo(
    () => new Map((profiles.data ?? []).filter(Boolean).map((profile) => [profile!.id, profile!])),
    [profiles.data],
  )
  const activeProfile = selectedRun ? (profileById.get(selectedRun.profileId) ?? selectedProfile) : selectedProfile
  const trackedPromotionId =
    typeof sectionState.trackedPromotionOperationId === 'string' ? sectionState.trackedPromotionOperationId : null
  const trackedPromotion = promotionOperations.data?.find((operation) => operation.id === trackedPromotionId) ?? null
  const activePromotion =
    promotionOperations.data?.find((operation) => ['queued', 'running'].includes(operation.status)) ?? null
  const latestPromotion = activePromotion ?? trackedPromotion ?? promotionOperations.data?.[0] ?? null

  useEffect(() => {
    if (selectedRun && selectedRun.profileId !== selectedProfileId) {
      setSectionState(sectionKey, { profileId: selectedRun.profileId })
    }
  }, [sectionKey, selectedProfileId, selectedRun, setSectionState])

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['creator-discovery-profiles', gameId] })
    qc.invalidateQueries({ queryKey: ['creator-discovery-runs', gameId] })
    qc.invalidateQueries({ queryKey: ['creator-discovery-quota'] })
    qc.invalidateQueries({ queryKey: ['creator-discovery-candidates'] })
    qc.invalidateQueries({ queryKey: ['creator-discovery-selection'] })
    qc.invalidateQueries({ queryKey: ['creator-promotion-operations'] })
    qc.invalidateQueries({ queryKey: ['connector-keys'] })
  }, [gameId, qc])

  const saveYoutubeKey = useMutation({
    mutationFn: () => trpc.sources.setApiKey.mutate({ provider: 'youtube', key: youtubeKey.trim() }),
    onSuccess: () => {
      setYoutubeKey('')
      invalidate()
      toast.success(t('discovery.keySaved'))
    },
    onError: toast.fromError,
  })
  const saveSocialKey = useMutation({
    mutationFn: () => trpc.sources.setApiKey.mutate({ provider: 'scrapecreators', key: socialKey.trim() }),
    onSuccess: () => {
      setSocialKey('')
      invalidate()
      toast.success(t('discovery.socialKeySaved'))
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
      setSectionState(sectionKey, { profileId: result.id, runId: null, formOpen: false })
      invalidate()
      toast.success(t('discovery.profileCreated'))
    },
    onError: toast.fromError,
  })
  const removeProfile = useMutation({
    mutationFn: (id: string) => trpc.creatorDiscovery.removeProfile.mutate({ id }),
    onSuccess: () => {
      setSectionState(sectionKey, { profileId: null, runId: null })
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
    onSuccess: (result) => {
      invalidate()
      qc.invalidateQueries({ queryKey: ['creators'] })
      qc.invalidateQueries({ queryKey: ['creator-picks', gameId] })
      toast.success(t(result.created ? 'discovery.promotedCreated' : 'discovery.promotedUpdated'))
    },
    onError: toast.fromError,
  })
  const dismiss = useMutation({
    mutationFn: (candidateId: string) => trpc.creatorDiscovery.dismiss.mutate({ runId: selectedRunId!, candidateId }),
    onSuccess: invalidate,
    onError: toast.fromError,
  })
  const restore = useMutation({
    mutationFn: (candidateId: string) => trpc.creatorDiscovery.restore.mutate({ runId: selectedRunId!, candidateId }),
    onSuccess: () => {
      setSectionState(sectionKey, { candidateStatus: 'staged' })
      invalidate()
      toast.success(t('discovery.restored'))
    },
    onError: toast.fromError,
  })
  const reviewBulk = useMutation({
    mutationFn: (input: { decision: 'promote' | 'dismiss' | 'restore'; candidateIds: string[] }) =>
      trpc.creatorDiscovery.reviewBulk.mutate({
        runId: selectedRunId!,
        decision: input.decision,
        candidateIds: input.candidateIds,
        minFit: 0,
        minReferenceMatches: 1,
        requireBusinessEmail: false,
        limit: input.candidateIds.length,
      }),
    onSuccess: (result) => {
      invalidate()
      if (result.decision === 'promote') {
        if (result.queued && result.operation) {
          setSectionState(sectionKey, { trackedPromotionOperationId: result.operation.id })
          toast.success(
            t(result.duplicate ? 'discovery.promotionAlreadyQueued' : 'discovery.promotionQueued', {
              n: result.selected,
            }),
          )
        }
      } else if (result.decision === 'dismiss') {
        toast.success(t('discovery.bulkDismissed', { n: result.processed }))
      } else {
        setSectionState(sectionKey, { candidateStatus: 'staged' })
        toast.success(t('discovery.bulkRestored', { n: result.processed }))
      }
    },
    onError: toast.fromError,
  })
  const cancelPromotion = useMutation({
    mutationFn: (id: string) => trpc.creatorDiscovery.cancelPromotion.mutate({ id }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['creator-promotion-operations'] })
      toast.success(t('discovery.promotionCancelled'))
    },
    onError: toast.fromError,
  })
  const retryPromotion = useMutation({
    mutationFn: (id: string) => trpc.creatorDiscovery.retryPromotion.mutate({ id }),
    onSuccess: (operation) => {
      if (operation) {
        setSectionState(sectionKey, {
          trackedPromotionOperationId: operation.id,
          notifiedPromotionOperationId: null,
        })
      }
      qc.invalidateQueries({ queryKey: ['creator-promotion-operations'] })
      toast.success(t('discovery.promotionRetryQueued'))
    },
    onError: toast.fromError,
  })

  useEffect(() => {
    const notifiedId =
      typeof sectionState.notifiedPromotionOperationId === 'string' ? sectionState.notifiedPromotionOperationId : null
    if (!trackedPromotion || trackedPromotion.id === notifiedId) return
    if (!['completed', 'partial', 'failed', 'cancelled'].includes(trackedPromotion.status)) return
    setSectionState(sectionKey, { notifiedPromotionOperationId: trackedPromotion.id })
    invalidate()
    qc.invalidateQueries({ queryKey: ['creators'] })
    qc.invalidateQueries({ queryKey: ['creator-picks', gameId] })
    if (trackedPromotion.status === 'completed') {
      toast.success(
        t('discovery.bulkPromoted', {
          n: trackedPromotion.processed,
          created: trackedPromotion.createdCount,
          updated: trackedPromotion.updatedCount,
        }),
      )
    } else if (trackedPromotion.status === 'partial' || trackedPromotion.status === 'failed') {
      toast.error(
        t('discovery.promotionPartial', {
          completed: trackedPromotion.succeeded,
          failed: trackedPromotion.failed,
        }),
      )
    }
  }, [gameId, invalidate, qc, sectionKey, sectionState, setSectionState, t, trackedPromotion])

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
  const visibleCandidateIds = (candidates.data ?? []).map(({ candidate }) => candidate.id)
  const promotionProgress = latestPromotion
    ? Math.round((latestPromotion.processed / Math.max(1, latestPromotion.selected)) * 100)
    : 0
  const openNewSearch = () => {
    setForm(emptyForm)
    setSectionState(sectionKey, { formOpen: true })
  }
  const askAgent = () => {
    setSeedPrompt(t(hasProfile ? 'discovery.agentPromptExisting' : 'discovery.agentPromptEmpty'))
    navigate(`/g/${gameId}/ai`)
  }
  const openArchive = async () => {
    if (!archiveLocation.data?.available || !archiveLocation.data.path) {
      setSectionState('settings', { tab: 'projects' })
      navigate('/settings')
      return
    }
    const result = await window.marcat?.openLocalPath(archiveLocation.data.path)
    if (!result?.ok) toast.error(t('discovery.archiveOpenFailed'))
  }
  const reviewVisible = async (decision: 'promote' | 'dismiss' | 'restore') => {
    if (!visibleCandidateIds.length) return
    if (decision === 'restore') {
      reviewBulk.mutate({ decision, candidateIds: visibleCandidateIds })
      return
    }
    if (decision === 'promote' && !selectionPreview.data) return
    const preview = selectionPreview.data
    const ok = await confirm({
      title: t(decision === 'promote' ? 'discovery.bulkPromoteConfirmTitle' : 'discovery.bulkDismissConfirmTitle', {
        n: visibleCandidateIds.length,
        created: preview?.nextBatchCreated ?? 0,
        updated: preview?.nextBatchUpdated ?? 0,
      }),
      body: t(decision === 'promote' ? 'discovery.bulkPromoteConfirmBody' : 'discovery.bulkDismissConfirmBody', {
        created: preview?.nextBatchCreated ?? 0,
        updated: preview?.nextBatchUpdated ?? 0,
      }),
      confirmLabel: t(decision === 'promote' ? 'discovery.bulkPromote' : 'discovery.bulkDismiss', {
        n: visibleCandidateIds.length,
      }),
      danger: decision === 'dismiss',
    })
    if (ok) reviewBulk.mutate({ decision, candidateIds: visibleCandidateIds })
  }

  return (
    <div className="space-y-3">
      {needsSetup && (
        <section className="rounded-[calc(var(--radius)+8px)] bg-surface p-5 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_2px_4px_rgba(0,0,0,0.04)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius)] bg-alarm/10 text-alarm">
              <Share2 className="h-5 w-5" aria-hidden />
            </div>
            <div className="min-w-0">
              <h2 className="t-subtitle text-balance">{t('discovery.setupTitle')}</h2>
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
              <p className="mt-1 text-pretty text-xs leading-relaxed text-muted">{t('discovery.setupSourcesHint')}</p>
              <div className="mt-3 space-y-3">
                <div>
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium">YouTube</span>
                    {quota.data?.youtube.configured && (
                      <span className="text-xs text-success">{t('discovery.sourceConnectedFree')}</span>
                    )}
                  </div>
                  {!quota.data?.youtube.configured && (
                    <>
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
                      <a
                        href="https://console.cloud.google.com/apis/library/youtube.googleapis.com"
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1.5 inline-flex min-h-8 items-center gap-1 text-xs text-accent hover:underline"
                      >
                        {t('discovery.openGoogleCloud')}
                        <ExternalLink className="h-3 w-3" aria-hidden />
                      </a>
                    </>
                  )}
                </div>
                <div className="border-t border-border pt-3">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium">Instagram · TikTok · X</span>
                    {quota.data?.social.configured && (
                      <span className="text-xs text-success">
                        {quota.data.social.creditsRemaining == null
                          ? t('discovery.sourceConnected')
                          : t('discovery.socialCreditsLeft', { n: quota.data.social.creditsRemaining })}
                      </span>
                    )}
                  </div>
                  {!quota.data?.social.configured && (
                    <>
                      <div className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                        <input
                          type="password"
                          value={socialKey}
                          onChange={(event) => setSocialKey(event.target.value)}
                          placeholder={t('discovery.socialApiKeyPlaceholder')}
                          autoComplete="off"
                          spellCheck={false}
                          className={fieldCls}
                        />
                        <Button
                          size="sm"
                          onClick={() => saveSocialKey.mutate()}
                          disabled={!socialKey.trim() || saveSocialKey.isPending}
                        >
                          {saveSocialKey.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                          {t('set.save')}
                        </Button>
                      </div>
                      <a
                        href="https://app.scrapecreators.com/"
                        target="_blank"
                        rel="noreferrer"
                        className="mt-1.5 inline-flex min-h-8 items-center gap-1 text-xs text-accent hover:underline"
                      >
                        {t('discovery.openScrapeCreators')}
                        <ExternalLink className="h-3 w-3" aria-hidden />
                      </a>
                    </>
                  )}
                </div>
              </div>
              <p className="mt-3 text-pretty t-caption leading-relaxed text-muted">{t('discovery.setupKeyPrivacy')}</p>
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
              <p className="mt-2 text-pretty t-caption leading-relaxed text-muted">
                {t('discovery.setupProfileLocation')}
              </p>
              {!hasProfile && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" onClick={openNewSearch}>
                    <Plus className="h-4 w-4" aria-hidden />
                    {t('discovery.newSearch')}
                  </Button>
                  <Button size="sm" variant="outline" onClick={askAgent}>
                    <Sparkles className="h-4 w-4" aria-hidden />
                    {t('discovery.askAgentCompact')}
                  </Button>
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {!needsSetup && (
        <section className="rounded-[calc(var(--radius)+8px)] bg-surface p-3 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_2px_4px_rgba(0,0,0,0.04)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={openNewSearch}>
              <Plus className="h-4 w-4" />
              {t('discovery.newSearch')}
            </Button>
            <Button size="sm" variant="outline" onClick={askAgent} title={t('discovery.askAgent')}>
              <Sparkles className="h-4 w-4" aria-hidden />
              {t('discovery.askAgentCompact')}
            </Button>
            <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
              {quota.data?.configured ? (
                <div className="flex flex-wrap gap-2" aria-label={t('discovery.quotaToday')}>
                  {quota.data.youtube.configured && <QuotaBadge label="YouTube" {...quota.data.youtube.search} />}
                  {quota.data.social.configured ? (
                    <CreditBadge
                      remaining={quota.data.social.creditsRemaining}
                      used={quota.data.social.creditsUsedToday}
                    />
                  ) : (
                    <Button size="sm" variant="ghost" onClick={() => navigate('/settings?connector=scrapecreators')}>
                      <Share2 className="h-4 w-4" aria-hidden />
                      {t('discovery.connectSocial')}
                    </Button>
                  )}
                </div>
              ) : (
                <span className="text-sm text-warning">{t('discovery.keyMissing')}</span>
              )}
              <Button
                size="icon"
                variant="ghost"
                title={t(archiveLocation.data?.available ? 'discovery.openArchive' : 'discovery.configureArchive')}
                aria-label={t(archiveLocation.data?.available ? 'discovery.openArchive' : 'discovery.configureArchive')}
                onClick={() => void openArchive()}
              >
                <FolderOpen className="h-4 w-4" aria-hidden />
              </Button>
            </div>
          </div>
        </section>
      )}

      {formOpen && (
        <DetailDrawer
          label={t('discovery.manualProfileTitle')}
          onClose={() => setSectionState(sectionKey, { formOpen: false })}
          contentClassName="min-h-full"
        >
          <p className="text-pretty text-sm text-muted">{t('discovery.manualProfileHint')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
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
            <label className="t-hint sm:col-span-2">
              {t(form.mode === 'topic' ? 'discovery.topicFacets' : 'discovery.references')}
              <textarea
                value={form.references}
                onChange={(event) => setForm({ ...form, references: event.target.value })}
                rows={4}
                placeholder={t(form.mode === 'topic' ? 'discovery.topicFacetsHint' : 'discovery.referencesHint')}
                className={cn(fieldCls, 'mt-1 resize-y')}
              />
              <span className="mt-1 block t-caption text-muted tabular-nums">
                {references.length} {t('discovery.referencesShort')}
              </span>
              {form.mode === 'topic' && (
                <span className="mt-1 block text-pretty t-caption leading-relaxed text-muted">
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
            <label className="flex min-h-10 items-center gap-2 self-end text-sm">
              <input
                type="checkbox"
                checked={form.discoverContacts}
                onChange={(event) => setForm({ ...form, discoverContacts: event.target.checked })}
                className="h-4 w-4 accent-accent"
              />
              {t('discovery.findContacts')}
            </label>
            <details className="group sm:col-span-2">
              <summary className="tap flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-[var(--radius)] text-sm font-medium text-muted hover:text-text">
                <SlidersHorizontal className="h-4 w-4" aria-hidden />
                {t('discovery.advancedSettings')}
              </summary>
              <div className="mt-2 grid gap-3 rounded-[calc(var(--radius)+4px)] bg-bg p-3 shadow-[0_0_0_1px_rgba(0,0,0,0.06)] sm:grid-cols-2 dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
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
            </details>
          </div>
          <div className="mt-auto flex justify-end gap-2 border-t border-border pt-4">
            <Button variant="ghost" size="sm" onClick={() => setSectionState(sectionKey, { formOpen: false })}>
              {t('common.cancel')}
            </Button>
            <Button
              size="sm"
              onClick={() => createProfile.mutate()}
              disabled={!form.name.trim() || !references.length || createProfile.isPending}
            >
              {createProfile.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('common.create')}
            </Button>
          </div>
        </DetailDrawer>
      )}

      {!needsSetup && (
        <section className="grid min-h-[360px] gap-3 xl:grid-cols-[260px_minmax(0,1fr)]">
          <aside className="min-w-0 rounded-[calc(var(--radius)+8px)] bg-surface p-3 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_2px_4px_rgba(0,0,0,0.04)] xl:sticky xl:top-0 xl:flex xl:max-h-[calc(100vh-7rem)] xl:flex-col dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
            <div className="flex min-h-0 gap-3 xl:flex-1 xl:flex-col">
              <div className="flex shrink-0 items-start gap-2 px-1 xl:w-full">
                <div>
                  <h2 className="text-balance text-sm font-semibold">{t('discovery.runs')}</h2>
                  <p className="mt-0.5 hidden text-pretty t-caption leading-relaxed text-muted xl:block">
                    {t('discovery.historyHint')}
                  </p>
                </div>
              </div>
              <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto pb-1 xl:mt-2 xl:block xl:space-y-1 xl:overflow-y-auto xl:overflow-x-hidden xl:pb-0 xl:pr-1">
                {(runs.data ?? []).map((run) => {
                  const runProfile = profileById.get(run.profileId)
                  return (
                    <button
                      key={run.id}
                      type="button"
                      aria-pressed={selectedRunId === run.id}
                      onClick={() =>
                        setSectionState(sectionKey, {
                          runId: run.id,
                          profileId: run.profileId,
                          formOpen: false,
                          trackedPromotionOperationId: null,
                        })
                      }
                      className={cn(
                        'min-h-[72px] w-full min-w-64 rounded-[10px] border-l-[4px] px-3 py-2 text-left transition-[background-color,box-shadow,scale] duration-150 ease-out active:scale-[0.96] xl:min-w-0',
                        CARD_STATE_STYLES[runTone(run.status)].spine,
                        selectedRunId === run.id
                          ? 'bg-accent/10 shadow-[inset_0_0_0_1px_rgba(39,194,129,0.35)]'
                          : 'hover:bg-surface-2',
                      )}
                    >
                      <span className="flex items-center justify-between gap-2">
                        <span className="truncate text-sm font-medium" title={runProfile?.name}>
                          {runProfile?.name ?? t('discovery.profile')}
                        </span>
                        <CardStateBadge tone={runTone(run.status)} className="rounded-full t-caption">
                          {t(`discovery.status.${run.status}`)}
                        </CardStateBadge>
                      </span>
                      <span className="mt-0.5 block truncate t-caption text-muted">{formatDate(run.createdAt)}</span>
                      <span className="mt-1 block t-caption text-muted tabular-nums">
                        {run.resultCounts.staged} {t('discovery.newShort')} · {run.resultCounts.promoted}{' '}
                        {t('discovery.contactsShort')} · {run.resultCounts.dismissed} {t('discovery.hiddenShort')}
                      </span>
                    </button>
                  )
                })}
                {!runs.data?.length && <p className="p-3 text-pretty text-sm text-muted">{t('discovery.emptyRuns')}</p>}
              </div>
            </div>
          </aside>

          <div className="min-w-0 space-y-3">
            {selectedRun ? (
              <div className="rounded-[calc(var(--radius)+8px)] bg-surface p-3 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_2px_4px_rgba(0,0,0,0.04)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {selectedRun.status === 'running' && <Loader2 className="h-4 w-4 animate-spin text-info" />}
                      <h2 className="truncate text-balance font-semibold">
                        {activeProfile?.name ?? t('discovery.profile')}
                      </h2>
                      <CardStateBadge tone={runTone(selectedRun.status)}>
                        {t(`discovery.status.${selectedRun.status}`)}
                      </CardStateBadge>
                    </div>
                    <p className="mt-1 text-pretty text-xs text-muted">
                      {t(`discovery.phase.${selectedRun.phase}`)} · {formatDate(selectedRun.createdAt)}
                    </p>
                    <p className="mt-1 text-sm text-muted tabular-nums">
                      {selectedRun.channelsScanned}/{selectedRun.channelsFound} {t('discovery.channels')} ·{' '}
                      {selectedRun.videosScanned} {t('discovery.videos')} · {selectedRun.contactsFound}{' '}
                      {t('discovery.emails')}
                    </p>
                  </div>
                  <div className="flex flex-wrap justify-end gap-1">
                    {['queued', 'running'].includes(selectedRun.status) && (
                      <Button
                        size="icon"
                        variant="outline"
                        onClick={() => pause.mutate(selectedRun.id)}
                        title={t('discovery.pause')}
                      >
                        <Pause className="h-4 w-4" />
                      </Button>
                    )}
                    {selectedRun.status === 'paused' && (
                      <Button size="sm" variant="outline" onClick={() => resume.mutate(selectedRun.id)}>
                        <RotateCcw className="h-4 w-4" />
                        {t('discovery.resume')}
                      </Button>
                    )}
                    {['completed', 'failed', 'cancelled', 'partial'].includes(selectedRun.status) && (
                      <Button
                        size="sm"
                        onClick={() =>
                          selectedRun.status === 'partial' ? resume.mutate(selectedRun.id) : start.mutate(false)
                        }
                        disabled={!selectedProfileId || start.isPending || resume.isPending}
                      >
                        {start.isPending || resume.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : selectedRun.status === 'partial' ? (
                          <RotateCcw className="h-4 w-4" />
                        ) : (
                          <Play className="h-4 w-4" />
                        )}
                        {t(selectedRun.status === 'partial' ? 'discovery.continueSearch' : 'discovery.startCompact')}
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
                {selectedRun.issue && (
                  <div
                    className={cn(
                      'mt-3 flex flex-col gap-3 rounded-[var(--radius)] p-3 xl:flex-row xl:items-center xl:justify-between',
                      selectedRun.issue.code === 'quota_wait'
                        ? 'bg-info/10 text-info'
                        : selectedRun.issue.code === 'request_uncertain'
                          ? 'bg-warning/10 text-warning'
                          : 'bg-alarm/10 text-alarm',
                    )}
                  >
                    <p className="max-w-3xl text-pretty text-sm leading-relaxed">
                      {t(
                        selectedRun.issue.code === 'request_uncertain' && selectedRun.issue.operation
                          ? `discovery.feedback.request_uncertain.${selectedRun.issue.operation}`
                          : `discovery.feedback.${selectedRun.issue.code}`,
                      )}
                    </p>
                    {selectedRun.issue.recovery === 'retry' && selectedRun.status !== 'waiting_for_quota' && (
                      <div className="flex shrink-0 flex-wrap gap-2">
                        {selectedRun.issue.code === 'request_uncertain' && (
                          <Button size="sm" variant="ghost" className="bg-surface/60 text-text" onClick={openNewSearch}>
                            <Plus className="h-4 w-4" />
                            {t('discovery.anotherSearch')}
                          </Button>
                        )}
                        <Button
                          size="sm"
                          variant="outline"
                          className="bg-surface text-text"
                          onClick={() => resume.mutate(selectedRun.id)}
                          disabled={resume.isPending}
                        >
                          {resume.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <RotateCcw className="h-4 w-4" />
                          )}
                          {t(
                            selectedRun.issue.code === 'request_uncertain'
                              ? 'discovery.continueThisSearch'
                              : 'discovery.retry',
                          )}
                        </Button>
                      </div>
                    )}
                    {selectedRun.issue.recovery === 'settings' && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="shrink-0 bg-surface text-text"
                        onClick={() =>
                          navigate(
                            `/settings?connector=${
                              ['social_setup', 'social_credits', 'provider_budget'].includes(
                                selectedRun.issue?.code ?? '',
                              )
                                ? 'scrapecreators'
                                : 'youtube'
                            }`,
                          )
                        }
                      >
                        <KeyRound className="h-4 w-4" />
                        {t('discovery.openConnectorSettings')}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            ) : selectedProfile ? (
              <div className="rounded-[calc(var(--radius)+8px)] bg-surface p-4 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_2px_4px_rgba(0,0,0,0.04)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="truncate text-balance font-semibold">{selectedProfile.name}</h2>
                    <p className="mt-1 text-pretty text-sm text-muted">
                      {selectedProfile.references.length} {t('discovery.referencesShort')}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <Button
                      size="sm"
                      onClick={() => start.mutate(false)}
                      disabled={!quota.data?.configured || start.isPending}
                    >
                      {start.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
                      {t('discovery.startCompact')}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      title={t('discovery.deleteProfile')}
                      aria-label={t('discovery.deleteProfile')}
                      onClick={() => removeProfile.mutate(selectedProfile.id)}
                      disabled={removeProfile.isPending}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="rounded-[calc(var(--radius)+8px)] bg-surface p-8 text-center text-pretty text-sm text-muted shadow-[0_0_0_1px_rgba(0,0,0,0.06)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
                {t('discovery.selectRun')}
              </div>
            )}

            {latestPromotion && (
              <section className="rounded-[calc(var(--radius)+8px)] bg-surface p-3 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_2px_4px_rgba(0,0,0,0.04)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
                <div className="flex items-start gap-3">
                  <div
                    className={cn(
                      'flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius)]',
                      latestPromotion.status === 'completed'
                        ? 'bg-success/10 text-success'
                        : latestPromotion.status === 'partial' || latestPromotion.status === 'failed'
                          ? 'bg-warning/10 text-warning'
                          : latestPromotion.status === 'cancelled'
                            ? 'bg-muted/10 text-muted'
                            : 'bg-info/10 text-info',
                    )}
                  >
                    {latestPromotion.status === 'completed' ? (
                      <CircleCheck className="h-5 w-5" aria-hidden />
                    ) : latestPromotion.status === 'queued' ? (
                      <Clock3 className="h-5 w-5" aria-hidden />
                    ) : latestPromotion.status === 'running' ? (
                      <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
                    ) : latestPromotion.status === 'partial' || latestPromotion.status === 'failed' ? (
                      <CircleAlert className="h-5 w-5" aria-hidden />
                    ) : (
                      <Square className="h-5 w-5" aria-hidden />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <h3 className="text-balance text-sm font-semibold">
                          {t(`discovery.promotionStatus.${latestPromotion.status}`)}
                        </h3>
                        <p className="mt-0.5 text-pretty text-xs text-muted tabular-nums">
                          {t('discovery.promotionProgress', {
                            processed: latestPromotion.processed,
                            selected: latestPromotion.selected,
                            created: latestPromotion.createdCount,
                            updated: latestPromotion.updatedCount,
                            failed: latestPromotion.failed,
                          })}
                        </p>
                        {['partial', 'failed'].includes(latestPromotion.status) && latestPromotion.failed > 0 && (
                          <p className="mt-1 max-w-2xl text-pretty text-xs leading-relaxed text-warning">
                            {t('discovery.promotionNeedsAttentionHint', { n: latestPromotion.failed })}
                          </p>
                        )}
                      </div>
                      {activePromotion && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => cancelPromotion.mutate(activePromotion.id)}
                          disabled={cancelPromotion.isPending}
                        >
                          <Square className="h-4 w-4" aria-hidden />
                          {t('discovery.cancelPromotion')}
                        </Button>
                      )}
                      {['partial', 'failed'].includes(latestPromotion.status) && latestPromotion.failed > 0 && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => retryPromotion.mutate(latestPromotion.id)}
                          disabled={retryPromotion.isPending}
                        >
                          {retryPromotion.isPending ? (
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                          ) : (
                            <RotateCcw className="h-4 w-4" aria-hidden />
                          )}
                          {t('discovery.retryFailedPromotion', { n: latestPromotion.failed })}
                        </Button>
                      )}
                    </div>
                    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted/15">
                      <div
                        className={cn(
                          'h-full rounded-full transition-[width] duration-150 ease-out',
                          latestPromotion.status === 'completed'
                            ? 'bg-success'
                            : latestPromotion.status === 'partial' || latestPromotion.status === 'failed'
                              ? 'bg-warning'
                              : 'bg-info',
                        )}
                        style={{ width: `${Math.min(100, Math.max(0, promotionProgress))}%` }}
                      />
                    </div>
                  </div>
                </div>
              </section>
            )}

            {selectedRun && (
              <div className="rounded-[calc(var(--radius)+8px)] bg-surface p-4 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_2px_4px_rgba(0,0,0,0.04)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]">
                <div>
                  <div className="flex items-center gap-2">
                    <Search className="h-4 w-4 text-accent" aria-hidden />
                    <h2 className="text-balance font-semibold">{t('discovery.staging')}</h2>
                    <span className="rounded-full bg-surface-2 px-2 py-0.5 text-xs text-muted tabular-nums">
                      {candidateStatus === 'staged'
                        ? (selectionPreview.data?.total ?? candidates.data?.length ?? 0)
                        : (candidates.data?.length ?? 0)}
                    </span>
                  </div>
                  <p className="mt-1 max-w-3xl text-pretty text-sm text-muted">{t('discovery.resultsHint')}</p>
                </div>
                <div className="mt-3 flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
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
                    <label className="flex min-h-10 items-center gap-2 text-xs text-muted">
                      {t('discovery.minReferenceMatches')}
                      <input
                        type="number"
                        min={1}
                        max={activeProfile?.references.length ?? 100}
                        value={minReferenceMatches}
                        onChange={(event) =>
                          setSectionState(sectionKey, {
                            minReferenceMatches: Math.max(
                              1,
                              Math.min(activeProfile?.references.length ?? 100, Number(event.target.value) || 1),
                            ),
                          })
                        }
                        className={cn(fieldCls, 'w-16 tabular-nums')}
                      />
                    </label>
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
                    <label className="flex min-h-10 items-center gap-2 text-xs text-muted">
                      <input
                        type="checkbox"
                        checked={requireBusinessEmail}
                        onChange={(event) =>
                          setSectionState(sectionKey, { requireBusinessEmail: event.target.checked })
                        }
                        className="h-4 w-4 accent-accent"
                      />
                      {t('discovery.requireBusinessEmail')}
                    </label>
                  </div>
                  {candidateStatus === 'staged' && visibleCandidateIds.length > 0 && (
                    <div className="flex flex-wrap gap-2 xl:justify-end">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => void reviewVisible('dismiss')}
                        disabled={reviewBulk.isPending}
                      >
                        <EyeOff className="h-4 w-4" aria-hidden />
                        {t('discovery.bulkDismiss', { n: visibleCandidateIds.length })}
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => void reviewVisible('promote')}
                        disabled={reviewBulk.isPending || selectionPreview.isLoading || !!activePromotion}
                      >
                        {reviewBulk.isPending ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <UserPlus className="h-4 w-4" aria-hidden />
                        )}
                        {t('discovery.bulkPromote', { n: visibleCandidateIds.length })}
                      </Button>
                    </div>
                  )}
                  {candidateStatus === 'dismissed' && visibleCandidateIds.length > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void reviewVisible('restore')}
                      disabled={reviewBulk.isPending}
                    >
                      {reviewBulk.isPending ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RotateCcw className="h-4 w-4" aria-hidden />
                      )}
                      {t('discovery.bulkRestore', { n: visibleCandidateIds.length })}
                    </Button>
                  )}
                </div>
                {candidateStatus === 'staged' &&
                  selectionPreview.data &&
                  selectionPreview.data.total > visibleCandidateIds.length && (
                    <p className="mt-2 text-pretty text-xs text-muted tabular-nums">
                      {t('discovery.batchShown', {
                        shown: visibleCandidateIds.length,
                        total: selectionPreview.data.total,
                      })}
                    </p>
                  )}

                {candidates.isLoading ? (
                  <LoadingState />
                ) : candidates.error ? (
                  <QueryError error={candidates.error} onRetry={() => candidates.refetch()} />
                ) : candidates.data?.length ? (
                  <div className="mt-3 space-y-2">
                    {candidates.data.map(({ candidate, result, contacts, evidence }) => {
                      const emails = contacts.filter((contact) => contact.type === 'business_email')
                      const matchedReferences = JSON.parse(result.matchedReferencesJson) as string[]
                      return (
                        <article
                          key={candidate.id}
                          className="rounded-[calc(var(--radius)+4px)] bg-bg p-3 shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_1px_2px_-1px_rgba(0,0,0,0.06)] transition-[box-shadow] duration-150 ease-out hover:shadow-[0_0_0_1px_rgba(0,0,0,0.09),0_2px_4px_rgba(0,0,0,0.05)] dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]"
                        >
                          <div className="flex flex-col gap-3 sm:flex-row">
                            <div className="flex min-w-0 flex-1 gap-3">
                              {candidate.thumbnailUrl ? (
                                <img
                                  src={candidate.thumbnailUrl}
                                  alt=""
                                  className="h-12 w-12 shrink-0 rounded-[var(--radius)] object-cover outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
                                />
                              ) : (
                                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-[var(--radius)] bg-surface-2">
                                  {candidate.platform === 'youtube' ? (
                                    <Youtube className="h-5 w-5 text-muted" />
                                  ) : (
                                    <Share2 className="h-5 w-5 text-muted" />
                                  )}
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
                                    <span className="ml-2 inline-flex rounded-full bg-surface-2 px-2 py-0.5 align-middle t-caption font-medium text-muted">
                                      {platformLabel(candidate.platform)}
                                    </span>
                                    <p className="mt-0.5 text-xs text-muted tabular-nums">
                                      {compact(candidate.subscriberCount)} {t('discovery.followers')} ·{' '}
                                      {compact(candidate.avgViews)} {t('discovery.avgViews')}
                                    </p>
                                  </div>
                                  <span
                                    className="inline-flex items-baseline gap-0.5 rounded-full bg-accent/10 px-2.5 py-1 text-sm font-semibold text-accent tabular-nums"
                                    title={t('discovery.relevanceScore')}
                                  >
                                    {result.fitScore}
                                    <span className="t-caption font-normal opacity-70">/100</span>
                                  </span>
                                </div>
                                <div className="mt-2 flex flex-wrap gap-1.5">
                                  {matchedReferences.slice(0, 8).map((reference) => (
                                    <span
                                      key={reference}
                                      className="rounded-full bg-surface-2 px-2 py-0.5 t-caption text-muted"
                                    >
                                      {reference}
                                    </span>
                                  ))}
                                  {matchedReferences.length > 8 && (
                                    <span
                                      className="rounded-full bg-surface-2 px-2 py-0.5 t-caption text-muted"
                                      title={matchedReferences.slice(8).join(', ')}
                                    >
                                      +{matchedReferences.length - 8}
                                    </span>
                                  )}
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
                            </div>
                            {result.status === 'staged' && (
                              <div className="flex shrink-0 gap-1 sm:flex-col">
                                <Button
                                  size="sm"
                                  className="flex-1 sm:flex-none"
                                  title={t('discovery.promote')}
                                  aria-label={t('discovery.promote')}
                                  onClick={() => promote.mutate(candidate.id)}
                                  disabled={promote.isPending}
                                >
                                  <UserPlus className="h-4 w-4" aria-hidden />
                                  {t('discovery.promote')}
                                </Button>
                                <Button
                                  size="sm"
                                  className="flex-1 sm:flex-none"
                                  variant="ghost"
                                  title={t('discovery.dismiss')}
                                  aria-label={t('discovery.dismiss')}
                                  onClick={() => dismiss.mutate(candidate.id)}
                                  disabled={dismiss.isPending}
                                >
                                  <EyeOff className="h-4 w-4" aria-hidden />
                                  {t('discovery.dismiss')}
                                </Button>
                              </div>
                            )}
                            {result.status === 'dismissed' && (
                              <div className="flex shrink-0 gap-1 sm:flex-col">
                                <Button
                                  size="sm"
                                  className="flex-1 sm:flex-none"
                                  variant="outline"
                                  title={t('discovery.restore')}
                                  aria-label={t('discovery.restore')}
                                  onClick={() => restore.mutate(candidate.id)}
                                  disabled={restore.isPending}
                                >
                                  <RotateCcw className="h-4 w-4" aria-hidden />
                                  {t('discovery.restore')}
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
