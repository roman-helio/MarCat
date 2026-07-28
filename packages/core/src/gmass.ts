import { createHash } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import {
  creatorPicks,
  creators,
  events,
  games,
  gmassCampaigns,
  gmassRecipients,
  type DB,
  type GmassCampaign,
  type GmassRecipient,
} from '@marcat/db'
import type { SecretsStore } from './context'

export const GMASS_ADDRESS_CATEGORIES = ['verified_business', 'business', 'manager', 'other', 'gated'] as const
export type GmassAddressCategory = (typeof GMASS_ADDRESS_CATEGORIES)[number]

type Contact = { type?: string; value?: string; verified?: boolean; gated?: boolean }

export interface GmassPreviewInput {
  gameId: string
  creatorIds?: string[]
  addressCategories: GmassAddressCategory[]
  subject: string
  body: string
}

export interface GmassPreviewRecipient {
  creatorId: string
  creatorName: string
  email: string
  addressCategory: GmassAddressCategory
  verified: boolean
  keys: string[]
  subject: string
  body: string
}

export interface GmassPreviewResult {
  game: { id: string; name: string }
  recipients: GmassPreviewRecipient[]
  excluded: { creatorId: string; creatorName: string; reason: string }[]
  contentHash: string
}

const now = () => new Date().toISOString()
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function parseArray(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value)
      ? value
          .map(String)
          .map((item) => item.trim())
          .filter(Boolean)
      : []
  } catch {
    return []
  }
}

function parseContacts(raw: string | null): Contact[] {
  if (!raw) return []
  try {
    const value = JSON.parse(raw)
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function contactCategory(contact: Contact): GmassAddressCategory {
  if (contact.gated) return 'gated'
  const type = String(contact.type ?? '').toLowerCase()
  if (type === 'manager') return 'manager'
  if (contact.verified && ['business_email', 'email'].includes(type)) return 'verified_business'
  if (type === 'business_email') return 'business'
  return 'other'
}

const categoryPriority: Record<GmassAddressCategory, number> = {
  verified_business: 0,
  business: 1,
  manager: 2,
  other: 3,
  gated: 4,
}

export function renderGmassTemplate(
  template: string,
  values: { creatorName: string; gameName: string; gameKeys: string; channel: string; email: string },
): string {
  return template.replace(
    /{{\s*(creatorName|gameName|gameKeys|channel|email)\s*}}/g,
    (_match, key: keyof typeof values) => values[key] ?? '',
  )
}

export async function previewGmassCampaign(db: DB, input: GmassPreviewInput): Promise<GmassPreviewResult> {
  const game = (await db.select({ id: games.id, name: games.name }).from(games).where(eq(games.id, input.gameId)))[0]
  if (!game) throw new Error('Game not found')
  const picks = await db.select().from(creatorPicks).where(eq(creatorPicks.gameId, input.gameId))
  const scoped = input.creatorIds?.length ? picks.filter((pick) => input.creatorIds!.includes(pick.creatorId)) : picks
  const creatorIds = scoped.map((pick) => pick.creatorId)
  const rows = creatorIds.length ? await db.select().from(creators).where(inArray(creators.id, creatorIds)) : []
  const byPick = new Map(scoped.map((pick) => [pick.creatorId, pick]))
  const categories = new Set(input.addressCategories)
  const recipients: GmassPreviewRecipient[] = []
  const excluded: GmassPreviewResult['excluded'] = []
  const usedEmails = new Set<string>()

  for (const creator of rows) {
    if (creator.doNotContact) {
      excluded.push({ creatorId: creator.id, creatorName: creator.name, reason: 'do_not_contact' })
      continue
    }
    const candidates = parseContacts(creator.contactsJson)
      .map((contact) => ({ contact, category: contactCategory(contact) }))
      .filter(({ contact, category }) => {
        const email = String(contact.value ?? '')
          .trim()
          .toLowerCase()
        return categories.has(category) && emailPattern.test(email)
      })
      .sort((a, b) => categoryPriority[a.category] - categoryPriority[b.category])
    const selected = candidates[0]
    if (!selected) {
      excluded.push({ creatorId: creator.id, creatorName: creator.name, reason: 'no_matching_email' })
      continue
    }
    const email = String(selected.contact.value).trim().toLowerCase()
    if (usedEmails.has(email)) {
      excluded.push({ creatorId: creator.id, creatorName: creator.name, reason: 'duplicate_email' })
      continue
    }
    usedEmails.add(email)
    const keys = parseArray(byPick.get(creator.id)?.keysSentJson)
    const values = {
      creatorName: creator.name,
      gameName: game.name,
      gameKeys: keys.join('\n'),
      channel: creator.handle ?? creator.primaryPlatform ?? '',
      email,
    }
    recipients.push({
      creatorId: creator.id,
      creatorName: creator.name,
      email,
      addressCategory: selected.category,
      verified: !!selected.contact.verified,
      keys,
      subject: renderGmassTemplate(input.subject, values),
      body: renderGmassTemplate(input.body, values),
    })
  }

  const contentHash = createHash('sha256')
    .update(JSON.stringify({ gameId: input.gameId, categories: [...categories].sort(), recipients }))
    .digest('hex')
  return { game, recipients, excluded, contentHash }
}

const GMASS_API = 'https://api.gmass.co/api'

async function gmassRequest<T>(apiKey: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${GMASS_API}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      'X-apikey': apiKey,
      ...(init.headers ?? {}),
    },
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`GMass ${response.status}: ${body.slice(0, 500) || response.statusText}`)
  }
  return (await response.json()) as T
}

