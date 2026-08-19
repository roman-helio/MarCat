/* Verify MCP 2026-07-28 negotiation over stdio while keeping the legacy endpoint available. */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { appRouter } = require('@marcat/core')
const {
  createDb,
  creatorDiscoveryCandidates,
  creatorDiscoveryProfiles,
  creatorDiscoveryRunCandidates,
  creatorDiscoveryRuns,
  fileUrlFromPath,
  runMigrations,
} = require('@marcat/db')
const { Client } = require('@modelcontextprotocol/client')
const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/client/stdio')

const PROTOCOL_VERSION = '2026-07-28'

async function removeDirectoryEventually(dir) {
  let lastError
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      return
    } catch (error) {
      lastError = error
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
  throw lastError
}

async function exercise(serverPath, dbFile, candidate, mode) {
  const client = new Client(
    { name: `marcat-v2-${typeof mode === 'string' ? mode : 'pinned'}`, version: '0' },
    { versionNegotiation: { mode, probe: { timeoutMs: 5_000 } } },
  )
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverPath],
    env: { ...getDefaultEnvironment(), MARCAT_DB: dbFile },
    stderr: 'pipe',
  })
  let stderr = ''
  transport.stderr?.on('data', (data) => {
    stderr += data.toString()
  })

  try {
    await client.connect(transport)
    if (client.getProtocolEra() !== 'modern') {
      throw new Error(`Expected modern MCP era, got ${client.getProtocolEra() ?? 'none'}\n${stderr}`)
    }
    if (client.getNegotiatedProtocolVersion() !== PROTOCOL_VERSION) {
      throw new Error(`Expected MCP ${PROTOCOL_VERSION}, got ${client.getNegotiatedProtocolVersion() ?? 'none'}`)
    }
    const tools = await client.listTools()
    if (tools.tools.length < 90) throw new Error(`MCP v2 tool catalogue is incomplete (${tools.tools.length})`)
    const result = await client.callTool({ name: 'list_games', arguments: {} })
    if (result.isError) throw new Error(`MCP v2 tool call failed: ${JSON.stringify(result.content)}`)
    const reviewed = await client.callTool({
      name: 'review_creator_discovery_candidate',
      arguments: { ...candidate, decision: 'promote' },
    })
    if (reviewed.isError) throw new Error(`MCP v2 creator review failed: ${JSON.stringify(reviewed.content)}`)
    const afterReview = await client.callTool({ name: 'list_games', arguments: {} })
    if (afterReview.isError) throw new Error('MCP v2 transport closed after creator review')
    return { tools: tools.tools.length, pid: transport.pid }
  } finally {
    await client.close().catch(() => transport.close())
  }
}

async function exerciseProbeFallback(serverPath, dbFile, candidate) {
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, MARCAT_DB: dbFile },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  let buffer = ''
  let nextId = 1
  const pending = new Map()
  child.stderr.on('data', (data) => {
    stderr += data.toString()
  })
  child.stdout.on('data', (data) => {
    buffer += data.toString()
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line)
      const resolve = pending.get(String(message.id))
      if (!resolve) continue
      pending.delete(String(message.id))
      resolve(message)
    }
  })
  const send = (method, params, id = nextId++) =>
    new Promise((resolve, reject) => {
      const key = String(id)
      const timeout = setTimeout(() => {
        pending.delete(key)
        reject(new Error(`${method} timed out during MCP probe fallback\n${stderr}`))
      }, 15_000)
      pending.set(key, (message) => {
        clearTimeout(timeout)
        resolve(message)
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  const notify = (method, params) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)

  try {
    const probe = await send(
      'server/discover',
      {
        _meta: {
          'io.modelcontextprotocol/protocolVersion': PROTOCOL_VERSION,
          'io.modelcontextprotocol/clientInfo': { name: 'marcat-v2-fallback-probe', version: '0' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
      'probe',
    )
    if (!probe.result?.supportedVersions?.includes(PROTOCOL_VERSION)) {
      throw new Error(`MCP modern probe failed before legacy fallback\n${stderr}`)
    }
    const initialized = await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'marcat-v2-fallback-session', version: '0' },
    })
    if (!initialized.result) {
      throw new Error(
        `MCP legacy fallback did not receive a fresh server instance: ${initialized.error?.message}\n${stderr}`,
      )
    }
    notify('notifications/initialized', {})
    const reviewed = await send('tools/call', {
      name: 'review_creator_discovery_candidate',
      arguments: { ...candidate, decision: 'promote' },
    })
    if (reviewed.error || reviewed.result?.isError) {
      throw new Error(`MCP legacy fallback creator review failed: ${JSON.stringify(reviewed)}\n${stderr}`)
    }
    const afterReview = await send('tools/call', { name: 'list_games', arguments: {} })
    if (afterReview.error || afterReview.result?.isError) {
      throw new Error(`MCP legacy fallback transport closed after creator review\n${stderr}`)
    }
  } finally {
    child.stdin.end()
    const forceKill = setTimeout(() => child.kill(), 5_000)
    await new Promise((resolve) => child.once('exit', resolve))
    clearTimeout(forceKill)
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marcat-mcp-v2-'))
  const dbFile = path.join(dir, 'marcat.db')
  const serverPath = path.join(__dirname, '..', 'packages', 'mcp-server', 'dist', 'index.cjs')
  try {
    const database = createDb(fileUrlFromPath(dbFile))
    await runMigrations(
      database.db,
      database.client,
      path.join(require.resolve('@marcat/db'), '..', '..', 'migrations'),
    )
    const game = await appRouter.createCaller({ db: database.db }).games.create({ name: 'MCP v2 review transport' })
    const profileId = crypto.randomUUID()
    const runId = crypto.randomUUID()
    const candidateId = crypto.randomUUID()
    await database.db.insert(creatorDiscoveryProfiles).values({
      id: profileId,
      gameId: game.id,
      name: 'MCP v2 review transport',
    })
    await database.db.insert(creatorDiscoveryRuns).values({
      id: runId,
      gameId: game.id,
      profileId,
      profileHash: 'mcp-v2-review-transport',
      profileSnapshotJson: '{}',
      status: 'completed',
      phase: 'completed',
      candidatesStaged: 1,
    })
    await database.db.insert(creatorDiscoveryCandidates).values({
      id: candidateId,
      externalId: 'mcp-v2-review-candidate',
      name: 'MCP v2 review candidate',
      channelUrl: 'https://youtube.com/@mcp-v2-review-candidate',
      expiresAt: '2099-01-01T00:00:00.000Z',
    })
    await database.db.insert(creatorDiscoveryRunCandidates).values({
      runId,
      candidateId,
      fitScore: 100,
      matchedReferenceCount: 1,
      matchedReferencesJson: '["MCP v2"]',
      matchedVideoCount: 1,
      fitReasonsJson: '["Protocol transport regression"]',
    })
    database.client.close()
    const candidate = { runId, candidateId }

    const pinned = await exercise(serverPath, dbFile, candidate, { pin: PROTOCOL_VERSION })
    const automatic = await exercise(serverPath, dbFile, candidate, 'auto')
    await exerciseProbeFallback(serverPath, dbFile, candidate)
    console.log(
      `MCP ${PROTOCOL_VERSION} OK (${automatic.tools} tools, review transport stable, pinned pid ${pinned.pid}, auto pid ${automatic.pid})`,
    )
  } finally {
    await removeDirectoryEventually(dir)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
