import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Bot,
  CheckCircle2,
  ChevronDown,
  DatabaseBackup,
  FolderKanban,
  KeyRound,
  PlugZap,
  Sparkles,
  Terminal,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react'
import { trpc } from '@/lib/trpc'
import { cn, fieldCls } from '@/lib/utils'
import { useTheme, type ThemeMode } from '@/store/theme'
import { useSettings, comboFromEvent, type CompanionActivity, type Lang } from '@/store/settings'
import { useUi } from '@/store/ui'
import { confirm } from '@/store/confirm'
import { toast } from '@/store/toast'
import { useT } from '@/i18n/useT'
import { Button } from '@/components/ui/Button'
import { Segmented } from '@/components/ui/Toggle'
import { LoadingState, QueryError } from '@/components/ui/QueryState'
import { WhatsNewDialog } from '@/components/settings/WhatsNewDialog'
import { WorkspaceSettings } from '@/components/settings/WorkspaceSettings'

const PROVIDERS = [
  { provider: 'twitterapi' as const, label: 'X / Twitter — twitterapi.io', paid: true },
  { provider: 'scrapecreators' as const, label: 'Instagram + TikTok — ScrapeCreators', paid: true },
  { provider: 'youtube' as const, label: 'YouTube — Data API (free)', paid: false },
  { provider: 'steamfinancial' as const, label: 'Steamworks — Financial API', paid: false },
  { provider: 'gmass' as const, label: 'GMass — Campaign API', paid: false },
]
type ConnectorProvider = (typeof PROVIDERS)[number]['provider']
type McpClient = 'codex' | 'claude'
const modes: ThemeMode[] = ['system', 'light', 'dark']
const langs: { id: Lang; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'ru', label: 'Русский' },
]
const companionActivities: CompanionActivity[] = ['request', 'medium', 'high']
type SettingsTab = 'general' | 'projects' | 'integrations' | 'data'
const SETTINGS_VIEW_KEY = 'settings'
const SETTINGS_TABS: { id: SettingsTab; icon: LucideIcon }[] = [
  { id: 'general', icon: SlidersHorizontal },
  { id: 'projects', icon: FolderKanban },
  { id: 'integrations', icon: PlugZap },
  { id: 'data', icon: DatabaseBackup },
]

function isSettingsTab(value: unknown): value is SettingsTab {
  return SETTINGS_TABS.some((tab) => tab.id === value)
}

function isConnectorProvider(value: unknown): value is ConnectorProvider {
  return PROVIDERS.some((provider) => provider.provider === value)
}

function isMcpClient(value: unknown): value is McpClient {
  return value === 'codex' || value === 'claude'
}

function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="space-y-3 rounded-[16px] bg-surface p-4 shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_1px_var(--border)]">
      {title && <h2 className="t-section">{title}</h2>}
      {children}
    </section>
  )
}

