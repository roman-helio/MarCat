/* Spawn the MarCat MCP server over stdio and verify initialize + tools + a write/read round-trip. */
const { spawn } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { appRouter } = require('@marcat/core')
const { createDb, fileUrlFromPath, runMigrations } = require('@marcat/db')

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marcat-mcp-'))
  const dbFile = path.join(dir, 'marcat.db')

  // Seed a game directly, then close so the server opens a clean connection.
  const { db, client } = createDb(fileUrlFromPath(dbFile))
  await runMigrations(db, client, path.join(require.resolve('@marcat/db'), '..', '..', 'migrations'))
  const g = await appRouter.createCaller({ db }).games.create({ name: 'MCP Game' })
  client.close()

  // Exercise the legacy path too: older exported project configs referenced
  // index.js, which must keep launching the canonical index.cjs bundle.
  const serverPath = path.join(__dirname, '..', 'packages', 'mcp-server', 'dist', 'index.js')
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, MARCAT_DB: dbFile },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.on('data', (d) => process.stderr.write('[server] ' + d))

  const pending = new Map()
  let buf = ''
  child.stdout.on('data', (d) => {
    buf += d.toString()
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim()
      buf = buf.slice(i + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    }
  })
  let idc = 1
  const send = (method, params) =>
    new Promise((res) => {
      const id = idc++
      pending.set(id, res)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')

  const guard = setTimeout(() => {
    console.error('MCP FAIL timeout')
    child.kill()
    process.exit(1)
  }, 15000)

  const initialized = await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  })
  notify('notifications/initialized', {})
  const tools = await send('tools/list', {})
  const toolDefs = tools.result?.tools ?? []
  const toolNames = toolDefs.map((t) => t.name)
  const games = await send('tools/call', { name: 'list_games', arguments: {} })
  const card = await send('tools/call', { name: 'get_project_card', arguments: { key: g.key } })
  await send('tools/call', {
    name: 'update_game',
    arguments: {
      id: g.id,
      officialLinks: [
        { type: 'website', url: 'https://example.com/mcp-game' },
        { type: 'youtube', url: 'https://youtube.com/@mcp-game' },
      ],
    },
  })
  const gameWithLinks = await send('tools/call', { name: 'get_game', arguments: { id: g.id } })
  const created = await send('tools/call', {
    name: 'create_task',
    arguments: {
      gameId: g.id,
      title: 'From MCP',
      priority: 'high',
      description: 'MCP checklist:\n- First item\n- Second item',
    },
  })
  const createdTask = JSON.parse(created.result?.content?.[0]?.text ?? '{}')
  await send('tools/call', {
    name: 'create_task',
    arguments: {
      gameId: g.id,
      title: 'Лендинг кампании',
      description: 'Проверка регистронезависимого поиска по кириллице.',
    },
  })
  const firstChecklist = await send('tools/call', {
    name: 'add_checklist_item',
    arguments: { taskId: createdTask.id, text: 'Verify implementation' },
  })
  const secondChecklist = await send('tools/call', {
    name: 'add_checklist_item',
    arguments: { taskId: createdTask.id, text: 'Verify tracker state' },
  })
  const firstChecklistItem = JSON.parse(firstChecklist.result?.content?.[0]?.text ?? '{}')
  const secondChecklistItem = JSON.parse(secondChecklist.result?.content?.[0]?.text ?? '{}')
  const focus = await send('tools/call', {
    name: 'get_next_actions',
    arguments: { gameId: g.id },
  })
  const bypassCompletion = await send('tools/call', {
    name: 'update_task',
    arguments: { id: createdTask.id, status: 'done' },
  })
  const partialComplete = await send('tools/call', {
    name: 'complete_task',
    arguments: { id: createdTask.id, completedChecklistItemIds: [firstChecklistItem.id] },
  })
  const finalComplete = await send('tools/call', {
    name: 'complete_task',
    arguments: { id: createdTask.id, completedChecklistItemIds: [secondChecklistItem.id] },
  })
  const recurringCreated = await send('tools/call', {
    name: 'create_task',
    arguments: {
      gameId: g.id,
      title: 'Monthly MCP check',
      dueDate: '2099-01-31',
      recurrence: { every: 1, unit: 'month' },
    },
  })
  const recurringTask = JSON.parse(recurringCreated.result?.content?.[0]?.text ?? '{}')
  const recurringCompleted = await send('tools/call', {
    name: 'complete_task',
    arguments: { id: recurringTask.id },
  })
  const recurringRead = await send('tools/call', {
    name: 'get_task',
    arguments: { id: recurringTask.id },
  })
  await send('tools/call', {
    name: 'update_task',
    arguments: { id: recurringTask.id, recurrence: null },
  })
  const recurrenceDisabled = await send('tools/call', {
    name: 'get_task',
    arguments: { id: recurringTask.id },
  })
  const activityCreated = await send('tools/call', {
    name: 'create_activity',
    arguments: {
      gameId: g.id,
      subjectType: 'project',
      body: 'Full Reddit post copy\nSecond paragraph must survive.',
      occurredAt: '2026-07-13',
      showOnWishlist: true,
      type: 'post',
      platform: 'reddit',
      placement: 'r/CityBuilders',
      url: 'https://www.reddit.com/r/CityBuilders/comments/example',
      views: 123,
      likes: 7,
      comments: 2,
      isOwn: true,
    },
  })
  const createdActivity = JSON.parse(activityCreated.result?.content?.[0]?.text ?? '{}')
  const activityId = createdActivity.id
  const activityUpdated = await send('tools/call', {
    name: 'update_activity',
    arguments: { id: activityId, body: 'MCP journal entry edited', showOnWishlist: true },
  })
  const insightCreated = await send('tools/call', {
    name: 'create_insight',
    arguments: {
      gameId: g.id,
      title: 'Players value readable automation',
      body: 'Evidence from 24 comments. Full body must be loaded explicitly.',
    },
  })
  const createdInsight = JSON.parse(insightCreated.result?.content?.[0]?.text ?? '{}')
  const insightCatalog = await send('tools/call', {
    name: 'list_insights',
    arguments: { gameId: g.id },
  })
  const insightCatalogJson = JSON.parse(insightCatalog.result?.content?.[0]?.text ?? '[]')
  const requiredProjectCard = insightCatalogJson.find((insight) => insight.kind === 'project_card')
  const projectCardUpdated = await send('tools/call', {
    name: 'update_insight',
    arguments: { id: requiredProjectCard?.id, body: 'Canonical MCP brief for influencer outreach.' },
  })
  const projectCardRead = await send('tools/call', {
    name: 'get_insight',
    arguments: { id: requiredProjectCard?.id },
  })
  const projectCardDelete = await send('tools/call', {
    name: 'delete_insight',
    arguments: { id: requiredProjectCard?.id },
  })
  const duplicateProjectCard = await send('tools/call', {
    name: 'create_insight',
    arguments: { gameId: g.id, title: 'Карточка проекта', body: 'Duplicate must be rejected.' },
  })
  const insightRead = await send('tools/call', {
    name: 'get_insight',
    arguments: { id: createdInsight.id },
  })
  const insightUpdated = await send('tools/call', {
    name: 'update_insight',
    arguments: { id: createdInsight.id, body: 'Evidence grew to 31 comments. Keep the automation readable.' },
  })
  const cardWithInsight = await send('tools/call', { name: 'get_project_card', arguments: { key: g.key } })
  const invalidActivity = await send('tools/call', {
    name: 'create_activity',
    arguments: {
      gameId: g.id,
      body: 'This must not become an email chart event',
      showOnWishlist: true,
      type: 'post',
      platform: 'reddit',
      direction: 'outbound',
      channel: 'email',
    },
  })
  await send('tools/call', {
    name: 'add_wishlist_point',
    arguments: { gameId: g.id, date: '2026-07-13', adds: 12, deletes: 2, balance: 100 },
  })
  const wishlist = await send('tools/call', { name: 'get_wishlist_series', arguments: { gameId: g.id } })
  const utmCreated = await send('tools/call', {
    name: 'build_utm_link',
    arguments: {
      gameId: g.id,
      label: 'Reddit reveal',
      baseUrl: 'https://example.com/game',
      utmSource: 'reddit',
      utmMedium: 'social',
      utmCampaign: 'reveal',
      utmContent: 'r_citybuilders',
      eventId: activityId,
    },
  })
  const creatorCreated = await send('tools/call', {
    name: 'create_creator',
    arguments: {
      name: 'Structured Creator',
      primaryPlatform: 'youtube',
      costUsd: 750,
      channels: [
        { platform: 'youtube', url: 'https://youtube.com/@structured', handle: '@structured', subscribers: 42 },
      ],
      topics: ['city builder', 'strategy'],
      playedGames: ['Against the Storm', 'Frostpunk'],
      contacts: [{ type: 'email', value: 'business@example.com', verified: true }],
    },
  })
  const creatorId = JSON.parse(creatorCreated.result?.content?.[0]?.text ?? '{}').id
  const creatorRead = await send('tools/call', { name: 'get_creator', arguments: { id: creatorId } })
  await send('tools/call', {
    name: 'pick_creator',
    arguments: { gameId: g.id, creatorId, keysSent: ['AAAAA-BBBBB-CCCCC'] },
  })
  await send('tools/call', {
    name: 'update_creator_keys',
    arguments: { gameId: g.id, creatorId, keysSent: ['DDDDD-EEEEE-FFFFF'] },
  })
  const outreachBatch = await send('tools/call', {
    name: 'log_touches_bulk',
    arguments: {
      gameId: g.id,
      items: [
        {
          creatorId,
          direction: 'outbound',
          channel: 'email',
          occurredAt: '2026-07-13',
          summary: 'Sent verified MCP outreach',
          body: 'Complete outreach body.',
          statusAfter: 'contacted',
          requestId: 'mcp-test-outreach-batch',
        },
      ],
    },
  })
  const outreachReplay = await send('tools/call', {
    name: 'log_touches_bulk',
    arguments: {
      gameId: g.id,
      items: [
        {
          creatorId,
          direction: 'outbound',
          channel: 'email',
          occurredAt: '2026-07-13',
          summary: 'Sent verified MCP outreach',
          body: 'Complete outreach body.',
          statusAfter: 'contacted',
          requestId: 'mcp-test-outreach-batch',
        },
      ],
    },
  })
  const outreachBatchJson = JSON.parse(outreachBatch.result?.content?.[0]?.text ?? '{}')
  const outreachReplayJson = JSON.parse(outreachReplay.result?.content?.[0]?.text ?? '{}')
  const creatorPicks = await send('tools/call', {
    name: 'list_creator_picks',
    arguments: { gameId: g.id },
  })
  const gmassPreview = await send('tools/call', {
    name: 'preview_gmass_campaign',
    arguments: {
      gameId: g.id,
      creatorIds: [creatorId],
      addressCategories: ['verified_business'],
      subject: '{{gameName}} for {{creatorName}}',
      body: 'Key: {{gameKeys}}',
    },
  })
  const gmassCreated = await send('tools/call', {
    name: 'create_gmass_campaign',
    arguments: {
      gameId: g.id,
      creatorIds: [creatorId],
      addressCategories: ['verified_business'],
      subject: '{{gameName}} for {{creatorName}}',
      body: 'Key: {{gameKeys}}',
      name: 'MCP GMass batch',
      fromEmail: 'studio@example.com',
      sendMode: 'draft',
    },
  })
  const gmassCampaign = JSON.parse(gmassCreated.result?.content?.[0]?.text ?? '{}')
  await send('tools/call', {
    name: 'approve_gmass_campaign',
    arguments: {
      id: gmassCampaign.id,
      confirm: true,
      expectedRecipientCount: gmassCampaign.recipientCount,
      contentHash: gmassCampaign.contentHash,
    },
  })
  const gmassRead = await send('tools/call', { name: 'get_gmass_campaign', arguments: { id: gmassCampaign.id } })
  await send('tools/call', {
    name: 'create_festival',
    arguments: {
      name: 'MCP Cost Festival',
      startDate: '2026-09-10',
      costUsd: 125,
    },
  })
  const festivalList = await send('tools/call', { name: 'list_festivals', arguments: {} })
  const creatorList = await send('tools/call', { name: 'list_creators', arguments: {} })
  const activities = await send('tools/call', { name: 'list_activities', arguments: { gameId: g.id } })
  const tasks = await send('tools/call', { name: 'list_tasks', arguments: { gameId: g.id } })
  const taskSearch = await send('tools/call', {
    name: 'search_tasks',
    arguments: {
      gameId: g.id,
      query: 'From MCP',
      statuses: ['done'],
      priorities: ['high'],
      limit: 1,
      offset: 0,
    },
  })
  const filteredTasks = await send('tools/call', {
    name: 'list_tasks',
    arguments: { gameId: g.id, search: 'Second item', limit: 5 },
  })
  const unicodeTaskSearch = await send('tools/call', {
    name: 'search_tasks',
    arguments: { gameId: g.id, query: 'ЛЕНДИНГ' },
  })
  const tasksText = tasks.result?.content?.[0]?.text ?? ''
  const taskSearchText = taskSearch.result?.content?.[0]?.text ?? ''
  const filteredTasksText = filteredTasks.result?.content?.[0]?.text ?? ''
  const unicodeTaskSearchText = unicodeTaskSearch.result?.content?.[0]?.text ?? ''
  const cardText = card.result?.content?.[0]?.text ?? ''
  const gameWithLinksText = gameWithLinks.result?.content?.[0]?.text ?? ''
  const activitiesText = activities.result?.content?.[0]?.text ?? ''
  const insightCatalogText = insightCatalog.result?.content?.[0]?.text ?? ''
  const insightReadText = insightRead.result?.content?.[0]?.text ?? ''
  const insightUpdatedText = insightUpdated.result?.content?.[0]?.text ?? ''
  const projectCardUpdatedText = projectCardUpdated.result?.content?.[0]?.text ?? ''
  const projectCardReadText = projectCardRead.result?.content?.[0]?.text ?? ''
  const cardWithInsightText = cardWithInsight.result?.content?.[0]?.text ?? ''
  const wishlistText = wishlist.result?.content?.[0]?.text ?? ''
  const creatorText = creatorRead.result?.content?.[0]?.text ?? ''
  const creatorPicksText = creatorPicks.result?.content?.[0]?.text ?? ''
  const gmassPreviewText = gmassPreview.result?.content?.[0]?.text ?? ''
  const gmassReadText = gmassRead.result?.content?.[0]?.text ?? ''
  const festivalListText = festivalList.result?.content?.[0]?.text ?? ''
  const creatorListText = creatorList.result?.content?.[0]?.text ?? ''
  const activityTool = toolDefs.find((t) => t.name === 'create_activity')
  const creatorTool = toolDefs.find((t) => t.name === 'create_creator')
  const createTaskTool = toolDefs.find((t) => t.name === 'create_task')
  const updateTaskTool = toolDefs.find((t) => t.name === 'update_task')
  const focusText = focus.result?.content?.[0]?.text ?? ''
  const partialCompleteText = partialComplete.result?.content?.[0]?.text ?? ''
  const finalCompleteText = finalComplete.result?.content?.[0]?.text ?? ''
  const recurringCompletedText = recurringCompleted.result?.content?.[0]?.text ?? ''
  const recurringReadText = recurringRead.result?.content?.[0]?.text ?? ''
  const recurrenceDisabledText = recurrenceDisabled.result?.content?.[0]?.text ?? ''

  console.log('tools:', toolNames.length, '·', toolNames.slice(0, 5).join(', '), '…')
  console.log('server version:', initialized.result?.serverInfo?.version)
  console.log('list_games sees seeded game:', (games.result?.content?.[0]?.text || '').includes('MCP Game'))
  console.log('get_project_card sees seeded game:', cardText.includes('MCP Game'))
  console.log('official game links round-trip:', gameWithLinksText.includes('https://example.com/mcp-game'))
  console.log('create_task not error:', created.result?.isError !== true)
  console.log('focus queue includes checklist progress:', focusText.includes('Verify implementation'))
  console.log('direct done bypass rejected:', bypassCompletion.result?.isError === true)
  console.log(
    'atomic completion keeps then closes parent:',
    partialCompleteText.includes('"completed": false') && finalCompleteText.includes('"completed": true'),
  )
  console.log(
    'recurrence creates, advances and disables:',
    recurringCompletedText.includes('"recurring": true') &&
      recurringReadText.includes('"dueDate": "2099-02-28"') &&
      recurrenceDisabledText.includes('"recurrenceInterval": null'),
  )
  console.log('list_tasks has new task:', tasksText.includes('From MCP'))
  console.log(
    'search_tasks is compact and finds title:',
    taskSearchText.includes('From MCP') &&
      taskSearchText.includes('"totalCount": 1') &&
      !taskSearchText.includes('MCP checklist:'),
  )
  console.log(
    'list_tasks filtered mode searches descriptions:',
    filteredTasksText.includes('Second item') && filteredTasksText.includes('"totalCount": 1'),
  )
  console.log(
    'search_tasks handles Cyrillic case folding:',
    unicodeTaskSearchText.includes('Лендинг кампании') && unicodeTaskSearchText.includes('"totalCount": 1'),
  )
  console.log('activity create/edit round-trip:', activitiesText.includes('MCP journal entry edited'))
  console.log(
    'insight catalogue/full-text split:',
    insightCatalogText.includes('Players value readable automation') &&
      !insightCatalogText.includes('Full body must be loaded explicitly') &&
      insightReadText.includes('Full body must be loaded explicitly'),
  )
  console.log(
    'activity semantics preserved:',
    createdActivity.placement === 'r/CityBuilders' && createdActivity.createdBy === 'ai',
  )
  console.log('invalid chart correspondence rejected:', invalidActivity.result?.isError === true)
  console.log('wishlist/UTM round-trip:', wishlistText.includes('"adds": 12') && utmCreated.result?.isError !== true)
  console.log(
    'structured creator round-trip:',
    creatorText.includes('"topics"') &&
      creatorText.includes('city builder') &&
      creatorText.includes('"playedGames"') &&
      creatorText.includes('Against the Storm'),
  )
  console.log('creator keys round-trip:', creatorPicksText.includes('DDDDD-EEEEE-FFFFF'))
  console.log(
    'GMass MCP preview/queue:',
    gmassPreviewText.includes('business@example.com') && gmassReadText.includes('"status": "queued"'),
  )
  console.log(
    'universal participation cost round-trip:',
    festivalListText.includes('"costUsd": 125') && creatorListText.includes('"costUsd": 750'),
  )

  clearTimeout(guard)
  child.kill()

  if (toolNames.length < 40) throw new Error('expected >=40 tools')
  if (initialized.result?.serverInfo?.version !== require('../packages/mcp-server/package.json').version)
    throw new Error('MCP server version is not synchronized with its package')
  if (!toolNames.includes('create_task') || !toolNames.includes('list_tasks') || !toolNames.includes('search_tasks'))
    throw new Error('task tools missing')
  if (
    !taskSearchText.includes('From MCP') ||
    !taskSearchText.includes('"totalCount": 1') ||
    taskSearchText.includes('MCP checklist:')
  )
    throw new Error('search_tasks compact title search failed')
  if (!filteredTasksText.includes('Second item') || !filteredTasksText.includes('"totalCount": 1'))
    throw new Error('list_tasks filtered description search failed')
  if (!unicodeTaskSearchText.includes('Лендинг кампании') || !unicodeTaskSearchText.includes('"totalCount": 1'))
    throw new Error('search_tasks Cyrillic case folding failed')
  if (!toolNames.includes('get_project_card') || !toolNames.includes('update_project_card'))
    throw new Error('project card tools missing')
  for (const name of ['list_insights', 'get_insight', 'create_insight', 'update_insight', 'delete_insight']) {
    if (!toolNames.includes(name)) throw new Error(`insight tool missing: ${name}`)
  }
  if (!toolNames.includes('list_festivals') || !toolNames.includes('import_festivals'))
    throw new Error('festival tools missing')
  if (
    !toolNames.includes('list_activities') ||
    !toolNames.includes('create_activity') ||
    !toolNames.includes('update_activity')
  )
    throw new Error('activity tools missing')
  for (const name of [
    'get_game',
    'update_game',
    'add_wishlist_point',
    'get_wishlist_impact',
    'list_utm_links',
    'build_utm_link',
    'list_sources',
    'create_source',
    'get_creator',
    'update_creator',
    'log_touches_bulk',
    'set_checklist_item',
    'get_next_actions',
    'complete_task',
    'preview_gmass_campaign',
    'create_gmass_campaign',
    'approve_gmass_campaign',
    'sync_gmass_campaign',
  ]) {
    if (!toolNames.includes(name)) throw new Error(`semantic domain tool missing: ${name}`)
  }
  if (!JSON.stringify(activityTool?.inputSchema?.properties?.platform).includes('reddit'))
    throw new Error('activity platform enum missing from MCP JSON schema')
  if (!JSON.stringify(activityTool?.inputSchema?.properties?.placement).includes('subreddit'))
    throw new Error('activity placement semantics missing from MCP JSON schema')
  if (creatorTool?.inputSchema?.properties?.topics?.type !== 'array')
    throw new Error('creator topics must be a structured array, not encoded JSON')
  if (creatorTool?.inputSchema?.properties?.playedGames?.type !== 'array')
    throw new Error('creator playedGames must be a structured array, not encoded JSON')
  if (
    outreachBatchJson.results?.[0]?.pick?.pipelineStatus !== 'contacted' ||
    outreachReplayJson.results?.[0]?.replayed !== true ||
    outreachReplayJson.results?.[0]?.id !== outreachBatchJson.results?.[0]?.id
  )
    throw new Error('idempotent creator outreach batch failed')
  if (createTaskTool?.inputSchema?.properties?.recurrence?.type !== 'object')
    throw new Error('create_task recurrence input is missing from MCP JSON schema')
  if (!JSON.stringify(updateTaskTool?.inputSchema?.properties?.recurrence).includes('null'))
    throw new Error('update_task cannot disable recurrence through MCP')
  if (!cardText.includes('MCP Game')) throw new Error('project card lookup failed')
  if (!gameWithLinksText.includes('https://example.com/mcp-game') || !gameWithLinksText.includes('"type": "youtube"'))
    throw new Error('official game links MCP round-trip failed')
  if (created.result?.isError === true) throw new Error('create_task errored')
  if (!focusText.includes('Verify implementation')) throw new Error('focus queue omitted checklist context')
  if (bypassCompletion.result?.isError !== true)
    throw new Error('update_task allowed bypassing checklist reconciliation')
  if (!partialCompleteText.includes('"completed": false') || !partialCompleteText.includes('Verify tracker state'))
    throw new Error('complete_task did not report remaining checklist work')
  if (!finalCompleteText.includes('"completed": true') || !finalCompleteText.includes('"status": "done"'))
    throw new Error('complete_task did not close the reconciled task')
  if (
    recurringCreated.result?.isError === true ||
    !recurringCompletedText.includes('"recurring": true') ||
    !recurringCompletedText.includes('"nextDueDate": "2099-02-28"') ||
    !recurringReadText.includes('"status": "todo"') ||
    !recurrenceDisabledText.includes('"recurrenceInterval": null')
  )
    throw new Error('recurring task MCP create/complete/update round-trip failed')
  if (!activityId || activityUpdated.result?.isError === true || !activitiesText.includes('MCP journal entry edited'))
    throw new Error('activity create/edit round-trip failed')
  if (
    !createdInsight.id ||
    createdInsight.createdBy !== 'mcp' ||
    requiredProjectCard?.title !== 'Карточка проекта' ||
    requiredProjectCard?.required !== true ||
    !projectCardUpdatedText.includes('Canonical MCP brief for influencer outreach.') ||
    !projectCardUpdatedText.includes('"createdBy": "mcp"') ||
    !projectCardReadText.includes('Canonical MCP brief for influencer outreach.') ||
    projectCardDelete.result?.isError !== true ||
    duplicateProjectCard.result?.isError !== true ||
    !insightCatalogText.includes('Players value readable automation') ||
    insightCatalogText.includes('Full body must be loaded explicitly') ||
    !insightReadText.includes('Full body must be loaded explicitly') ||
    !insightUpdatedText.includes('Evidence grew to 31 comments') ||
    !cardWithInsightText.includes('Players value readable automation') ||
    cardWithInsightText.includes('Evidence grew to 31 comments')
  )
    throw new Error('insight title-catalogue/full-text/provenance round-trip failed')
  if (
    createdActivity.placement !== 'r/CityBuilders' ||
    createdActivity.platform !== 'reddit' ||
    createdActivity.type !== 'post' ||
    createdActivity.createdBy !== 'ai' ||
    createdActivity.channel !== null ||
    createdActivity.direction !== null
  )
    throw new Error('activity semantic fields/provenance were not preserved')
  if (invalidActivity.result?.isError !== true) throw new Error('chart-visible correspondence must be rejected')
  if (!wishlistText.includes('"adds": 12') || utmCreated.result?.isError === true)
    throw new Error('wishlist/UTM MCP round-trip failed')
  if (
    !creatorId ||
    !creatorText.includes('"topics"') ||
    !creatorText.includes('city builder') ||
    !creatorText.includes('"playedGames"') ||
    !creatorText.includes('Against the Storm')
  )
    throw new Error('structured creator MCP round-trip failed')
  if (!creatorPicksText.includes('DDDDD-EEEEE-FFFFF')) throw new Error('creator keys MCP round-trip failed')
  if (!gmassPreviewText.includes('business@example.com') || !gmassReadText.includes('"status": "queued"'))
    throw new Error('GMass MCP preview/queue round-trip failed')
  if (!festivalListText.includes('"costUsd": 125') || !creatorListText.includes('"costUsd": 750'))
    throw new Error('universal participation cost was omitted from MCP catalogue reads')
  if (!tasksText.includes('From MCP')) throw new Error('write+read round-trip failed')
  if (!tasksText.includes('MCP checklist:\\n- First item\\n- Second item'))
    throw new Error('MCP task Markdown description was not preserved')
  console.log('MCP OK')
}

main().catch((e) => {
  console.error('MCP FAIL', e)
  process.exit(1)
})
