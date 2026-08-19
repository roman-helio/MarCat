import { useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RefreshCw, Send, X } from 'lucide-react'
import { trpc } from '@/lib/trpc'
import { useModal } from '@/lib/modal'
import { cn, fieldCls } from '@/lib/utils'
import { toast } from '@/store/toast'
import { Button } from '@/components/ui/Button'
import { useT } from '@/i18n/useT'

const CATEGORIES = ['verified_business', 'business', 'manager', 'other', 'gated'] as const
type Category = (typeof CATEGORIES)[number]
type SendMode = 'draft' | 'send' | 'schedule'

export function GmassCampaignDialog({
  open,
  gameId,
  creatorIds,
  onClose,
}: {
  open: boolean
  gameId: string
  creatorIds: string[]
  onClose: () => void
}) {
  const t = useT()
  const ref = useRef<HTMLDivElement>(null)
  const qc = useQueryClient()
  useModal(ref, onClose, open)
  const [name, setName] = useState(`MarCat outreach ${new Date().toISOString().slice(0, 10)}`)
  const [fromEmail, setFromEmail] = useState('')
  const [subject, setSubject] = useState('{{gameName}} — game key for {{creatorName}}')
  const [body, setBody] = useState(
    'Hi {{creatorName}},\n\nI think {{gameName}} could be a good fit for your channel.\n\nYour key:\n{{gameKeys}}\n\nBest regards,',
  )
  const [categories, setCategories] = useState<Category[]>(['verified_business', 'business', 'manager'])
  const [sendMode, setSendMode] = useState<SendMode>('draft')
  const [sendAt, setSendAt] = useState('')
  const [selected, setSelected] = useState<string[]>([])

  const keyStatus = useQuery({ queryKey: ['gmass-key-status'], queryFn: () => trpc.gmass.keyStatus.query() })
  const templates = useQuery({ queryKey: ['creator-templates'], queryFn: () => trpc.creators.templates.query() })
  const campaigns = useQuery({
    queryKey: ['gmass-campaigns', gameId],
    queryFn: () => trpc.gmass.list.query({ gameId, limit: 8 }),
    enabled: open,
    refetchInterval: open ? 5000 : false,
  })
  const preview = useMutation({
    mutationFn: () => trpc.gmass.preview.query({ gameId, creatorIds, addressCategories: categories, subject, body }),
    onSuccess: (result) => setSelected(result.recipients.map((recipient) => recipient.creatorId)),
    onError: toast.fromError,
  })
  const organize = useMutation({
    mutationFn: async () => {
      const campaign = await trpc.gmass.create.mutate({
        gameId,
        creatorIds: selected,
        addressCategories: categories,
        subject,
        body,
        name: name.trim(),
        fromEmail: fromEmail.trim(),
        messageType: 'plain',
        sendMode,
        sendAt: sendMode === 'schedule' ? new Date(sendAt).toISOString() : null,
        openTracking: true,
        clickTracking: true,
        emailsPerDay: null,
        requestedBy: 'manual',
      })
      await trpc.gmass.approve.mutate({
        id: campaign.id,
        confirm: true,
        expectedRecipientCount: campaign.recipientCount,
        contentHash: campaign.contentHash,
      })
      return campaign
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['gmass-campaigns', gameId] })
      toast.success(t('gmass.queued'))
      onClose()
    },
    onError: toast.fromError,
  })
  const sync = useMutation({
    mutationFn: (id: string) => trpc.gmass.requestSync.mutate({ id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['gmass-campaigns', gameId] }),
    onError: toast.fromError,
  })

  if (!open) return null
  const toggleCategory = (category: Category) => {
    setCategories((current) =>
      current.includes(category) ? current.filter((item) => item !== category) : [...current, category],
    )
    preview.reset()
  }
  const toggleRecipient = (creatorId: string) =>
    setSelected((current) =>
      current.includes(creatorId) ? current.filter((id) => id !== creatorId) : [...current, creatorId],
    )
  const canOrganize =
    !!keyStatus.data?.configured &&
    !!preview.data &&
    selected.length > 0 &&
    !!name.trim() &&
    !!fromEmail.trim() &&
    (sendMode !== 'schedule' || !!sendAt)

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="gmass-dialog-title"
        className="enter flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-[20px] bg-surface p-4 shadow-hard"
      >
        <header className="flex items-start gap-3 border-b border-border pb-3">
          <div className="min-w-0 flex-1">
            <h2 id="gmass-dialog-title" className="text-balance t-title">
              {t('gmass.organize')}
            </h2>
            <p className="mt-1 text-pretty text-sm text-muted">{t('gmass.intro')}</p>
          </div>
          <Button size="icon" variant="ghost" aria-label={t('common.close')} onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="mt-3 grid min-h-0 flex-1 gap-4 overflow-y-auto pr-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(280px,0.85fr)]">
          <div className="space-y-4">
            {!keyStatus.data?.configured && (
              <div className="rounded-[10px] bg-warning/10 px-3 py-2 text-sm text-warning shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--warning)_25%,transparent)]">
                {t('gmass.noKey')}{' '}
                <Link className="underline underline-offset-2" to="/settings?connector=gmass" onClick={onClose}>
                  {t('gmass.openSettings')}
                </Link>
              </div>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 t-hint">
                {t('gmass.name')}
                <input className={fieldCls} value={name} onChange={(event) => setName(event.target.value)} />
              </label>
              <label className="flex flex-col gap-1 t-hint">
                {t('gmass.fromEmail')}
                <input
                  type="email"
                  className={fieldCls}
                  value={fromEmail}
                  onChange={(event) => setFromEmail(event.target.value)}
                  placeholder="you@studio.com"
                />
              </label>
            </div>

            <div className="space-y-2">
              <div className="t-hint">{t('gmass.categories')}</div>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {CATEGORIES.map((category) => (
                  <label
                    key={category}
                    className="flex min-h-10 items-center gap-2 rounded-[10px] bg-surface-2 px-3 text-sm hover:bg-surface-3"
                  >
                    <input
                      type="checkbox"
                      checked={categories.includes(category)}
                      onChange={() => toggleCategory(category)}
                    />
                    {t(`gmass.category.${category}`)}
                  </label>
                ))}
              </div>
            </div>

            {(templates.data ?? []).length > 0 && (
              <label className="flex flex-col gap-1 t-hint">
                {t('gmass.template')}
                <select
                  className={fieldCls}
                  defaultValue=""
                  onChange={(event) => {
                    const template = templates.data?.find((item) => item.id === event.target.value)
                    if (!template) return
                    setSubject(template.subject)
                    setBody(template.body)
                    preview.reset()
                  }}
                >
                  <option value="">{t('gmass.templateCustom')}</option>
                  {templates.data?.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </label>
            )}

            <label className="flex flex-col gap-1 t-hint">
              {t('gmass.subject')}
              <input
                className={fieldCls}
                value={subject}
                onChange={(event) => {
                  setSubject(event.target.value)
                  preview.reset()
                }}
              />
            </label>
            <label className="flex flex-col gap-1 t-hint">
              {t('gmass.body')}
              <textarea
                rows={8}
                className={cn(fieldCls, 'resize-y leading-relaxed')}
                value={body}
                onChange={(event) => {
                  setBody(event.target.value)
                  preview.reset()
                }}
              />
            </label>
            <p className="font-mono t-caption leading-relaxed text-muted">{t('gmass.variables')}</p>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 t-hint">
                {t('gmass.mode')}
                <select
                  className={fieldCls}
                  value={sendMode}
                  onChange={(event) => setSendMode(event.target.value as SendMode)}
                >
                  <option value="draft">{t('gmass.mode.draft')}</option>
                  <option value="send">{t('gmass.mode.send')}</option>
                  <option value="schedule">{t('gmass.mode.schedule')}</option>
                </select>
              </label>
              {sendMode === 'schedule' && (
                <label className="flex flex-col gap-1 t-hint">
                  {t('gmass.sendAt')}
                  <input
                    type="datetime-local"
                    className={fieldCls}
                    value={sendAt}
                    onChange={(event) => setSendAt(event.target.value)}
                  />
                </label>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
              <Button
                variant="outline"
                onClick={() => preview.mutate()}
                disabled={!categories.length || !subject.trim() || !body.trim() || preview.isPending}
              >
                {t('gmass.preview')}
              </Button>
              <Button onClick={() => organize.mutate()} disabled={!canOrganize || organize.isPending}>
                <Send className="h-4 w-4" />
                {t('gmass.approve')}
              </Button>
              {preview.data && (
                <span className="nums text-xs text-muted">
                  {t('gmass.previewCount', { n: selected.length, excluded: preview.data.excluded.length })}
                </span>
              )}
            </div>
          </div>

          <aside className="min-w-0 space-y-4">
            <section className="space-y-2">
              <h3 className="t-section">{t('gmass.recipients')}</h3>
              {!preview.data ? (
                <p className="text-pretty text-sm text-muted">{t('gmass.previewEmpty')}</p>
              ) : preview.data.recipients.length === 0 ? (
                <p className="text-sm text-muted">{t('gmass.noRecipients')}</p>
              ) : (
                <div className="space-y-2">
                  {preview.data.recipients.map((recipient) => (
                    <details
                      key={recipient.creatorId}
                      className="min-w-0 rounded-[10px] bg-surface-2 px-3 py-2 text-sm"
                    >
                      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2">
                        <input
                          type="checkbox"
                          checked={selected.includes(recipient.creatorId)}
                          onClick={(event) => event.stopPropagation()}
                          onChange={() => toggleRecipient(recipient.creatorId)}
                        />
                        <span className="min-w-0 flex-1 truncate font-medium">{recipient.creatorName}</span>
                        <span className="max-w-36 truncate text-xs text-muted">{recipient.email}</span>
                      </summary>
                      <div className="min-w-0 space-y-2 border-t border-border pt-2 text-xs">
                        <div className="break-words font-medium [overflow-wrap:anywhere]">{recipient.subject}</div>
                        <pre className="max-w-full break-words whitespace-pre-wrap font-sans text-muted [overflow-wrap:anywhere]">
                          {recipient.body}
                        </pre>
                      </div>
                    </details>
                  ))}
                </div>
              )}
              {(preview.data?.excluded.length ?? 0) > 0 && (
                <details className="text-sm text-muted">
                  <summary className="min-h-10 cursor-pointer py-2">
                    {t('gmass.excluded', { n: preview.data!.excluded.length })}
                  </summary>
                  <ul className="space-y-1 pl-4 text-xs">
                    {preview.data!.excluded.map((item) => (
                      <li key={item.creatorId} className="break-words [overflow-wrap:anywhere]">
                        {item.creatorName} — {t(`gmass.exclude.${item.reason}` as 'gmass.exclude.do_not_contact')}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </section>

            <section className="space-y-2 border-t border-border pt-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="t-section">{t('gmass.recent')}</h3>
                <Button size="icon" variant="ghost" aria-label={t('gmass.sync')} onClick={() => campaigns.refetch()}>
                  <RefreshCw className="h-4 w-4" />
                </Button>
              </div>
              {(campaigns.data ?? []).length === 0 ? (
                <p className="text-sm text-muted">{t('gmass.noCampaigns')}</p>
              ) : (
                <div className="space-y-1.5">
                  {campaigns.data?.map((campaign) => (
                    <div
                      key={campaign.id}
                      className="flex min-h-10 items-center gap-2 rounded-[10px] bg-surface-2 px-3 py-2 text-xs"
                    >
                      <span className="min-w-0 flex-1 truncate">{campaign.name}</span>
                      <span className="nums text-muted">{campaign.recipientCount}</span>
                      <span className="rounded bg-bg px-1.5 py-0.5 text-muted">
                        {t(`gmass.status.${campaign.status}` as 'gmass.status.prepared')}
                      </span>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={t('gmass.sync')}
                        onClick={() => sync.mutate(campaign.id)}
                      >
                        <RefreshCw className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </aside>
        </div>
      </div>
    </div>,
    document.body,
  )
}