type DraftResponse = { campaignDraftId?: string }
type CampaignResponse = { campaignId?: number; status?: string }
type ReportResponse = { data?: Record<string, unknown>[] }

function reportTime(row: Record<string, unknown>, names: string[]): string {
  for (const name of names) if (typeof row[name] === 'string' && row[name]) return String(row[name])
  return now()
}

function reportHasEmail(report: ReportResponse, email: string): Record<string, unknown> | undefined {
  return report.data?.find(
    (row) => String(row.emailAddress ?? row.EmailAddress ?? '').toLowerCase() === email.toLowerCase(),
  )
}

async function insertActivityOnce(
  db: DB,
  campaign: GmassCampaign,
  recipient: GmassRecipient,
  kind: 'send' | 'reply',
  occurredAt: string,
): Promise<void> {
  const externalId = `gmass:${recipient.gmassCampaignId}:${kind}:${recipient.email}`
  const existing = await db.select({ id: events.id }).from(events).where(eq(events.externalId, externalId)).limit(1)
  if (existing.length) return
  const creator = (
    await db.select({ name: creators.name }).from(creators).where(eq(creators.id, recipient.creatorId))
  )[0]
  await db.insert(events).values({
    gameId: campaign.gameId,
    occurredAt: occurredAt.slice(0, 10),
    subjectType: 'creator',
    subjectId: recipient.creatorId,
    subjectLabel: creator?.name ?? null,
    showOnWishlist: false,
    direction: kind === 'send' ? 'outbound' : 'inbound',
    channel: 'email',
    statusAfter: kind === 'send' ? 'contacted' : 'replied',
    type: 'other',
    title: kind === 'send' ? recipient.subject : 'Reply received via GMass',
    description: kind === 'send' ? recipient.body : '',
    isOwn: kind === 'send',
    creatorId: recipient.creatorId,
    sourceId: 'gmass',
    externalId,
    createdBy: 'source',
  })
  const pick = (
    await db
      .select({ status: creatorPicks.pipelineStatus })
      .from(creatorPicks)
      .where(and(eq(creatorPicks.gameId, campaign.gameId), eq(creatorPicks.creatorId, recipient.creatorId)))
  )[0]
  if (!pick) return
  if (kind === 'send' && pick.status === 'prospect') {
    await db
      .update(creatorPicks)
      .set({ pipelineStatus: 'contacted' })
      .where(and(eq(creatorPicks.gameId, campaign.gameId), eq(creatorPicks.creatorId, recipient.creatorId)))
  }
  if (kind === 'reply' && ['prospect', 'contacted'].includes(pick.status)) {
    await db
      .update(creatorPicks)
      .set({ pipelineStatus: 'replied' })
      .where(and(eq(creatorPicks.gameId, campaign.gameId), eq(creatorPicks.creatorId, recipient.creatorId)))
  }
}

