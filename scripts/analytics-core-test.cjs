const assert = require('node:assert/strict')
const {
  buildCampaignHighlights,
  campaignKeyOf,
  computeImpact,
  parseAnalyticsCsv,
  resolveWishlistBalance,
  summarizeUtm,
  summarizeManagedCampaigns,
  wilsonLowerBound,
} = require('../packages/core/dist/index.cjs')

assert.equal(
  resolveWishlistBalance([{ balance: 100 }, { adds: 12, deletes: 2, purchasesAndActivations: 3, gifts: 1 }]),
  106,
  'converted wishlists must leave the outstanding balance',
)

const parsed = parseAnalyticsCsv(
  [
    'Date,Source,Campaign,Medium,Content,Keyword,Visits,Trusted Visits,Tracked Visits,Wishlists,Purchases,Activations',
    '2026-07-20,reddit,reveal,social,trailer,family,10,9,8,3,1,0',
    '2026-07-21,reddit,reveal,social,trailer,family,broken,7,6,2,0,0',
  ].join('\n'),
  'utm_1_all_20260720_20260721_daily.csv',
)
assert.equal(parsed.kind, 'utm_daily')
assert.equal(parsed.rows[0].term, 'family')
assert.equal(parsed.warnings.length, 1, 'invalid numeric cells must be surfaced')

const row = (overrides) => ({
  date: null,
  source: 'reddit',
  campaign: '',
  medium: 'social',
  content: '',
  term: '',
  country: null,
  device: null,
  visits: 0,
  trustedVisits: 0,
  trackedVisits: 0,
  returningVisits: 0,
  wishlists: 0,
  purchases: 0,
  activations: 0,
  ...overrides,
})
const summary = summarizeUtm([
  row({ source: 'Reddit', campaign: 'Reveal', trustedVisits: 20, trackedVisits: 8, wishlists: 4 }),
  row({ source: ' reddit ', campaign: ' reveal ', trustedVisits: 10, trackedVisits: 4, wishlists: 2 }),
  row({ campaign: 'scale', trustedVisits: 156, trackedVisits: 50, wishlists: 22 }),
  row({ campaign: 'city', trustedVisits: 56, trackedVisits: 22, wishlists: 13 }),
  row({ campaign: 'tiny', trustedVisits: 11, trackedVisits: 2, wishlists: 2 }),
])
assert.equal(summary.campaigns.length, 4, 'UTM casing and whitespace variants should group together')
assert.ok(wilsonLowerBound(13, 22) > wilsonLowerBound(2, 2), 'small perfect samples must stay conservative')
const highlights = buildCampaignHighlights(summary.campaigns)
assert.equal(highlights.find((item) => item.kind === 'efficient_candidate').campaign, 'city')
assert.equal(
  campaignKeyOf({ source: ' Reddit ', campaign: 'Reveal', medium: 'Social', content: 'A/B', term: ' Family ' }),
  campaignKeyOf({ source: 'reddit', campaign: ' reveal ', medium: 'social', content: 'a/b', term: 'family' }),
  'campaign keys must be stable across casing and whitespace',
)
assert.notEqual(
  campaignKeyOf({ source: 'reddit', campaign: 'reveal', medium: 'social', content: 'a/b', term: '' }),
  campaignKeyOf({ source: 'reddit', campaign: 'reveal', medium: 'social', content: 'ab', term: '' }),
  'campaign keys must preserve meaningful punctuation',
)
const managedPlan = {
  id: 'managed-1',
  name: 'Reveal launch',
  objective: 'wishlist_growth',
  status: 'active',
  plannedStart: '2026-07-20',
  plannedEnd: '2026-07-30',
  evaluationWindowDays: 3,
  budgetCents: 20_000,
  spendCents: 10_000,
  currency: 'USD',
  notes: null,
}
const linkedRows = summary.campaigns.filter((item) => item.campaign === 'scale' || item.campaign === 'city')
const managedPoints = linkedRows.map((item, index) => ({
  id: `point-${index}`,
  campaignId: managedPlan.id,
  canonicalKey: item.key,
  source: item.source,
  campaign: item.campaign,
  medium: item.medium,
  content: item.content,
  term: item.term,
  eventId: null,
}))
const managed = summarizeManagedCampaigns([managedPlan], managedPoints, summary.campaigns, true)[0]
assert.equal(managed.performance.wishlists, 35, 'managed campaign should aggregate all linked UTM touchpoints')
assert.equal(managed.costPerWishlistCents, 10_000 / 35)
assert.equal(managed.budgetUtilization, 0.5)
assert.equal(
  summarizeManagedCampaigns([managedPlan], managedPoints, summary.campaigns, false)[0].costPerWishlistCents,
  null,
  'whole-campaign spend must not be divided by a partial date-range result',
)

const date = (day) => `2026-07-${String(day).padStart(2, '0')}`
const points = []
for (let day = 1; day <= 14; day++)
  points.push({ date: date(day), adds: 10, deletes: 0, purchasesAndActivations: 0, gifts: 0 })
for (let day = 15; day <= 17; day++)
  points.push({ date: date(day), adds: 31, deletes: 1, purchasesAndActivations: 0, gifts: 0 })
const event = (id, day) => ({ id, occurredAt: date(day), title: id, platform: 'reddit', type: 'post' })
const single = computeImpact([event('single', 15)], points).impacts[0]
assert.equal(single.classification, 'above_expected')
assert.equal(single.netAfter, 90)
const overlapping = computeImpact([event('first', 15), event('second', 16)], points).impacts[0]
assert.equal(overlapping.classification, 'joint_effect')
const pending = computeImpact([event('pending', 17)], points).impacts[0]
assert.equal(pending.classification, 'pending')
const withGap = computeImpact(
  [event('gap', 15)],
  points.filter((point) => point.date !== '2026-07-16'),
).impacts[0]
assert.equal(withGap.classification, 'insufficient', 'a missing completed day must not be treated as zero')

console.log('analytics core tests passed')
