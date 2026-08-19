/* Headless end-to-end smoke test of the data + tRPC router path (no Electron). */
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const {
  addRecurrence,
  appRouter,
  backfillTaskDescriptionMarkdown,
  computeImpact,
  processGmassQueue,
} = require('@marcat/core')
const { createDb, fileUrlFromPath, runMigrations, backfillTaskKeys, schema } = require('@marcat/db')

function assertImpactModel() {
  const point = (date, adds) => ({ date, adds })
  const event = (id, occurredAt) => ({ id, occurredAt, title: id, platform: 'steam', type: 'post' })
  const stableHistory = [
    point('2026-07-13', 100),
    point('2026-07-14', 100),
    point('2026-07-15', 100),
    point('2026-07-16', 100),
    point('2026-07-17', 100),
    point('2026-07-18', 150),
    point('2026-07-19', 140),
    point('2026-07-20', 130),
    point('2026-07-21', 120),
  ]
  const isolated = computeImpact([event('isolated', '2026-07-18')], stableHistory).impacts[0]
  if (isolated.netAfter !== 420 || isolated.baseline !== 300 || isolated.classification !== 'above_expected')
    throw new Error('project-relative impact or UTC date window failed')

  const overlapping = computeImpact(
    [event('first', '2026-07-18'), event('second', '2026-07-19')],
    stableHistory,
  ).impacts
  if (overlapping[0]?.classification !== 'joint_effect' || overlapping[1]?.classification !== 'joint_effect')
    throw new Error('overlapping impact windows were assigned false causality')

  const volatile = [
    point('2026-07-13', 100),
    point('2026-07-14', 243),
    point('2026-07-15', 188),
    point('2026-07-16', 144),
    point('2026-07-17', 112),
    point('2026-07-18', 98),
    point('2026-07-19', 106),
    point('2026-07-20', 72),
    point('2026-07-21', 120),
  ]
  const noisyReaction = computeImpact([event('noisy', '2026-07-19')], volatile).impacts[0]
  if (noisyReaction.classification !== 'within_expected')
    throw new Error('normal project variation was incorrectly labelled below expected')

  const shortHistory = computeImpact([event('short', '2026-07-18')], volatile.slice(1)).impacts[0]
  if (shortHistory.classification !== 'insufficient')
    throw new Error('impact was scored without enough project history')
}