function SettingRow({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid gap-2 py-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-6">
      <div className="min-w-0">
        <div className="text-sm text-text">{label}</div>
        {hint && <p className="mt-0.5 text-pretty text-xs text-muted">{hint}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">{children}</div>
    </div>
  )
}

function HotkeyRow({ label, combo, onSet }: { label: string; combo: string; onSet: (c: string) => void }) {
  const t = useT()
  const [capturing, setCapturing] = useState(false)
  return (
    <div className="grid gap-2 py-1 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:gap-4">
      <span className="text-sm text-text">{label}</span>
      <div className="flex items-center gap-2 sm:justify-end">
        <kbd className="min-w-24 rounded-[var(--radius)] border border-border-strong bg-bg px-2 py-1.5 text-center font-mono text-xs shadow-hard">
          {capturing ? t('set.press') : combo}
        </kbd>
        <Button
          size="sm"
          variant={capturing ? 'primary' : 'outline'}
          onClick={() => setCapturing(true)}
          onKeyDown={(e) => {
            if (!capturing) return
            e.preventDefault()
            if (['Control', 'Meta', 'Alt', 'Shift'].includes(e.key)) return
            onSet(comboFromEvent(e.nativeEvent))
            setCapturing(false)
          }}
        >
          {capturing ? t('set.waiting') : t('set.change')}
        </Button>
      </div>
    </div>
  )
}

export function Settings() {
  const t = useT()
  const [searchParams] = useSearchParams()
  const requestedConnector = searchParams.get('connector')
  const setSectionViewState = useUi((s) => s.setSectionViewState)
  const rememberedSettingsState = useUi.getState().sectionViewStates?.[SETTINGS_VIEW_KEY]
  const [activeTab, setActiveTab] = useState<SettingsTab>(() => {
    if (requestedConnector) return 'integrations'
    const remembered = useUi.getState().sectionViewStates?.[SETTINGS_VIEW_KEY]?.tab
    return isSettingsTab(remembered) ? remembered : 'general'
  })
  const mode = useTheme((s) => s.mode)
  const setMode = useTheme((s) => s.setMode)
  const lang = useSettings((s) => s.lang)
  const setLang = useSettings((s) => s.setLang)
  const companionActivity = useSettings((s) => s.companionActivity)
  const setCompanionActivity = useSettings((s) => s.setCompanionActivity)
  const commandHotkey = useSettings((s) => s.commandHotkey)
  const setCommandHotkey = useSettings((s) => s.setCommandHotkey)
  const paletteHotkey = useSettings((s) => s.paletteHotkey)
  const setPaletteHotkey = useSettings((s) => s.setPaletteHotkey)
  const [token, setToken] = useState('')
  const [mcpClient, setMcpClientState] = useState<McpClient>(() =>
    isMcpClient(rememberedSettingsState?.mcpClient) ? rememberedSettingsState.mcpClient : 'codex',
  )
  const [openConnector, setOpenConnectorState] = useState<ConnectorProvider | null>(() => {
    if (isConnectorProvider(requestedConnector)) return requestedConnector
    return isConnectorProvider(rememberedSettingsState?.openConnector) ? rememberedSettingsState.openConnector : null
  })
  const [whatsNewOpen, setWhatsNewOpen] = useState(false)
  const qc = useQueryClient()

  const ai = useQuery({ queryKey: ['ai-available'], queryFn: () => trpc.ai.available.query() })
  const saveToken = useMutation({
    mutationFn: () => trpc.ai.setToken.mutate({ token }),
    onSuccess: () => {
      setToken('')
      qc.invalidateQueries({ queryKey: ['ai-available'] })
    },
  })
  const saveAiProvider = useMutation({
    mutationFn: (provider: 'claude' | 'codex') => trpc.ai.setProvider.mutate({ provider }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['ai-available'] }),
    onError: toast.fromError,
  })

  const [keys, setKeys] = useState<Record<string, string>>({
    twitterapi: '',
    scrapecreators: '',
    youtube: '',
    steamfinancial: '',
    gmass: '',
  })
  const keyStatus = useQuery({ queryKey: ['connector-keys'], queryFn: () => trpc.sources.keyStatus.query() })
  const spend = useQuery({ queryKey: ['spend'], queryFn: () => trpc.sources.spend.query() })
  const saveKey = useMutation({
    mutationFn: (provider: string) => trpc.sources.setApiKey.mutate({ provider, key: keys[provider] ?? '' }),
    onSuccess: (_r, provider) => {
      setKeys((k) => ({ ...k, [provider]: '' }))
      qc.invalidateQueries({ queryKey: ['connector-keys'] })
      qc.invalidateQueries({ queryKey: ['storefront-metrics'] })
    },
  })
  const setBudget = useMutation({
    mutationFn: (v: { provider: string; dailyBudgetUsd: number | null }) => trpc.sources.setBudget.mutate(v),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['spend'] }),
  })

  const mcp = useQuery({ queryKey: ['mcp-info'], queryFn: () => trpc.system.mcpInfo.query() })
  const release = useQuery({ queryKey: ['release-info'], queryFn: () => trpc.system.releaseInfo.query() })
  const devhub = useQuery({ queryKey: ['devhub-status'], queryFn: () => trpc.system.devhubStatus.query() })
  const backups = useQuery({ queryKey: ['backups'], queryFn: () => trpc.system.listBackups.query() })
  const [backupMsg, setBackupMsg] = useState<string | null>(null)
  const [restored, setRestored] = useState(false)
  const makeBackup = useMutation({
    mutationFn: () => trpc.system.backup.mutate(),
    onSuccess: (r) => {
      setBackupMsg(t('set.backupDone', { path: r.path }))
      qc.invalidateQueries({ queryKey: ['backups'] })
    },
  })
  const restore = useMutation({
    mutationFn: (path: string) => trpc.system.restoreBackup.mutate({ path }),
    onSuccess: () => setRestored(true),
    onError: toast.fromError,
  })
  const askRestore = (path: string) =>
    void confirm({
      title: t('set.restore'),
      body: t('set.restoreConfirm'),
      danger: true,
      confirmLabel: t('set.restore'),
    }).then((ok) => ok && restore.mutate(path))
  const [mcpCopied, setMcpCopied] = useState(false)
  const mcpJson = mcp.data
    ? JSON.stringify(
        {
          mcpServers: { marcat: { command: 'node', args: [mcp.data.serverPath], env: { MARCAT_DB: mcp.data.dbPath } } },
        },
        null,
        2,
      )
    : ''
  const codexMcpCommand = mcp.data
    ? `codex mcp add marcat --env "MARCAT_DB=${mcp.data.dbPath.replaceAll('"', '\\"')}" -- node "${mcp.data.serverPath.replaceAll('"', '\\"')}"`
    : ''
  const mcpSetup = mcpClient === 'codex' ? codexMcpCommand : mcpJson
  const copyMcp = () => {
    void navigator.clipboard?.writeText(mcpSetup)
    setMcpCopied(true)
    window.setTimeout(() => setMcpCopied(false), 1500)
  }

  useEffect(() => {
    if (!requestedConnector) return
    setActiveTab('integrations')
    const connector = isConnectorProvider(requestedConnector) ? requestedConnector : null
    if (connector) setOpenConnectorState(connector)
    setSectionViewState(SETTINGS_VIEW_KEY, { tab: 'integrations', openConnector: connector })
  }, [requestedConnector, setSectionViewState])

  const selectTab = (tab: SettingsTab) => {
    setActiveTab(tab)
    setSectionViewState(SETTINGS_VIEW_KEY, { tab })
  }

  const selectMcpClient = (client: McpClient) => {
    setMcpClientState(client)
    setMcpCopied(false)
    setSectionViewState(SETTINGS_VIEW_KEY, { mcpClient: client })
  }

  const toggleConnector = (provider: ConnectorProvider) => {
    const next = openConnector === provider ? null : provider
    setOpenConnectorState(next)
    setSectionViewState(SETTINGS_VIEW_KEY, { openConnector: next })
  }

  const moveTabFocus = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    const last = SETTINGS_TABS.length - 1
    const nextIndex =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : event.key === 'ArrowDown' || event.key === 'ArrowRight'
            ? (index + 1) % SETTINGS_TABS.length
            : (index - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length
    const nextTab = SETTINGS_TABS[nextIndex].id
    selectTab(nextTab)
    document.getElementById(`settings-tab-${nextTab}`)?.focus()
  }

  const aiStatusLabel = (status: { available: boolean; authenticated: boolean; authMode: string } | undefined) => {
    if (!status?.available) return t('set.aiStatusMissing')
    if (!status.authenticated) return t('set.aiStatusLogin')
    if (status.authMode === 'subscription') return t('set.aiStatusSubscription')
    if (status.authMode === 'oauth_token') return t('set.aiStatusOauth')
    if (status.authMode === 'api_key') return t('set.aiStatusApi')
    return t('set.aiStatusReady')
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <div>
        <h1 className="t-title text-balance">{t('set.title')}</h1>
        <p className="mt-1 text-pretty text-sm text-muted">{t('set.subtitle')}</p>
      </div>

      <div className="grid items-start gap-4 md:grid-cols-[184px_minmax(0,1fr)] md:gap-6">
        <nav
          className="flex gap-1 overflow-x-auto rounded-[16px] bg-surface-2 p-1.5 shadow-[inset_0_0_0_1px_var(--border)] md:sticky md:top-4 md:flex-col"
          role="tablist"
          aria-label={t('set.sections')}
        >
          {SETTINGS_TABS.map((tab, index) => {
            const Icon = tab.icon
            const selected = activeTab === tab.id
            return (
              <button
                key={tab.id}
                id={`settings-tab-${tab.id}`}
                type="button"
                role="tab"
                tabIndex={selected ? 0 : -1}
                aria-selected={selected}
                aria-controls={`settings-panel-${tab.id}`}
                onClick={() => selectTab(tab.id)}
                onKeyDown={(event) => moveTabFocus(event, index)}
                className={cn(
                  'tap inline-flex min-h-11 shrink-0 items-center gap-2.5 rounded-[11px] px-3 text-left text-sm font-medium transition-[background-color,color,box-shadow] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
                  selected
                    ? 'bg-surface text-text shadow-[0_1px_2px_rgb(0_0_0/0.08),0_0_0_1px_var(--border)]'
                    : 'text-muted hover:bg-surface/60 hover:text-text',
                )}
              >
                <Icon className={cn('h-4 w-4 shrink-0', selected && 'text-accent')} aria-hidden />
                {t(`set.tab.${tab.id}`)}
              </button>
            )
          })}
        </nav>

        <main
          id={`settings-panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`settings-tab-${activeTab}`}
          tabIndex={0}
          className="enter-stagger min-w-0 space-y-4 focus:outline-none"
        >
          <header className="px-0.5">
            <h2 className="text-balance text-lg font-semibold text-text">{t(`set.tab.${activeTab}`)}</h2>
            <p className="mt-1 text-pretty text-sm text-muted">{t(`set.tab.${activeTab}.hint`)}</p>
          </header>

          {activeTab === 'general' && (
            <>
              <Card title={t('set.appearance')}>
                <SettingRow label={t('set.language')}>
                  {langs.map((l) => (
                    <Button
                      key={l.id}
                      size="sm"
                      variant={lang === l.id ? 'primary' : 'outline'}
                      aria-pressed={lang === l.id}
                      onClick={() => setLang(l.id)}
                    >
                      {l.label}
                    </Button>
                  ))}
                </SettingRow>
                <SettingRow label={t('set.theme')}>
                  {modes.map((m) => (
                    <Button
                      key={m}
                      size="sm"
                      variant={mode === m ? 'primary' : 'outline'}
                      aria-pressed={mode === m}
                      onClick={() => setMode(m)}
                    >
                      {t(`theme.${m}`)}
                    </Button>
                  ))}
                </SettingRow>
              </Card>

              <Card title="MarCat">
                <div className="flex items-center gap-3 border-b border-border pb-2.5">
                  <span className="flex-1 text-sm text-text">
                    {t('set.version')} <span className="font-mono text-muted">{release.data?.version ?? '…'}</span>
                  </span>
                  <Button size="sm" variant="outline" onClick={() => setWhatsNewOpen(true)} disabled={!release.data}>
                    {t('set.whatsNew')}
                  </Button>
                </div>
                <div>
                  <div className="text-sm text-text">{t('set.companionActivity')}</div>
                  <p className="mt-0.5 t-hint text-pretty">{t('set.companionActivityHint')}</p>
                </div>
                <div
                  className="grid grid-cols-3 gap-1 rounded-[12px] bg-bg p-1 shadow-[inset_0_0_0_1px_var(--border)]"
                  role="group"
                  aria-label={t('set.companionActivity')}
                >
                  {companionActivities.map((activity) => (
                    <Button
                      key={activity}
                      size="sm"
                      variant={companionActivity === activity ? 'primary' : 'ghost'}
                      aria-pressed={companionActivity === activity}
                      onClick={() => setCompanionActivity(activity)}
                      className="w-full px-2"
                    >
                      {t(`set.companionActivity.${activity}`)}
                    </Button>
                  ))}
                </div>
                <p className="t-hint text-pretty" role="status">
                  {t(`set.companionActivity.${companionActivity}.hint`)}
                </p>
              </Card>

              <Card title={t('set.hotkeys')}>
                <HotkeyRow label={t('set.hkCommand')} combo={commandHotkey} onSet={setCommandHotkey} />
                <HotkeyRow label={t('set.hkPalette')} combo={paletteHotkey} onSet={setPaletteHotkey} />
              </Card>
            </>
          )}

          {activeTab === 'projects' && <WorkspaceSettings />}

          {activeTab === 'integrations' && (
            <>
              <Card title={t('set.aiEngine')}>
                <p className="text-pretty text-xs text-muted">{t('set.aiEngineHint')}</p>
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t('set.aiEngine')}>
                  {(['claude', 'codex'] as const).map((provider) => {
                    const selected = ai.data?.provider === provider
                    const status = ai.data?.providers[provider]
                    const ProviderIcon = provider === 'claude' ? Bot : Sparkles
                    return (
                      <button
                        key={provider}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        disabled={saveAiProvider.isPending}
                        onClick={() => saveAiProvider.mutate(provider)}
                        className={cn(
                          'tactile min-h-24 rounded-[12px] bg-bg p-3 text-left shadow-[inset_0_0_0_1px_var(--border)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60',
                          selected && 'bg-accent/5 shadow-[inset_0_0_0_1px_var(--accent)]',
                        )}
                      >
                        <span className="flex items-center gap-2">
                          <ProviderIcon className={cn('h-4 w-4', selected ? 'text-accent' : 'text-muted')} />
                          <span className="font-medium text-text">
                            {provider === 'claude' ? 'Claude Code' : 'Codex CLI'}
                          </span>
                          {selected && (
                            <span className="ml-auto rounded-full bg-accent/10 px-2 py-1 text-[11px] text-accent">
                              {t('set.aiSelected')}
                            </span>
                          )}
                        </span>
                        <span className="mt-1.5 block text-pretty text-xs text-muted">
                          {t(provider === 'claude' ? 'set.aiClaudeHint' : 'set.aiCodexHint')}
                        </span>
                        <span
                          className={cn(
                            'mt-2 inline-flex items-center gap-1.5 text-[11px]',
                            status?.authenticated ? 'text-success' : 'text-muted',
                          )}
                        >
                          <span
                            className={cn(
                              'h-1.5 w-1.5 rounded-full',
                              status?.authenticated ? 'bg-success' : 'bg-muted',
                            )}
                          />
                          {aiStatusLabel(status)}
                        </span>
                      </button>
                    )
                  })}
                </div>

                {ai.data?.provider === 'codex' ? (
                  <div className="rounded-[12px] bg-bg p-3 shadow-[inset_0_0_0_1px_var(--border)]">
                    <div className="flex items-start gap-2.5">
                      <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                      <div className="min-w-0">
                        <div className="text-sm text-text">{t('set.aiCodexAuth')}</div>
                        <p className="mt-0.5 text-pretty text-xs text-muted">{t('set.aiCodexAuthHint')}</p>
                        <p className="mt-2 text-xs text-muted">
                          {t('set.aiCurrentStatus')}{' '}
                          <span className={ai.data.providers.codex.authenticated ? 'text-success' : 'text-warning'}>
                            {aiStatusLabel(ai.data.providers.codex)}
                          </span>
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2 rounded-[12px] bg-bg p-3 shadow-[inset_0_0_0_1px_var(--border)]">
                    <div className="flex items-start gap-2.5">
                      <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                      <div>
                        <div className="text-sm text-text">{t('set.aiClaudeAuth')}</div>
                        <p className="mt-0.5 text-pretty text-xs text-muted">{t('set.aiClaudeAuthHint')}</p>
                      </div>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                      <input
                        type="password"
                        className={fieldCls}
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        placeholder="sk-ant-oat… / sk-ant-api…"
                      />
                      <Button
                        size="sm"
                        onClick={() => saveToken.mutate()}
                        disabled={!token.trim() || saveToken.isPending}
                      >
                        {t('set.aiTokenSave')}
                      </Button>
                    </div>
                    <p className="text-xs text-muted">
                      {t('set.aiCurrentStatus')}{' '}
                      <span className={ai.data?.providers.claude.authenticated ? 'text-success' : 'text-warning'}>
                        {aiStatusLabel(ai.data?.providers.claude)}
                      </span>
                    </p>
                  </div>
                )}
              </Card>

              <Card>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-balance text-base font-semibold text-text">{t('set.mcp')}</h2>
                      <span className="rounded-full bg-accent/10 px-2 py-1 text-[11px] font-medium text-accent">
                        {t('set.recommended')}
                      </span>
                    </div>
                    <p className="mt-1 max-w-2xl text-pretty text-sm text-muted">{t('set.mcpHint')}</p>
                  </div>
                </div>

                <div className="flex items-start gap-2.5 rounded-[12px] bg-accent/5 p-3 shadow-[inset_0_0_0_1px_var(--border)]">
                  <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
                  <div>
                    <div className="text-sm font-medium text-text">{t('set.mcpReady')}</div>
                    <p className="mt-0.5 text-pretty text-xs text-muted">{t('set.mcpReadyHint')}</p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-sm text-text">{t('set.mcpChoose')}</div>
                    <p className="mt-0.5 text-xs text-muted">{t('set.mcpChooseHint')}</p>
                  </div>
                  <Segmented
                    ariaLabel={t('set.mcpChoose')}
                    value={mcpClient}
                    onChange={selectMcpClient}
                    items={[
                      { value: 'codex', label: 'Codex' },
                      { value: 'claude', label: 'Claude Code' },
                    ]}
                  />
                </div>

                <div className="space-y-2">
                  <p className="text-pretty text-xs text-muted">
                    {t(mcpClient === 'codex' ? 'set.mcpCodexStep' : 'set.mcpClaudeStep')}
                  </p>
                  <div className="relative">
                    <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all rounded-[12px] bg-bg p-3 pr-28 font-mono text-xs leading-relaxed shadow-[inset_0_0_0_1px_var(--border)]">
                      {mcpSetup || '…'}
                    </pre>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={copyMcp}
                      disabled={!mcpSetup}
                      className="absolute right-2 top-2"
                    >
                      {mcpCopied ? t('set.copied') : t('set.copy')}
                    </Button>
                  </div>
                  <p className="break-all text-[11px] text-muted">
                    {t('set.mcpDbHint', { path: mcp.data?.dbPath ?? '' })}
                  </p>
                  <p className="text-pretty text-xs text-muted">{t('set.mcpAfterStep')}</p>
                </div>
              </Card>

              <Card>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="t-section text-balance">{t('set.devhubTitle')}</h2>
                      <span className="rounded-full bg-surface-2 px-2 py-1 text-[11px] text-muted">
                        {t('set.optional')}
                      </span>
                    </div>
                    <p className="mt-1 text-pretty text-xs text-muted">{t('set.devhubSeparate')}</p>
                  </div>
                  {devhub.data?.connected ? (
                    <span className="inline-flex items-center gap-1.5 text-xs text-success">
                      <span className="h-1.5 w-1.5 rounded-full bg-success" />
                      {t('set.devhubConnected', { name: devhub.data.serverName ?? 'devhub' })}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                      <span className="h-1.5 w-1.5 rounded-full bg-muted" />
                      {t('set.devhubNotConnected')}
                    </span>
                  )}
                </div>
                <details className="group text-xs text-muted">
                  <summary className="tap flex min-h-10 cursor-pointer select-none items-center gap-2 rounded-[var(--radius)] text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
                    <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
                    {t('set.devhubHow')}
                  </summary>
                  <ol className="mt-1 list-decimal space-y-1 pl-6 text-pretty">
                    <li>{t('set.devhub1')}</li>
                    <li>{t('set.devhub2')}</li>
                    <li>{t('set.devhub3')}</li>
                    <li>{t('set.devhub4')}</li>
                  </ol>
                </details>
              </Card>

              <Card title={t('set.connectors')}>
                <p className="text-pretty text-xs text-muted">{t('set.connectorsHint')}</p>
                <div className="overflow-hidden rounded-[12px] bg-bg shadow-[inset_0_0_0_1px_var(--border)]">
                  {PROVIDERS.map((provider, index) => {
                    const providerSpend = spend.data?.find((item) => item.provider === provider.provider)
                    const configured = keyStatus.data?.[provider.provider] ?? false
                    const expanded = openConnector === provider.provider
                    return (
                      <div
                        key={provider.provider}
                        className={cn(
                          index > 0 && 'border-t border-border',
                          requestedConnector === provider.provider && 'bg-accent/5',
                        )}
                      >
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-controls={`connector-${provider.provider}`}
                          onClick={() => toggleConnector(provider.provider)}
                          className="tap flex min-h-12 w-full items-center gap-3 px-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60"
                        >
                          <span className="min-w-0 flex-1 truncate text-sm text-text">{provider.label}</span>
                          {provider.paid && (
                            <span className="nums hidden text-[11px] text-muted sm:inline">
                              {t('set.spentToday', { n: (providerSpend?.todayCostUsd ?? 0).toFixed(3) })}
                            </span>
                          )}
                          <span className={cn('text-[11px]', configured ? 'text-success' : 'text-muted')}>
                            {t(configured ? 'set.connectorConfigured' : 'set.connectorNotConfigured')}
                          </span>
                          <ChevronDown
                            className={cn('h-4 w-4 shrink-0 text-muted transition-transform', expanded && 'rotate-180')}
                          />
                        </button>
                        {expanded && (
                          <div id={`connector-${provider.provider}`} className="space-y-2 px-3 pb-3">
                            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
                              <input
                                type="password"
                                className={fieldCls}
                                autoFocus={requestedConnector === provider.provider}
                                value={keys[provider.provider] ?? ''}
                                onChange={(event) =>
                                  setKeys((current) => ({
                                    ...current,
                                    [provider.provider]: event.target.value,
                                  }))
                                }
                                placeholder={t('set.apiKey')}
                              />
                              <Button
                                size="sm"
                                onClick={() => saveKey.mutate(provider.provider)}
                                disabled={!keys[provider.provider]?.trim() || saveKey.isPending}
                              >
                                {t('set.save')}
                              </Button>
                            </div>
                            {provider.provider === 'steamfinancial' && (
                              <p className="text-pretty text-[11px] leading-relaxed text-muted">
                                {t('set.steamFinancialHint')}
                              </p>
                            )}
                            {provider.provider === 'gmass' && (
                              <p className="text-pretty text-[11px] leading-relaxed text-muted">{t('set.gmassHint')}</p>
                            )}
                            {provider.paid && (
                              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                                <span className="nums sm:hidden">
                                  {t('set.spentToday', { n: (providerSpend?.todayCostUsd ?? 0).toFixed(3) })}
                                </span>
                                <label className="ml-auto flex items-center gap-1">
                                  {t('set.dailyBudget')}
                                  <input
                                    type="number"
                                    step="0.01"
                                    min="0"
                                    defaultValue={providerSpend?.dailyBudgetUsd ?? ''}
                                    onBlur={(event) =>
                                      setBudget.mutate({
                                        provider: provider.provider,
                                        dailyBudgetUsd: event.target.value ? Number(event.target.value) : null,
                                      })
                                    }
                                    className={cn(fieldCls, 'w-24')}
                                  />
                                </label>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </Card>
            </>
          )}

          {activeTab === 'data' && (
            <Card title={t('set.backups')}>
              <p className="text-xs text-muted">{t('set.backupsHint')}</p>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => makeBackup.mutate()} disabled={makeBackup.isPending}>
                  {t('set.backupNow')}
                </Button>
                {backups.data?.dir && (
                  <Button size="sm" variant="outline" onClick={() => window.marcat?.openBackupsFolder()}>
                    {t('set.openFolder')}
                  </Button>
                )}
              </div>
              {backupMsg && <p className="break-all text-xs text-accent">{backupMsg}</p>}
              {restored && (
                <div className="flex items-center gap-2 rounded-[var(--radius)] border border-warning/40 bg-warning/5 px-2 py-1.5 text-xs">
                  <span className="flex-1">{t('set.restoreStaged')}</span>
                  <Button size="sm" onClick={() => window.marcat?.relaunch()}>
                    {t('set.restartNow')}
                  </Button>
                </div>
              )}
              {backups.isError && <QueryError error={backups.error} onRetry={() => void backups.refetch()} />}
              {backups.isLoading && <LoadingState />}
              {backups.data && backups.data.backups.length === 0 ? (
                <p className="text-xs text-muted">{t('set.noBackups')}</p>
              ) : (
                <div className="space-y-1">
                  {(backups.data?.backups ?? []).map((b) => (
                    <div key={b.path} className="flex items-center gap-2 text-xs text-muted">
                      <span className="nums flex-1 truncate">
                        {b.at.slice(0, 16).replace('T', ' ')} · {b.sizeKb} KB
                      </span>
                      <button
                        onClick={() => askRestore(b.path)}
                        disabled={restore.isPending}
                        className="tap rounded-[var(--radius)] px-1.5 py-0.5 text-accent transition-colors hover:bg-surface-2 hover:underline disabled:opacity-50"
                      >
                        {t('set.restore')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          )}
        </main>
      </div>

      <WhatsNewDialog
        open={whatsNewOpen}
        version={release.data?.version ?? '0.0.0'}
        changelog={release.data?.changelog ?? ''}
        onClose={() => setWhatsNewOpen(false)}
      />
    </div>
  )
}