async function dispatchCampaign(db: DB, campaign: GmassCampaign, apiKey: string): Promise<void> {
  const recipients = await db.select().from(gmassRecipients).where(eq(gmassRecipients.campaignId, campaign.id))
  await db
    .update(gmassCampaigns)
    .set({ status: 'processing', error: null, updatedAt: now() })
    .where(eq(gmassCampaigns.id, campaign.id))
  let failures = 0
  for (const recipient of recipients) {
    if (!['prepared', 'failed'].includes(recipient.status)) continue
    try {
      const draft = await gmassRequest<DraftResponse>(apiKey, '/campaigndrafts', {
        method: 'POST',
        body: JSON.stringify({
          fromEmail: campaign.fromEmail,
          subject: recipient.subject,
          message: recipient.body,
          messageType: campaign.messageType,
          emailAddresses: recipient.email,
        }),
      })
      if (!draft.campaignDraftId) throw new Error('GMass did not return campaignDraftId')
      await db
        .update(gmassRecipients)
        .set({ gmassDraftId: draft.campaignDraftId, status: 'drafted', error: null, updatedAt: now() })
        .where(eq(gmassRecipients.id, recipient.id))
      if (campaign.sendMode === 'draft') continue
      const remote = await gmassRequest<CampaignResponse>(
        apiKey,
        `/campaigns/${encodeURIComponent(draft.campaignDraftId)}`,
        {
          method: 'POST',
          body: JSON.stringify({
            openTracking: campaign.openTracking,
            clickTracking: campaign.clickTracking,
            ...(campaign.sendMode === 'schedule' && campaign.sendAt ? { sendTime: campaign.sendAt } : {}),
            friendlyName: `MarCat:${campaign.id}:${recipient.id}`,
            emailsPerDay: campaign.emailsPerDay ?? undefined,
            skipWeekends: true,
            createDrafts: false,
            verify: true,
          }),
        },
      )
      if (!remote.campaignId) throw new Error('GMass did not return campaignId')
      await db
        .update(gmassRecipients)
        .set({
          gmassCampaignId: remote.campaignId,
          remoteStatus: remote.status ?? null,
          status: campaign.sendMode === 'schedule' ? 'scheduled' : 'submitted',
          updatedAt: now(),
        })
        .where(eq(gmassRecipients.id, recipient.id))
    } catch (error) {
      failures++
      await db
        .update(gmassRecipients)
        .set({ status: 'failed', error: error instanceof Error ? error.message : String(error), updatedAt: now() })
        .where(eq(gmassRecipients.id, recipient.id))
    }
  }
  const status = failures
    ? failures === recipients.length
      ? 'failed'
      : 'partial_failed'
    : campaign.sendMode === 'draft'
      ? 'drafted'
      : campaign.sendMode === 'schedule'
        ? 'scheduled'
        : 'submitted'
  await db.update(gmassCampaigns).set({ status, updatedAt: now() }).where(eq(gmassCampaigns.id, campaign.id))
}