async function main() {
  assertImpactModel()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marcat-'))
  const { db, client } = createDb(fileUrlFromPath(path.join(dir, 'smoke.db')))
  const migrations = path.join(require.resolve('@marcat/db'), '..', '..', 'migrations')
  await runMigrations(db, client, migrations)
  const caller = appRouter.createCaller({ db })

  // games
  const g = await caller.games.create({ name: 'Smoke Game' })
  console.log('game:', g.slug)

  // platforms (with per-platform URLs) + steam app id derived from the pc_steam URL
  const g2 = await caller.games.create({
    name: 'Plat Game',
    platforms: [
      { id: 'pc_steam', url: 'https://store.steampowered.com/app/2246340/Foo/' },
      { id: 'mobile', url: '' },
    ],
    devhubProject: 'SALT',
  })
  console.log(
    'platforms:',
    g2.platforms.map((p) => p.id).join(','),
    '· appId:',
    g2.steamAppId,
    '· devhub:',
    g2.devhubProject,
  )
  if (g2.steamAppId !== 2246340 || !g2.platforms.some((p) => p.id === 'pc_steam') || g2.devhubProject !== 'SALT')
    throw new Error('game platforms/appId/devhub failed')

  // dated tag (= deadline, former milestone)
  const m = await caller.tags.create({ gameId: g.id, name: 'Next Fest', type: 'festival', targetDate: '2026-12-01' })

  // tasks
  const a = await caller.tasks.create({
    gameId: g.id,
    title: 'Trailer',
    priority: 'high',
    description: 'Ready to ship:\n- Export master\n- Check captions',
  })
  const b = await caller.tasks.create({
    gameId: g.id,
    title: 'Press kit',
    dueDate: '2020-01-01',
    tagIds: [m.id],
    newTagNames: ['Press'],
    blockerTaskIds: [a.id],
    checklist: ['Collect screenshots'],
  })
  const bDraft = await caller.tasks.get({ id: b.id })
  if (
    !bDraft.tags.some((tag) => tag.id === m.id) ||
    !bDraft.tags.some((tag) => tag.name === 'Press') ||
    bDraft.blockedBy[0]?.blockerTaskId !== a.id ||
    bDraft.checklist.length !== 1
  )
    throw new Error('atomic task draft did not persist related records')
  console.log('tasks:', a.title, '/', b.title)

  // --- Jira-style task ids: per-game seq + unique project key ---
  const tlist = await caller.tasks.list({ gameId: g.id })
  const tall = await caller.tasks.all()
  console.log('keys:', a.taskKey, '/', b.taskKey, '· game keys:', g.key, '/', g2.key, '· all tasks:', tall.length)
  if (!g.key || !g2.key || g.key === g2.key) throw new Error('game key missing or not unique across projects')
  if (a.taskKey !== `${g.key}-1` || b.taskKey !== `${g.key}-2`) throw new Error('task seq/key failed')
  if (!tlist.every((t) => t.taskKey)) throw new Error('tasks.list missing taskKey')
  if (!tall.find((t) => t.id === a.id && t.taskKey === a.taskKey && t.gameName === g.name))
    throw new Error('tasks.all missing labelled task')
  const quickTaskSearch = await caller.search.run({ query: 'trailer', scope: 'tasks', gameId: g.id })
  const otherProjectTaskSearch = await caller.search.run({ query: 'trailer', scope: 'tasks', gameId: g2.id })
  if (quickTaskSearch[0]?.id !== a.id || otherProjectTaskSearch.length)
    throw new Error('quick search did not rank or project-scope tasks correctly')

  // backfill: legacy rows (null key/seq) get filled idempotently
  const legacy = (await db.insert(schema.games).values({ name: 'Legacy Game', slug: 'legacy-x1' }).returning())[0]
  await db.insert(schema.tasks).values({ gameId: legacy.id, title: 'Old task 1' })
  await db.insert(schema.tasks).values({ gameId: legacy.id, title: 'Old task 2' })
  await backfillTaskKeys(db)
  const lg = await caller.games.get({ id: legacy.id })
  const lt = await caller.tasks.list({ gameId: legacy.id })
  console.log('backfill: key', lg.key, '· seqs', lt.map((t) => t.seq).join(','))
  if (!lg.key || lt.some((t) => t.seq == null) || new Set(lt.map((t) => t.seq)).size !== lt.length)
    throw new Error('backfill failed to assign key/seq')

  // checklist
  const ci = await caller.tasks.addChecklistItem({ taskId: a.id, text: 'Render' })
  await caller.tasks.toggleChecklistItem({ id: ci.id, done: true })
  const ci2 = await caller.tasks.addChecklistItem({ taskId: a.id, text: 'Verify captions' })

  // dependency + cycle guard
  let cycleBlocked = false
  try {
    await caller.tasks.addDependency({ blockerTaskId: b.id, blockedTaskId: a.id })
  } catch {
    cycleBlocked = true
  }
  console.log('cycle correctly blocked:', cycleBlocked)

  const focus = await caller.tasks.focus({ gameId: g.id })
  console.log('focus:', focus.focus[0].taskKey, focus.focus[0].recommendedAction, focus.focus[0].checklist.progressPct)
  if (focus.focus[0].id !== a.id || focus.focus[0].checklist.nextOpenItem?.id !== ci2.id)
    throw new Error('focus queue did not prioritize finishable blocker with checklist context')

  const partialCompletion = await caller.tasks.complete({ id: a.id })
  if (partialCompletion.completed || partialCompletion.remainingChecklist[0]?.id !== ci2.id)
    throw new Error('complete must keep the parent open while checklist work remains')
  const completed = await caller.tasks.complete({ id: a.id, completedChecklistItemIds: [ci2.id] })
  if (!completed.completed || completed.task.status !== 'done' || completed.checklistSummary.remaining !== 0)
    throw new Error('complete did not atomically reconcile checklist and parent task')
  const bAfterCompletion = await caller.tasks.get({ id: b.id })
  if (bAfterCompletion.task.status !== 'todo') throw new Error('completing a blocker did not unblock its dependent')

  // Recurring completion reopens one task cycle, resets its checklist and advances the date.
  if (addRecurrence('2099-01-31', 1, 'month') !== '2099-02-28')
    throw new Error('month-end recurrence did not clamp to February')
  if (addRecurrence('2099-02-28', 1, 'month') !== '2099-03-31')
    throw new Error('month-end recurrence drifted away from month end')
  const recurring = await caller.tasks.create({
    gameId: g.id,
    title: 'Weekly process check',
    dueDate: '2020-01-01',
    recurrence: { every: 1, unit: 'week' },
    checklist: ['Check the process'],
  })
  const recurringDraft = await caller.tasks.get({ id: recurring.id })
  const recurringItem = recurringDraft.checklist[0]
  const recurringCompletion = await caller.tasks.complete({
    id: recurring.id,
    completedChecklistItemIds: [recurringItem.id],
  })
  const recurringNext = await caller.tasks.get({ id: recurring.id })
  const today = new Date().toISOString().slice(0, 10)
  if (
    !recurringCompletion.completed ||
    !recurringCompletion.recurring ||
    recurringCompletion.task.status !== 'todo' ||
    recurringCompletion.nextDueDate <= today ||
    recurringNext.checklist[0].done ||
    !recurringNext.task.lastCompletedAt
  )
    throw new Error('recurring task did not reopen with a future deadline and a reset checklist')
  await caller.tasks.update({ id: recurring.id, patch: { recurrence: null } })
  const recurrenceDisabled = await caller.tasks.get({ id: recurring.id })
  if (recurrenceDisabled.task.recurrenceInterval !== null || recurrenceDisabled.task.recurrenceUnit !== null)
    throw new Error('recurrence could not be disabled during task editing')

  // detail
  const detail = await caller.tasks.get({ id: a.id })
  console.log('a checklist:', detail.checklist.length, 'a blocks:', detail.blocks.length)
  if (detail.task.description !== 'Ready to ship:\n- Export master\n- Check captions')
    throw new Error('task Markdown description was not preserved')
  await caller.tasks.update({
    id: a.id,
    patch: { description: '<p>Legacy HTML</p><ul><li>First</li><li>Second</li></ul>' },
  })
  const migratedDescription = (await caller.tasks.get({ id: a.id })).task.description
  if (migratedDescription !== 'Legacy HTML\n\n- First\n- Second')
    throw new Error('legacy task HTML was not converted to Markdown')
  await db
    .update(schema.tasks)
    .set({ description: '<p>Stored legacy HTML</p>' })
    .where(require('drizzle-orm').eq(schema.tasks.id, a.id))
  if ((await backfillTaskDescriptionMarkdown(db)) !== 1) throw new Error('task Markdown backfill did not run')
  if ((await caller.tasks.get({ id: a.id })).task.description !== 'Stored legacy HTML')
    throw new Error('task Markdown backfill did not persist')

  // dated-tag status (b is overdue + linked + open)
  const st = (await caller.tags.withStatus({ gameId: g.id })).find((x) => x.id === m.id)
  console.log('deadline status:', JSON.stringify({ open: st.openCount, overdue: st.overdueCount }))

  // atomic completion sets completedAt
  const done = completed.task
  console.log('completedAt set:', Boolean(done.completedAt))

  // --- Phase 2: events + wishlists ---
  const ev = await caller.events.create({
    gameId: g.id,
    occurredAt: '2026-08-01',
    type: 'post',
    platform: 'twitter',
    title: 'Reveal tweet',
    views: 12000,
  })
  console.log('events:', (await caller.events.list({ gameId: g.id })).length, 'views:', ev.views)

  // Universal activity: a task note is hidden from chart events until explicitly promoted.
  const activity = await caller.activities.create({
    gameId: g.id,
    subjectType: 'task',
    subjectId: a.id,
    occurredAt: '2026-08-01',
    body: 'Sent the final trailer copy to the editor.\nFull context stays here.',
  })
  const scopedActivities = await caller.activities.list({ gameId: g.id, subjectType: 'task', subjectId: a.id })
  const eventsBeforePromote = await caller.events.list({ gameId: g.id })
  await caller.activities.update({ id: activity.id, patch: { body: 'Final trailer copy sent.', showOnWishlist: true } })
  const eventsAfterPromote = await caller.events.list({ gameId: g.id })
  console.log(
    'activity journal:',
    scopedActivities.length,
    '· chart events:',
    eventsBeforePromote.length,
    '->',
    eventsAfterPromote.length,
  )
  if (scopedActivities[0]?.body !== 'Sent the final trailer copy to the editor.\nFull context stays here.')
    throw new Error('activity body/subject did not persist')
  if (eventsBeforePromote.length !== 1 || eventsAfterPromote.length !== 2)
    throw new Error('showOnWishlist event projection failed')

  await caller.wishlists.addPoint({ gameId: g.id, date: '2026-08-01', adds: 50, balance: 50 })
  const steamCsv =
    'sep=,\nSteam Wishlisting data for 2026-07-14 - 2026-07-16\n\nDateLocal,Game,Adds,Deletes,PurchasesAndActivations,Gifts\n2026-07-14,Example Game,243,1,0,0\n'
  const steamPrev = await caller.wishlists.previewCsv({ csv: steamCsv })
  if (
    steamPrev.headers[0] !== 'DateLocal' ||
    steamPrev.mapping.date !== 'DateLocal' ||
    steamPrev.mapping.adds !== 'Adds' ||
    steamPrev.mapping.gifts !== 'Gifts' ||
    steamPrev.total !== 1 ||
    steamPrev.sample[0]?.Adds !== '243'
  ) {
    throw new Error('Steam wishlist CSV preamble parsing failed')
  }
  const csv = 'Date,Adds,Deletes,Balance\n2026-08-01,70,5,70\n2026-08-02,30,2,98\n'
  const prev = await caller.wishlists.previewCsv({ csv })
  console.log('csv headers:', prev.headers.join('|'), 'rows:', prev.total)
  const imp = await caller.wishlists.importCsv({
    gameId: g.id,
    csv,
  })
  const series = await caller.wishlists.series({ gameId: g.id })
  const aug1 = series.find((p) => p.date === '2026-08-01')
  console.log('wishlist imported:', imp.imported, 'points:', series.length, 'aug1 balance (upsert):', aug1?.balance)
  const safeWishlistImport = await caller.analytics.importCsv({
    gameId: g.id,
    filename: 'SteamWishlists_123_2026-08-01_to_2026-08-01.csv',
    csv: 'sep=,\nSteam Wishlisting data\n\nDateLocal,Game,Adds,Deletes,PurchasesAndActivations,Gifts\n2026-08-01,Example,71,6,0,0\n',
  })
  const aug1AfterPartial = (await caller.wishlists.series({ gameId: g.id })).find((p) => p.date === '2026-08-01')
  if (safeWishlistImport.kind !== 'wishlists' || aug1AfterPartial?.balance !== 70 || aug1AfterPartial.adds !== 71) {
    throw new Error('auto wishlist import erased a metric missing from the incoming CSV')
  }

  // Steam's final DateLocal row is a live intraday snapshot. The next day's
  // export owns the completed value; Wishlist Cohorts is a different report.
  await db
    .insert(schema.wishlistPoints)
    .values({ gameId: g.id, date: '2026-08-03', adds: 5, deletes: 0, source: 'csv' })
    .onConflictDoUpdate({
      target: [schema.wishlistPoints.gameId, schema.wishlistPoints.date],
      set: { adds: 5, deletes: 0, source: 'csv' },
    })
  const partialWishlist = await caller.analytics.importCsv({
    gameId: g.id,
    filename: 'SteamWishlists_123_2026-08-02_to_2026-08-03.csv',
    fileModifiedAt: '2026-08-03T12:26:36.000Z',
    csv: 'sep=,\nSteam Wishlisting data\n\nDateLocal,Game,Adds,Deletes,PurchasesAndActivations,Gifts\n2026-08-02,Example,9,1,0,0\n2026-08-03,Example,5,0,0,0\n',
  })
  const afterPartialWishlist = await caller.wishlists.series({ gameId: g.id })
  if (partialWishlist.provisionalRows !== 1 || afterPartialWishlist.some((point) => point.date === '2026-08-03')) {
    throw new Error('current-day Steam wishlist snapshot was treated as complete')
  }
  await caller.analytics.importCsv({
    gameId: g.id,
    filename: 'SteamWishlists_123_2026-08-02_to_2026-08-03.csv',
    fileModifiedAt: '2026-08-04T08:00:00.000Z',
    csv: 'sep=,\nSteam Wishlisting data\n\nDateLocal,Game,Adds,Deletes,PurchasesAndActivations,Gifts\n2026-08-02,Example,9,1,0,0\n2026-08-03,Example,19,0,0,0\n',
  })
  const completedAug3 = (await caller.wishlists.series({ gameId: g.id })).find((point) => point.date === '2026-08-03')
  if (completedAug3?.adds !== 19) throw new Error('next Steam export did not replace the provisional day')

  let cohortRejected = false
  try {
    await caller.analytics.importCsv({
      gameId: g.id,
      filename: 'SteamWishlistCohorts_123_2026-08-01_to_2026-08-04.csv',
      fileModifiedAt: '2026-08-04T08:00:00.000Z',
      csv: 'sep=,\nSteam Wishlist Cohort data\n\nDateLocal,Game,MonthCohort,PurchasesAndActivations,Gifts,TotalConversions\n',
    })
  } catch (error) {
    cohortRejected = String(error?.message ?? error).includes('WISHLIST_COHORT_REPORT')
  }
  if (!cohortRejected) throw new Error('Steam Wishlist Cohort CSV was accepted as daily wishlist history')
  await caller.wishlists.deletePoint({ id: completedAug3.id })

  const utmImport = await caller.analytics.importCsv({
    gameId: g.id,
    filename: 'utm_123_all_20260714_20260715_daily.csv',
    csv: 'Дата,Источник,Кампания,Средство,Контент,"Ключевое слово","Тип устройства","Посещения (время по Гринвичу)","Проверенные посещения","Отслеживаемые посещения","Повторные посещения","Добавления в желаемое",Покупки,Активации\n2026-07-14,reddit,reveal,social,post,,ПК,20,18,10,1,4,0,0\n2026-07-15,reddit,reveal,social,post,,Мобильные,8,7,4,0,2,0,0\n',
  })
  const trafficImport = await caller.analytics.importCsv({
    gameId: g.id,
    filename: 'app_123_all_20140923_20260719.csv',
    csv: '"Страница / Категория","Страница / Раздел",Показов,Посещений\n"Сторонний сайт",reddit.com,100,12\n"Страница меток","Просмотр продуктов: все",80,9\n"Трафик ботов",crawler,50,40\n"Страна",US,30,5\n',
  })
  const analyticsOverview = await caller.analytics.overview({ gameId: g.id })
  if (
    utmImport.kind !== 'utm_daily' ||
    trafficImport.kind !== 'steam_traffic' ||
    analyticsOverview.utm.totals.wishlists !== 6 ||
    analyticsOverview.traffic.external[0]?.visits !== 12 ||
    analyticsOverview.traffic.discovery[0]?.visits !== 9 ||
    analyticsOverview.traffic.botVisits !== 40
  ) {
    throw new Error('localized Steam analytics CSV import failed')
  }
  const managedCampaign = await caller.analytics.upsertCampaign({
    gameId: g.id,
    name: 'Reveal launch',
    objective: 'wishlist_growth',
    status: 'active',
    plannedStart: '2026-07-14',
    plannedEnd: '2026-07-20',
    evaluationWindowDays: 3,
    budgetCents: 20_000,
    spendCents: 12_000,
    currency: 'USD',
    notes: 'Smoke campaign',
    touchpoints: [{ source: 'reddit', campaign: 'reveal', medium: 'social', content: 'post', term: '', eventId: null }],
  })
  const managedOverview = await caller.analytics.overview({ gameId: g.id })
  const managed = managedOverview.managedCampaigns.find((campaign) => campaign.id === managedCampaign.id)
  if (
    managed?.performance.wishlists !== 6 ||
    managed.costPerWishlistCents !== 2_000 ||
    managedOverview.utm.campaigns[0]?.managedCampaignId !== managedCampaign.id
  ) {
    throw new Error('managed campaign aggregation or UTM linkage failed')
  }
  console.log('analytics CSV auto-detect:', utmImport.kind, trafficImport.kind, '· UTM wishlists:', 6)

  // --- Proactive companion: local signal engine + curated knowledge + safe Claude action selection ---
  const companion = await caller.companion.snapshot({
    gameId: g2.id,
    route: `/g/${g2.id}/analytics`,
    lang: 'ru',
  })
  const knowledge = await caller.companion.knowledge({ query: 'страница Steam и вишлисты', lang: 'ru' })
  console.log(
    'companion:',
    companion.advice.id,
    '· help:',
    companion.help.id,
    '· knowledge:',
    knowledge.map((card) => card.id).join(','),
  )
  if (companion.advice.id !== 'connect-wishlist-data' || companion.help.id !== 'product-wishlist-data')
    throw new Error('companion local recommendation/help routing failed')
  if (!knowledge.some((card) => card.id === 'steam-page-quality'))
    throw new Error('companion knowledge retrieval failed')
  const steamPageCard = knowledge.find((card) => card.id === 'steam-page-quality')
  if (steamPageCard?.source || steamPageCard?.sourcePages)
    throw new Error('private SteamIzdat source metadata leaked into companion output')

  const demoKnowledge = await caller.companion.knowledge({
    query: 'подготовить демо к Next Fest',
    lang: 'ru',
  })
  if (
    !demoKnowledge.some((card) => card.id === 'next-fest-readiness') ||
    !demoKnowledge.some((card) => card.id === 'demo-launch-plan')
  )
    throw new Error('companion demo knowledge retrieval failed')

  const redditKnowledge = await caller.companion.knowledge({
    query: 'Reddit сообщество правила',
    lang: 'ru',
  })
  if (!redditKnowledge.some((card) => card.id === 'reddit-community-first'))
    throw new Error('companion channel knowledge retrieval failed')

  const urgentCompanion = await caller.companion.snapshot({
    gameId: g.id,
    route: `/g/${g.id}`,
    lang: 'ru',
  })
  if (urgentCompanion.advice.id !== 'close-overdue')
    throw new Error('companion allowed onboarding to outrank an overdue task')

  const companionAi = appRouter.createCaller({
    db,
    agent: {
      async advise() {
        return {
          title: 'Нужны данные Steam',
          message: 'Добавь первую точку, и я увижу темп.',
          why: 'Без результата нельзя честно связать действия с ростом.',
          actionId: 'invented-unsafe-action',
          knowledgeRefs: ['product-wishlist-data', 'not-a-real-card'],
          mood: 'hungry',
          confidence: 0.8,
          model: 'mock-sonnet',
        }
      },
    },
  })
  const personalized = await companionAi.companion.advise({
    gameId: g2.id,
    route: `/g/${g2.id}/analytics`,
    lang: 'ru',
  })
  console.log('companion AI:', personalized.advice.title, '· action:', personalized.advice.action.id)
  if (personalized.advice.action.id !== 'open-analytics')
    throw new Error('companion accepted an action that was not server-authored')
  if (personalized.advice.knowledgeRefs.some((id) => id === 'not-a-real-card'))
    throw new Error('companion accepted an unknown knowledge reference')

  // --- Project card: one-call context for agents ---
  await caller.projectCards.update({
    gameId: g.id,
    oneLiner: 'A compact strategy game about tiny launch plans.',
    repository: 'vc-dynasty/',
    branch: 'steam_v1',
    agentNotes: 'Read the project card before copying context into tasks.',
    docs: [{ label: 'Learnings', path: 'docs/learnings.md' }],
    links: [{ label: 'Steam', url: 'https://store.steampowered.com/app/123' }],
  })
  const manualInsight = await caller.insights.create({
    gameId: g.id,
    title: 'Readable automation wins in comments',
    body: 'Observed across 24 comments. Treat this as directional, not causal.',
    createdBy: 'manual',
  })
  const insightCatalog = await caller.insights.catalog({ gameId: g.id })
  const fullInsight = await caller.insights.get({ id: manualInsight.id })
  const requiredInsight = insightCatalog.find((insight) => insight.kind === 'project_card')
  if (!requiredInsight) throw new Error('required project-card insight is missing')
  const filledProjectCard = await caller.insights.update({
    id: requiredInsight.id,
    body: 'Canonical game brief for agents and outreach.',
    updatedBy: 'manual',
  })
  const protectedDelete = await caller.insights
    .remove({ id: requiredInsight.id })
    .then(() => false)
    .catch(() => true)
  const card = await caller.projectCards.get({ key: g.key })
  console.log(
    'project card:',
    card.card.oneLiner,
    '· tasks:',
    card.status.tasks.total,
    '· wl:',
    card.status.wishlist.latestBalance,
  )
  if (card.project.gameId !== g.id || card.card.docs[0]?.path !== 'docs/learnings.md')
    throw new Error('project card did not persist')
  if (card.status.tasks.total < 2 || card.status.wishlist.latestBalance !== 98)
    throw new Error('project card live status failed')
  if (
    insightCatalog[0]?.title !== 'Карточка проекта' ||
    insightCatalog[0]?.required !== true ||
    'body' in insightCatalog[0] ||
    insightCatalog[1]?.title !== manualInsight.title ||
    'body' in insightCatalog[1] ||
    fullInsight?.body !== manualInsight.body ||
    filledProjectCard?.body !== 'Canonical game brief for agents and outreach.' ||
    card.card.description !== 'Canonical game brief for agents and outreach.' ||
    card.insights[0]?.required !== true ||
    card.insights[1]?.title !== manualInsight.title ||
    'body' in card.insights[0] ||
    !protectedDelete
  )
    throw new Error('required project-card insight or title-catalogue/full-text split failed')

  // --- Phase 3: analytics + UTM ---
  const impact = await caller.analytics.impact({ gameId: g.id, windowDays: 7 })
  console.log(
    'impact events:',
    impact.impacts.length,
    'medianLift:',
    impact.medianLift,
    'first class:',
    impact.impacts[0]?.classification,
  )
  const utm = await caller.utm.build({
    gameId: g.id,
    label: 'Reveal',
    baseUrl: 'https://store.steampowered.com/app/123',
    utmSource: 'twitter',
    utmMedium: 'social',
    utmCampaign: 'reveal',
  })
  console.log('utm:', utm.fullUrl)

  // --- Phase 4: AI proposal pipeline (mock agent) ---
  const aiCaller = appRouter.createCaller({
    db,
    agent: {
      async run() {
        return {
          summary: 'Launch plan',
          changes: [
            {
              op: 'create',
              entity: 'task',
              after: { title: 'AI Task X', priority: 'high', checklist: ['Draft', 'Polish'], tag: 'Launch' },
            },
            { op: 'create', entity: 'task', after: { title: 'AI Task Y', tags: ['Launch'] } },
            { op: 'create', entity: 'dependency', after: { blocker: 'AI Task X', blocked: 'AI Task Y' } },
            { op: 'create', entity: 'tag', after: { name: 'Launch', type: 'release', targetDate: '2027-01-01' } },
            {
              op: 'update',
              entity: 'game',
              after: {
                officialLinks: [
                  { type: 'website', url: 'https://example.com/smoke-game' },
                  { type: 'discord', url: 'https://discord.gg/smoke' },
                ],
              },
            },
            {
              op: 'update',
              entity: 'insight',
              after: {
                entityId: manualInsight.id,
                body: 'Observed across 31 comments. Readability remains the strongest recurring theme.',
              },
            },
            {
              op: 'update',
              entity: 'insight',
              after: {
                entityId: requiredInsight.id,
                body: 'MarCat refreshed the canonical project brief.',
              },
            },
          ],
          rawOutput: '{}',
          model: 'mock',
        }
      },
    },
  })
  console.log('ai available:', (await aiCaller.ai.available()).available)
  const run = await aiCaller.ai.run({ gameId: g.id, prompt: 'plan launch' })
  // run() now stages changes in the background; poll until it settles.
  let got = await aiCaller.ai.getRun({ id: run.id })
  for (let i = 0; i < 100 && got.run.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 20))
    got = await aiCaller.ai.getRun({ id: run.id })
  }
  console.log('ai changes:', got.changes.length, 'status:', got.run.status)

  // manual edit of a staged change persists (and later applies)
  const yChange = got.changes.find((c) => c.entity === 'task' && c.after.title === 'AI Task Y')
  await aiCaller.ai.updateChange({ id: yChange.id, after: { ...yChange.after, checklist: ['Edited step'] } })
  const gotEdited = await aiCaller.ai.getRun({ id: run.id })
  const yEdited = gotEdited.changes.find((c) => c.id === yChange.id)
  const editPersisted = Array.isArray(yEdited.after.checklist) && yEdited.after.checklist[0] === 'Edited step'
  console.log('edit persisted:', editPersisted)

  const depsBefore = (await caller.tasks.listDependencies({ gameId: g.id })).length
  const applied = await aiCaller.ai.applyRun({ id: run.id })
  const list2 = await caller.tasks.list({ gameId: g.id })
  const depsAfter = await caller.tasks.listDependencies({ gameId: g.id })
  const x = list2.find((t) => t.title === 'AI Task X')
  const y = list2.find((t) => t.title === 'AI Task Y')
  const linked = depsAfter.some((d) => d.blockerTaskId === x?.id && d.blockedTaskId === y?.id)
  console.log('ai applied:', applied.applied, '· deps', depsBefore, '->', depsAfter.length, '· X→Y linked:', linked)
  const gameAfterAi = await caller.games.get({ id: g.id })
  if (!gameAfterAi.officialLinks.some((link) => link.type === 'website'))
    throw new Error('AI game officialLinks update was not applied')
  const insightAfterAi = await caller.insights.get({ id: manualInsight.id })
  if (!insightAfterAi?.body.includes('31 comments')) throw new Error('AI insight update was not applied')
  const projectCardAfterAi = await caller.insights.get({ id: requiredInsight.id })
  if (
    projectCardAfterAi?.body !== 'MarCat refreshed the canonical project brief.' ||
    projectCardAfterAi.createdBy !== 'ai'
  )
    throw new Error('AI project-card insight update was not applied')

  // AI created checklist + track tag on a task
  const xDetail = await caller.tasks.get({ id: x.id })
  const xTagged = xDetail.tags.some((tg) => tg.name === 'Launch')
  console.log('ai task X checklist:', xDetail.checklist.length, '· tagged Launch:', xTagged)

  // auto-block: Y is blocked by X (still open) → status 'blocked'; completing X frees it → 'todo'
  const yBlocked = list2.find((t) => t.id === y.id)?.status
  await caller.tasks.update({ id: x.id, patch: { status: 'done' } })
  const yAfter = (await caller.tasks.list({ gameId: g.id })).find((t) => t.id === y.id)?.status
  console.log('auto-block Y:', yBlocked, '· after X done:', yAfter)

  // edited checklist made it through apply
  const yChecklist = (await caller.tasks.get({ id: y.id })).checklist
  console.log('edited checklist applied:', yChecklist.map((i) => i.text).join(','))

  // chat: reply continues the SAME run (no new run) + archive hides it
  const settle = async (id) => {
    let g2 = await aiCaller.ai.getRun({ id })
    for (let i = 0; i < 100 && g2.run.status === 'running'; i++) {
      await new Promise((r) => setTimeout(r, 20))
      g2 = await aiCaller.ai.getRun({ id })
    }
    return g2
  }
  const chatRun = await aiCaller.ai.run({ gameId: g.id, prompt: 'chat test' })
  const m1 = (await settle(chatRun.id)).messages.length
  await aiCaller.ai.reply({ runId: chatRun.id, message: 'make it shorter' })
  const m2 = (await settle(chatRun.id)).messages.length
  const before = (await aiCaller.ai.listRuns({ gameId: g.id })).length
  await aiCaller.ai.archiveRun({ id: chatRun.id })
  const after = (await aiCaller.ai.listRuns({ gameId: g.id })).length
  console.log('chat msgs:', m1, '->', m2, '· archive hides run:', after === before - 1)
  if (m2 <= m1) throw new Error('reply did not extend the conversation')
  if (after !== before - 1) throw new Error('archive did not hide the run')

  // dated-tag date shift cascades to tagged task dates (+10 days)
  const dueBefore = (await caller.tasks.get({ id: b.id })).task.dueDate
  const ms2 = await caller.tags.update({ id: m.id, patch: { targetDate: '2026-12-11' } })
  const dueAfter = (await caller.tasks.get({ id: b.id })).task.dueDate
  console.log('deadline shift:', dueBefore, '->', dueAfter, '· tasksShifted:', ms2.shiftedTasks)

  // --- Phase 5: sources / connectors ---
  const secretBag = {}
  const secrets = {
    getClaudeToken: () => undefined,
    setClaudeToken: () => {},
    getApiKey: (p) => secretBag[p],
    setApiKey: (p, k) => {
      if (k) secretBag[p] = k
      else delete secretBag[p]
    },
  }
  const srcCaller = appRouter.createCaller({ db, secrets })

  // Steam watched-folder: scan a folder of CSVs → wishlist_points (idempotent).
  const steamDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marcat-steam-'))
  fs.writeFileSync(
    path.join(steamDir, 'wishlists.csv'),
    'Date,Adds,Deletes,Balance\n2026-09-01,100,5,1000\n2026-09-02,50,2,1048\n',
  )
  const steamSrc = await srcCaller.sources.create({ gameId: g.id, platform: 'steam', handle: steamDir })
  const steamSync = await srcCaller.sources.sync({ sourceId: steamSrc.id })
  const sep1 = (await caller.wishlists.series({ gameId: g.id })).find((p) => p.date === '2026-09-01')
  console.log('steam sync imported:', steamSync.imported, '· sep1 balance:', sep1?.balance)

  // Paid source: estimate first (no confirm), then the budget guard blocks the spend.
  secrets.setApiKey('twitterapi', 'fake-key')
  const xSrc = await srcCaller.sources.create({ gameId: g.id, platform: 'twitter', handle: '@mygame' })
  const dry = await srcCaller.sources.sync({ sourceId: xSrc.id })
  console.log('twitter dry-run:', dry.dryRun, '· est $', dry.estCostUsd)
  await srcCaller.sources.setBudget({ provider: 'twitterapi', dailyBudgetUsd: 0 })
  let budgetBlocked = false
  try {
    await srcCaller.sources.sync({ sourceId: xSrc.id, confirm: true })
  } catch {
    budgetBlocked = true
  }
  const xBudget = (await srcCaller.sources.spend()).find((s) => s.provider === 'twitterapi')
  console.log('budget guard blocked:', budgetBlocked, '· budget $', xBudget?.dailyBudgetUsd)

  // Free connectors registered; YouTube needs a key (gate fires before any network).
  const platformList = await srcCaller.sources.platforms()
  const ytSrc = await srcCaller.sources.create({ gameId: g.id, platform: 'youtube', handle: '@mychannel' })
  let ytKeyBlocked = false
  try {
    await srcCaller.sources.sync({ sourceId: ytSrc.id })
  } catch {
    ytKeyBlocked = true
  }
  console.log('platforms:', platformList.length, '· youtube key-gate:', ytKeyBlocked)

  if (steamSync.imported < 2 || sep1?.balance !== 1000) throw new Error('steam folder sync failed')
  if (!dry.dryRun || !(dry.estCostUsd > 0)) throw new Error('paid dry-run estimate failed')
  if (!budgetBlocked || xBudget?.dailyBudgetUsd !== 0) throw new Error('budget guard failed')
  const platformIds = new Set(platformList.map((platform) => platform.id))
  for (const required of [
    'steam',
    'youtube',
    'steam_reviews',
    'google_play_reviews',
    'itch_comments',
    'gamejolt_comments',
    'poki_comments',
    'crazygames_comments',
    'incrementaldb_comments',
  ]) {
    if (!platformIds.has(required)) throw new Error(`platform catalogue missing ${required}`)
  }
  if (!ytKeyBlocked) throw new Error('youtube key gate failed')

  // --- Phase 6: the cat writes the MCP config into a folder on approval ---
  const mcpOutDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marcat-mcpcfg-'))
  const mcpAi = appRouter.createCaller({
    db,
    appPaths: { dbPath: 'X:/marcat.db', mcpServerPath: 'X:/server/index.js', mcpUrl: 'http://127.0.0.1:47831/mcp' },
    agent: {
      async run() {
        return {
          summary: 'wiring mcp',
          changes: [{ op: 'create', entity: 'mcp_config', after: { folder: mcpOutDir } }],
          rawOutput: '{}',
          model: 'mock',
        }
      },
    },
  })
  const mcpRun = await mcpAi.ai.run({ gameId: g.id, prompt: 'set up mcp here' })
  let mcpGot = await mcpAi.ai.getRun({ id: mcpRun.id })
  for (let i = 0; i < 100 && mcpGot.run.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 20))
    mcpGot = await mcpAi.ai.getRun({ id: mcpRun.id })
  }
  await mcpAi.ai.applyRun({ id: mcpRun.id })
  const cfgPath = path.join(mcpOutDir, '.mcp.json')
  const wroteCfg = fs.existsSync(cfgPath)
  const cfgText = wroteCfg ? fs.readFileSync(cfgPath, 'utf8') : ''
  // The config must name the HTTP endpoint, never a stdio server path: that path
  // moves on every launch of a portable build and opens a second writer.
  const pointsAtEndpoint = cfgText.includes('http://127.0.0.1:47831/mcp')
  const leaksServerPath = cfgText.includes('X:/server/index.js')
  console.log('ai wrote .mcp.json:', wroteCfg, '· points at endpoint:', pointsAtEndpoint)
  if (!wroteCfg || !pointsAtEndpoint || leaksServerPath) throw new Error('ai mcp_config write failed')

  // --- festivals: catalogue + per-game picks + rich fields + participation ---
  const fest = await caller.festivals.create({
    name: 'Steam Next Fest',
    startDate: '2026-10-13',
    applyDeadline: '2026-08-01',
    url: 'https://store.steampowered.com',
    costUsd: 0,
  })
  await caller.festivals.pick({ gameId: g.id, industryEventId: fest.id })
  await caller.festivals.setStatus({ gameId: g.id, industryEventId: fest.id, status: 'submitted' })
  // edit all-the-fields via update
  const festUpd = await caller.festivals.update({
    id: fest.id,
    organizer: 'Valve',
    description: 'Free week-long Steam-wide demo festival.',
    applyUrl: 'https://partner.steampowered.com',
    steamEvent: 'yes',
    steamFeature: 'maybe',
    media: true,
    offline: false,
    costUsd: 0,
  })
  if (festUpd.organizer !== 'Valve' || festUpd.steamEvent !== 'yes' || festUpd.media !== true)
    throw new Error('festival update failed')
  const festList = await caller.festivals.list()
  const festPicks = await caller.festivals.picks({ gameId: g.id })
  const quickFestivalSearch = await caller.search.run({ query: 'next fest', scope: 'festivals' })
  if (quickFestivalSearch[0]?.id !== fest.id) throw new Error('quick search did not find the festival catalogue')
  const festPick = festPicks.find((p) => p.industryEventId === fest.id)
  const part = await caller.festivals.participation()
  const partRow = part.find((p) => p.industryEventId === fest.id && p.gameId === g.id)
  console.log(
    'festivals:',
    festList.length,
    '· picked Next Fest:',
    !!festPick,
    '· status:',
    festPick?.status,
    '· deadline:',
    festUpd.applyDeadline,
    '· participants for fest:',
    part.filter((p) => p.industryEventId === fest.id).length,
  )
  if (!festPick || festPick.status !== 'submitted') throw new Error('festival pick/status failed')
  if (!partRow || partRow.gameName !== g.name) throw new Error('festival participation query failed')

  const festAi = appRouter.createCaller({
    db,
    agent: {
      async run() {
        return {
          summary: 'found a fest',
          changes: [
            {
              op: 'create',
              entity: 'festival',
              after: { name: 'Wholesome Direct', startDate: '2026-06-01', organizer: 'Wholesome Games' },
            },
          ],
          rawOutput: '{}',
          model: 'mock',
        }
      },
    },
  })
  const festRun = await festAi.ai.run({ gameId: g.id, prompt: 'find a wholesome fest' })
  let fg = await festAi.ai.getRun({ id: festRun.id })
  for (let i = 0; i < 100 && fg.run.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 20))
    fg = await festAi.ai.getRun({ id: festRun.id })
  }
  await festAi.ai.applyRun({ id: festRun.id })
  const aiFest = (await caller.festivals.list()).find((f) => f.name === 'Wholesome Direct')
  const aiPicked = (await caller.festivals.picks({ gameId: g.id })).some((p) => p.industryEventId === aiFest?.id)
  console.log('ai festival added:', !!aiFest, '· auto-picked:', aiPicked)
  if (!aiFest || !aiPicked) throw new Error('ai festival entity failed')

  // AI enriches an EXISTING festival by entityId (after web research) instead of duplicating.
  const enrichAi = appRouter.createCaller({
    db,
    agent: {
      async run() {
        return {
          summary: 'enriched the fest',
          changes: [
            {
              op: 'update',
              entity: 'festival',
              after: { entityId: fest.id, organizer: 'Valve Corp.', applyDeadline: '2026-07-15', costUsd: 0 },
            },
          ],
          rawOutput: '{}',
          model: 'mock',
        }
      },
    },
  })
  const enrichRun = await enrichAi.ai.run({ gameId: g.id, prompt: 'research Next Fest deadlines' })
  let eg = await enrichAi.ai.getRun({ id: enrichRun.id })
  for (let i = 0; i < 100 && eg.run.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 20))
    eg = await enrichAi.ai.getRun({ id: enrichRun.id })
  }
  await enrichAi.ai.applyRun({ id: enrichRun.id })
  const enriched = (await caller.festivals.list()).find((f) => f.id === fest.id)
  const noDup = (await caller.festivals.list()).filter((f) => f.name === 'Steam Next Fest').length
  console.log(
    'ai enriched existing fest:',
    enriched?.organizer,
    '· deadline:',
    enriched?.applyDeadline,
    '· dupes:',
    noDup,
  )
  if (enriched?.organizer !== 'Valve Corp.' || enriched?.applyDeadline !== '2026-07-15' || noDup !== 1)
    throw new Error('ai festival enrich-by-entityId failed')

  // --- Phase 7: cross-game dashboard overview ---
  const ov = await caller.dashboard.overview()
  const ovGame = ov.games.find((x) => x.id === g.id)
  const ovWl = ov.wishlists.find((w) => w.gameId === g.id)
  const ovFest = ov.festivals.find((f) => f.gameId === g.id)
  console.log(
    'dashboard:',
    'games',
    ov.games.length,
    '· deadlines',
    ov.deadlines.length,
    '· festivals',
    ov.festivals.length,
    '· overdue',
    ov.tasksOverdue.length,
    '· wl balance',
    ovWl?.balance,
  )
  if (!ovGame) throw new Error('dashboard: game missing from overview')
  if (!Array.isArray(ov.deadlines) || !Array.isArray(ov.spend)) throw new Error('dashboard: bad shape')
  if (ov.tasksOverdue.length < 1) throw new Error('dashboard: expected an overdue task')
  if (!ovWl || ovWl.balance == null) throw new Error('dashboard: wishlist balance missing')
  if (!ovFest) throw new Error('dashboard: picked festival missing from overview')

  // --- Phase 9: backups (checkpoint + copy, restore staging) ---
  const dbFile = path.join(dir, 'smoke.db')
  const sysCaller = appRouter.createCaller({ db, appPaths: { dbPath: dbFile, mcpServerPath: '' } })
  const bk = await sysCaller.system.backup()
  const listed = await sysCaller.system.listBackups()
  await sysCaller.system.restoreBackup({ path: bk.path })
  const staged = fs.existsSync(path.join(dir, 'marcat.restore'))
  console.log(
    'backup created:',
    fs.existsSync(bk.path),
    '· listed:',
    listed.backups.length,
    '· restore staged:',
    staged,
  )
  if (!fs.existsSync(bk.path) || listed.backups.length < 1 || !staged) throw new Error('backup/restore failed')

  if (!cycleBlocked) throw new Error('cycle guard failed')
  if (series.length !== 2 || aug1?.balance !== 70) throw new Error('wishlist upsert failed')
  if (!utm.fullUrl.includes('utm_campaign=reveal')) throw new Error('utm build failed')
  if (!linked || applied.applied !== 7) throw new Error('ai link apply failed')
  if (xDetail.checklist.length !== 2 || !xTagged) throw new Error('ai checklist/tag failed')
  if (yBlocked !== 'blocked' || yAfter !== 'todo') throw new Error('auto block/unblock failed')
  if (dueAfter !== '2020-01-11' || ms2.shiftedTasks < 1) throw new Error('milestone shift cascade failed')
  if (!editPersisted) throw new Error('staged-change edit did not persist')
  if (yChecklist.length !== 1 || yChecklist[0].text !== 'Edited step') throw new Error('edited change did not apply')

  // --- Phase 11: influencers / outreach CRM ---
  // catalogue + dedup by normalized channel key (scheme/www/trailing-slash-insensitive)
  const cr1 = await caller.creators.create({
    name: 'CozyGamer',
    handle: 'https://youtube.com/@cozygamer',
    kind: 'youtuber',
    audience: 120000,
    costUsd: 500,
    lastActiveAt: '2026-06-25',
    cadencePerMonth: 8,
    topicsJson: JSON.stringify(['cozy', 'simulation']),
    playedGamesJson: JSON.stringify(['MarCat Game', 'Stardew Valley']),
    contactsJson: JSON.stringify([{ type: 'business_email', value: 'cozy@example.com', verified: true, gated: false }]),
    acceptsKeysOnly: true,
  })
  const crDup = await caller.creators.create({ name: 'Cozy Dup', handle: 'https://www.youtube.com/@cozygamer/' })
  console.log('creators:', (await caller.creators.list()).length, '· dedup same id:', crDup.id === cr1.id)
  const quickCreatorSearch = await caller.search.run({ query: 'cozy gamer', scope: 'all' })
  if (quickCreatorSearch[0]?.id !== cr1.id || quickCreatorSearch[0]?.kind !== 'creators')
    throw new Error('cross-entity quick search did not rank the influencer')
  if (crDup.id !== cr1.id) throw new Error('creator dedup by channelKey failed')
  if (cr1.costUsd !== 500) throw new Error('creator participation cost failed')

  // pick + pipeline status
  await caller.creators.pick({ gameId: g.id, creatorId: cr1.id })
  await caller.creators.updatePick({
    gameId: g.id,
    creatorId: cr1.id,
    keysSentJson: JSON.stringify(['AAAAA-BBBBB-CCCCC', 'DDDDD-EEEEE-FFFFF']),
  })
  await caller.creators.setStatus({ gameId: g.id, creatorId: cr1.id, pipelineStatus: 'contacted' })
  const crPick = (await caller.creators.picks({ gameId: g.id })).find((p) => p.creatorId === cr1.id)
  console.log('creator picked:', !!crPick, '· status:', crPick?.pipelineStatus)
  if (
    !crPick ||
    crPick.pipelineStatus !== 'contacted' ||
    !crPick.keysSentJson?.includes('AAAAA-BBBBB-CCCCC') ||
    !cr1.playedGamesJson?.includes('Stardew Valley')
  )
    throw new Error('creator pick/status/keys/played-games round-trip failed')

  const gmassPreview = await caller.gmass.preview({
    gameId: g.id,
    creatorIds: [cr1.id],
    addressCategories: ['verified_business'],
    subject: '{{gameName}} for {{creatorName}}',
    body: 'Key: {{gameKeys}}',
  })
  if (
    gmassPreview.recipients.length !== 1 ||
    gmassPreview.recipients[0].email !== 'cozy@example.com' ||
    !gmassPreview.recipients[0].body.includes('AAAAA-BBBBB-CCCCC')
  )
    throw new Error('GMass recipient category/template preview failed')
  const gmassCampaign = await caller.gmass.create({
    gameId: g.id,
    creatorIds: [cr1.id],
    addressCategories: ['verified_business'],
    subject: '{{gameName}} for {{creatorName}}',
    body: 'Key: {{gameKeys}}',
    name: 'Smoke GMass batch',
    fromEmail: 'studio@example.com',
    messageType: 'plain',
    sendMode: 'send',
    openTracking: true,
    clickTracking: true,
    requestedBy: 'manual',
  })
  await caller.gmass.approve({
    id: gmassCampaign.id,
    confirm: true,
    expectedRecipientCount: 1,
    contentHash: gmassCampaign.contentHash,
  })
  const queuedGmass = await caller.gmass.get({ id: gmassCampaign.id })
  if (queuedGmass?.status !== 'queued' || queuedGmass.recipients.length !== 1)
    throw new Error('GMass campaign freeze/approval queue failed')

  // correspondence touch advances the pipeline + funnel counts it
  await caller.creators.logTouch({
    gameId: g.id,
    creatorId: cr1.id,
    direction: 'inbound',
    channel: 'email',
    summary: 'replied, interested',
    body: 'Full reply text',
    statusAfter: 'replied',
  })
  const crTouches = await caller.creators.touches({ gameId: g.id, creatorId: cr1.id })
  const crFunnel = await caller.creators.funnel({ gameId: g.id })
  console.log('touches:', crTouches.length, '· funnel total:', crFunnel.total, '· responseRate:', crFunnel.responseRate)
  if (
    crTouches.length !== 1 ||
    crTouches[0].body !== 'Full reply text' ||
    crFunnel.total < 1 ||
    crFunnel.responseRate == null
  )
    throw new Error('creator touch/funnel failed')

  // queue worker creates the personalized GMass campaign, imports engagement,
  // and records confirmed send/reply actions without exposing the API key.
  const originalFetch = global.fetch
  global.fetch = async (input, init = {}) => {
    const url = new URL(String(input))
    const json = (value, status = 200) =>
      new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
    if (url.pathname.endsWith('/campaigndrafts') && init.method === 'POST')
      return json({ campaignDraftId: 'smoke-draft' })
    if (url.pathname.endsWith('/campaigns/smoke-draft') && init.method === 'POST')
      return json({ campaignId: 4101, status: 'processing' })
    if (url.pathname.endsWith('/campaigns/4101')) return json({ campaignId: 4101, status: 'complete' })
    if (url.pathname.endsWith('/reports/4101/recipients'))
      return json({ data: [{ emailAddress: 'cozy@example.com', sentTime: '2026-07-23T10:00:00.000Z' }] })
    if (url.pathname.endsWith('/reports/4101/replies'))
      return json({ data: [{ emailAddress: 'cozy@example.com', replyTime: '2026-07-23T11:00:00.000Z' }] })
    if (url.pathname.includes('/reports/4101/')) return json({ data: [] })
    return json({ error: 'unexpected mock request' }, 404)
  }
  try {
    await processGmassQueue(db, {
      getClaudeToken: () => undefined,
      setClaudeToken: () => {},
      getApiKey: (provider) => (provider === 'gmass' ? 'smoke-key' : undefined),
      setApiKey: () => {},
    })
  } finally {
    global.fetch = originalFetch
  }
  const syncedGmass = await caller.gmass.get({ id: gmassCampaign.id })
  if (
    syncedGmass?.recipients[0]?.status !== 'replied' ||
    !syncedGmass.recipients[0].sentAt ||
    !syncedGmass.recipients[0].repliedAt ||
    !syncedGmass.lastSyncedAt
  )
    throw new Error('GMass queue dispatch/statistics sync failed')

  // task linked to a creator via the name-tag convention
  const crmTag = await caller.tags.create({ gameId: g.id, name: 'CozyGamer' })
  const pitchTask = await caller.tasks.create({ gameId: g.id, title: 'Draft pitch to CozyGamer' })
  await caller.tasks.assignTag({ taskId: pitchTask.id, tagId: crmTag.id })
  const crTasks = await caller.creators.tasksFor({ gameId: g.id, creatorId: cr1.id })
  console.log('creator linked tasks:', crTasks.length)
  if (!crTasks.some((t) => t.id === pitchTask.id)) throw new Error('creator task-by-tag link failed')

  // fit score (on the fly): picked creator gets a score with neutral prior at 0 beats
  const crFit = (await caller.creators.fit({ gameId: g.id })).find((f) => f.creatorId === cr1.id)
  console.log('creator fit:', crFit?.score, '· reasons:', crFit?.reasons.length)
  if (!crFit || typeof crFit.score !== 'number' || crFit.score < 0 || crFit.score > 100)
    throw new Error('creator fit scoring failed')

  // AI entity: cat researches a creator → create + auto-pick; and a beat (event) attributed to it
  const crAi = appRouter.createCaller({
    db,
    agent: {
      async run() {
        return {
          summary: 'found a creator',
          changes: [
            {
              op: 'create',
              entity: 'creator',
              after: {
                name: 'IndieSpotlight',
                handle: 'https://youtube.com/@indiespotlight',
                kind: 'youtuber',
                audience: 45000,
                topics: ['indie', 'strategy'],
                contacts: [
                  {
                    type: 'business_email',
                    value: 'hi@indiespotlight.tv',
                    source: 'api',
                    sourceUrl: 'https://youtube.com/@indiespotlight/about',
                    verified: false,
                  },
                ],
              },
            },
            {
              op: 'create',
              entity: 'event',
              after: {
                title: 'IndieSpotlight covered us',
                occurredAt: '2026-08-05',
                type: 'youtube_external',
                platform: 'youtube',
                views: 30000,
              },
            },
          ],
          rawOutput: '{}',
          model: 'mock',
        }
      },
    },
  })
  const crRun = await crAi.ai.run({ gameId: g.id, prompt: 'find an indie youtuber' })
  let cg = await crAi.ai.getRun({ id: crRun.id })
  for (let i = 0; i < 100 && cg.run.status === 'running'; i++) {
    await new Promise((r) => setTimeout(r, 20))
    cg = await crAi.ai.getRun({ id: crRun.id })
  }
  await crAi.ai.applyRun({ id: crRun.id })
  const aiCreator = (await caller.creators.list()).find((c) => c.name === 'IndieSpotlight')
  const aiCrPicked = (await caller.creators.picks({ gameId: g.id })).some((p) => p.creatorId === aiCreator?.id)
  console.log(
    'ai creator added:',
    !!aiCreator,
    '· auto-picked:',
    aiCrPicked,
    '· has contact:',
    !!aiCreator?.contactsJson,
  )
  if (!aiCreator || !aiCrPicked || !aiCreator.contactsJson) throw new Error('ai creator entity failed')

  console.log('SMOKE OK')
}

main().catch((e) => {
  console.error('SMOKE FAIL', e)
  process.exit(1)
})
