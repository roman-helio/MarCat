import { and, desc, eq } from 'drizzle-orm'
import { gmassCampaigns, gmassRecipients } from '@marcat/db'
import { z } from 'zod'
import { router, publicProcedure } from '../trpc'
import { GMASS_ADDRESS_CATEGORIES, previewGmassCampaign, processGmassQueue, type GmassAddressCategory } from '../gmass'

const addressCategory = z.enum(GMASS_ADDRESS_CATEGORIES)
const sendMode = z.enum(['draft', 'send', 'schedule'])
const previewInput = z.object({
  gameId: z.string(),
  creatorIds: z.array(z.string()).optional(),
  addressCategories: z.array(addressCategory).min(1),
  subject: z.string().min(1),
  body: z.string().min(1),
})

const createInput = previewInput.extend({
  name: z.string().min(1).max(160),
  fromEmail: z.string().email(),
  messageType: z.enum(['plain', 'html']).default('plain'),
  sendMode,
  sendAt: z.string().nullish(),
  openTracking: z.boolean().default(true),
  clickTracking: z.boolean().default(true),
  emailsPerDay: z.number().int().positive().max(2000).nullish(),
  requestedBy: z.enum(['manual', 'mcp', 'ai']).default('manual'),
})

export const gmassRouter = router({
  keyStatus: publicProcedure.query(({ ctx }) => ({ configured: !!ctx.secrets?.getApiKey('gmass') })),

  setApiKey: publicProcedure.input(z.object({ key: z.string() })).mutation(({ ctx, input }) => {
    ctx.secrets?.setApiKey('gmass', input.key.trim() || null)
    return { ok: true }
  }),

  preview: publicProcedure.input(previewInput).query(({ ctx, input }) => previewGmassCampaign(ctx.db, input)),

  create: publicProcedure.input(createInput).mutation(async ({ ctx, input }) => {
    if (input.sendMode === 'schedule' && !input.sendAt) throw new Error('sendAt is required for scheduled campaigns')
    const preview = await previewGmassCampaign(ctx.db, input)
    if (!preview.recipients.length) throw new Error('No eligible recipients for the selected address categories')
    return ctx.db.transaction(async (tx) => {
      const rows = await tx
        .insert(gmassCampaigns)
        .values({
          gameId: input.gameId,
          name: input.name,
          sendMode: input.sendMode,
          sendAt: input.sendAt ?? null,
          fromEmail: input.fromEmail,
          subjectTemplate: input.subject,
          bodyTemplate: input.body,
          messageType: input.messageType,
          addressCategoriesJson: JSON.stringify(input.addressCategories),
          openTracking: input.openTracking,
          clickTracking: input.clickTracking,
          emailsPerDay: input.emailsPerDay ?? null,
          requestedBy: input.requestedBy,
          recipientCount: preview.recipients.length,
          contentHash: preview.contentHash,
        })
        .returning()
      const campaign = rows[0]!
      await tx.insert(gmassRecipients).values(
        preview.recipients.map((recipient) => ({
          campaignId: campaign.id,
          creatorId: recipient.creatorId,
          email: recipient.email,
          addressCategory: recipient.addressCategory,
          verified: recipient.verified,
          keysJson: JSON.stringify(recipient.keys),
          subject: recipient.subject,
          body: recipient.body,
        })),
      )
      return { ...campaign, recipients: preview.recipients, excluded: preview.excluded }
    })
  }),

  approve: publicProcedure
    .input(
      z.object({
        id: z.string(),
        confirm: z.literal(true),
        expectedRecipientCount: z.number().int().positive(),
        contentHash: z.string().min(16),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const campaign = (await ctx.db.select().from(gmassCampaigns).where(eq(gmassCampaigns.id, input.id)))[0]
      if (!campaign) throw new Error('GMass campaign not found')
      if (!['prepared', 'failed', 'partial_failed'].includes(campaign.status)) {
        throw new Error(`Campaign cannot be approved from status ${campaign.status}`)
      }
      if (campaign.recipientCount !== input.expectedRecipientCount || campaign.contentHash !== input.contentHash) {
        throw new Error('Campaign preview changed; load it again before approving')
      }
      await ctx.db
        .update(gmassCampaigns)
        .set({
          status: 'queued',
          approvedAt: new Date().toISOString(),
          error: null,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(gmassCampaigns.id, input.id))
      if (ctx.secrets) void processGmassQueue(ctx.db, ctx.secrets).catch(() => {})
      return { id: input.id, status: 'queued' as const }
    }),

  list: publicProcedure
    .input(z.object({ gameId: z.string().optional(), limit: z.number().int().min(1).max(100).default(30) }))
    .query(async ({ ctx, input }) => {
      const rows = input.gameId
        ? await ctx.db
            .select()
            .from(gmassCampaigns)
            .where(eq(gmassCampaigns.gameId, input.gameId))
            .orderBy(desc(gmassCampaigns.createdAt))
            .limit(input.limit)
        : await ctx.db.select().from(gmassCampaigns).orderBy(desc(gmassCampaigns.createdAt)).limit(input.limit)
      const result = []
      for (const campaign of rows) {
        const recipients = await ctx.db
          .select({ status: gmassRecipients.status })
          .from(gmassRecipients)
          .where(eq(gmassRecipients.campaignId, campaign.id))
        const counts: Record<string, number> = {}
        for (const recipient of recipients) counts[recipient.status] = (counts[recipient.status] ?? 0) + 1
        result.push({ ...campaign, counts })
      }
      return result
    }),

  get: publicProcedure.input(z.object({ id: z.string() })).query(async ({ ctx, input }) => {
    const campaign = (await ctx.db.select().from(gmassCampaigns).where(eq(gmassCampaigns.id, input.id)))[0]
    if (!campaign) return null
    const recipients = await ctx.db.select().from(gmassRecipients).where(eq(gmassRecipients.campaignId, input.id))
    return { ...campaign, recipients }
  }),

  requestSync: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    await ctx.db
      .update(gmassCampaigns)
      .set({ syncRequestedAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
      .where(eq(gmassCampaigns.id, input.id))
    if (ctx.secrets) void processGmassQueue(ctx.db, ctx.secrets).catch(() => {})
    return { ok: true }
  }),

  retry: publicProcedure.input(z.object({ id: z.string() })).mutation(async ({ ctx, input }) => {
    const failed = await ctx.db
      .update(gmassRecipients)
      .set({ status: 'prepared', error: null, updatedAt: new Date().toISOString() })
      .where(and(eq(gmassRecipients.campaignId, input.id), eq(gmassRecipients.status, 'failed')))
      .returning({ id: gmassRecipients.id })
    if (!failed.length) throw new Error('GMass campaign has no failed recipients to retry')
    await ctx.db
      .update(gmassCampaigns)
      .set({ status: 'queued', error: null, updatedAt: new Date().toISOString() })
      .where(eq(gmassCampaigns.id, input.id))
    if (ctx.secrets) void processGmassQueue(ctx.db, ctx.secrets).catch(() => {})
    return { ok: true }
  }),
})

export type { GmassAddressCategory }