async function syncCampaign(db: DB, campaign: GmassCampaign, apiKey: string): Promise<void> {
  const recipients = await db.select().from(gmassRecipients).where(eq(gmassRecipients.campaignId, campaign.id))
  for (const recipient of recipients) {
    if (!recipient.gmassCampaignId) continue
    try {
      const id = recipient.gmassCampaignId
      const [remote, sent, opens, clicks, replies, bounces, unsubscribes] = await Promise.all([
        gmassRequest<CampaignResponse>(apiKey, `/campaigns/${id}`),
        gmassRequest<ReportResponse>(apiKey, `/reports/${id}/recipients?limit=100`),
        gmassRequest<ReportResponse>(apiKey, `/reports/${id}/opens?limit=100`),
        gmassRequest<ReportResponse>(apiKey, `/reports/${id}/clicks?limit=100`),
        gmassRequest<ReportResponse>(apiKey, `/reports/${id}/replies?limit=100`),
        gmassRequest<ReportResponse>(apiKey, `/reports/${id}/bounces?limit=100`),
        gmassRequest<ReportResponse>(apiKey, `/reports/${id}/unsubscribes?limit=100`),
      ])
      const sentRow = reportHasEmail(sent, recipient.email)
      const openRow = reportHasEmail(opens, recipient.email)
      const clickRow = reportHasEmail(clicks, recipient.email)
      const replyRow = reportHasEmail(replies, recipient.email)
      const bounceRow = reportHasEmail(bounces, recipient.email)
      const unsubscribeRow = reportHasEmail(unsubscribes, recipient.email)
      const sentAt = sentRow ? reportTime(sentRow, ['sentTime', 'TimeStamp']) : recipient.sentAt
      const repliedAt = replyRow ? reportTime(replyRow, ['replyTime', 'TimeStamp']) : recipient.repliedAt
      const bouncedAt = bounceRow ? reportTime(bounceRow, ['bounceTime', 'TimeStamp']) : recipient.bouncedAt
      const unsubscribedAt = unsubscribeRow
        ? reportTime(unsubscribeRow, ['unsubscribeTime', 'TimeStamp'])
        : recipient.unsubscribedAt
      const status = unsubscribedAt
        ? 'unsubscribed'
        : bouncedAt
          ? 'bounced'
          : repliedAt
            ? 'replied'
            : sentAt
              ? 'sent'
              : recipient.status
      await db
        .update(gmassRecipients)
        .set({
          remoteStatus: remote.status ?? recipient.remoteStatus,
          status,
          sentAt,
          openedAt: openRow ? reportTime(openRow, ['openTime', 'TimeStamp']) : recipient.openedAt,
          clickedAt: clickRow ? reportTime(clickRow, ['clickTime', 'TimeStamp']) : recipient.clickedAt,
          repliedAt,
          bouncedAt,
          unsubscribedAt,
          error: null,
          updatedAt: now(),
        })
        .where(eq(gmassRecipients.id, recipient.id))
      if (sentAt) await insertActivityOnce(db, campaign, recipient, 'send', sentAt)
      if (repliedAt) await insertActivityOnce(db, campaign, recipient, 'reply', repliedAt)
    } catch (error) {
      await db
        .update(gmassRecipients)
        .set({ error: error instanceof Error ? error.message : String(error), updatedAt: now() })
        .where(eq(gmassRecipients.id, recipient.id))
    }
  }
  await db
    .update(gmassCampaigns)
    .set({ lastSyncedAt: now(), syncRequestedAt: null, updatedAt: now() })
    .where(eq(gmassCampaigns.id, campaign.id))
}

let workerRunning = false

export async function processGmassQueue(db: DB, secrets?: SecretsStore): Promise<void> {
  if (workerRunning) return
  const apiKey = secrets?.getApiKey('gmass')
  if (!apiKey) return
  workerRunning = true
  try {
    const queued = await db.select().from(gmassCampaigns).where(eq(gmassCampaigns.status, 'queued'))
    for (const campaign of queued) await dispatchCampaign(db, campaign, apiKey)
    const campaigns = await db.select().from(gmassCampaigns)
    for (const campaign of campaigns) {
      if (['submitted', 'scheduled', 'partial_failed'].includes(campaign.status) || campaign.syncRequestedAt) {
        await syncCampaign(db, campaign, apiKey)
      }
    }
  } finally {
    workerRunning = false
  }
}
