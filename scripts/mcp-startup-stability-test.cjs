/* Verify that a busy database cannot delay the MCP handshake or kill one persistent stdio session. */
const { spawn } = require('node:child_process')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { appRouter } = require('@marcat/core')
const {
  creatorDiscoveryCandidates,
  creatorDiscoveryContacts,
  creatorDiscoveryRunCandidates,
  DatabaseWriteLock,
  createDb,
  fileUrlFromPath,
  runMigrations,
  workspaceConfigs,
} = require('@marcat/db')

function deferredResponse(child) {
  const pending = new Map()
  let buffer = ''
  child.stdout.on('data', (data) => {
    buffer += data.toString()
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim()
      buffer = buffer.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line)
      const resolve = pending.get(message.id)
      if (resolve) {
        pending.delete(message.id)
        resolve(message)
      }
    }
  })

  let nextId = 1
  return {
    send(method, params, timeoutMs = 10_000) {
      return new Promise((resolve, reject) => {
        const id = nextId++
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
        pending.set(id, (message) => {
          clearTimeout(timer)
          resolve(message)
        })
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      })
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    },
  }
}

function removeTempDirectory(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error
    // The local libSQL binding can release its final Windows directory handle only
    // as this test process exits. A detached one-shot cleaner removes the fixture.
    const cleaner = spawn(
      process.execPath,
      [
        '-e',
        "const fs=require('node:fs');setTimeout(()=>fs.rmSync(process.argv[1],{recursive:true,force:true,maxRetries:20,retryDelay:100}),500)",
        dir,
      ],
      { detached: true, stdio: 'ignore', windowsHide: true },
    )
    cleaner.unref()
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marcat-mcp-stability-'))
  const dbFile = path.join(dir, 'marcat.db')
  const serverPath = path.join(__dirname, '..', 'packages', 'mcp-server', 'dist', 'index.cjs')
  const { db, client } = createDb(fileUrlFromPath(dbFile))
  await runMigrations(db, client, path.join(require.resolve('@marcat/db'), '..', '..', 'migrations'))
  const game = await appRouter.createCaller({ db }).games.create({ name: 'Persistent MCP' })
  const setupCaller = appRouter.createCaller({ db })
  const profile = await setupCaller.creatorDiscovery.createProfile({
    gameId: game.id,
    name: 'Colonial America stability fixture',
    mode: 'topic',
    languages: ['en'],
    includeTerms: ['colonial america'],
    excludeTerms: [],
    seedChannels: [],
    maxSearchRequests: 1,
    maxChannels: 500,
    recentVideoLimit: 10,
    discoverContacts: true,
    references: [{ label: 'Colonial America', aliases: [], queryTerms: ['colonial america'], weight: 1 }],
  })
  const discovery = await setupCaller.creatorDiscovery.start({ profileId: profile.id, forceNew: true })
  const runId = discovery.run.id
  const candidateIds = Array.from({ length: 249 }, () => randomUUID())
  for (let offset = 0; offset < candidateIds.length; offset += 25) {
    const ids = candidateIds.slice(offset, offset + 25)
    await db.insert(creatorDiscoveryCandidates).values(
      ids.map((id, index) => {
        const ordinal = offset + index
        return {
          id,
          externalId: `stability-${ordinal}`,
          name: `Colonial creator ${ordinal}`,
          handle: `@colonial-${ordinal}`,
          channelUrl: `https://www.youtube.com/channel/stability-${ordinal}`,
          description: `Long-running MCP stability candidate ${ordinal}. ${'historical games and colonial america '.repeat(120)}`,
          subscriberCount: 10_000 + ordinal,
          avgViews: 1_000 + ordinal,
          fetchedAt: new Date().toISOString(),
          expiresAt: '2099-01-01T00:00:00.000Z',
        }
      }),
    )
    await db.insert(creatorDiscoveryRunCandidates).values(
      ids.map((candidateId, index) => ({
        runId,
        candidateId,
        fitScore: 90 - ((offset + index) % 20),
        matchedReferenceCount: 1,
        matchedReferencesJson: '["Colonial America"]',
        matchedVideoCount: 3,
        fitReasonsJson: '["Reference matched"]',
      })),
    )
    await db.insert(creatorDiscoveryContacts).values(
      ids.map((candidateId, index) => ({
        runId,
        candidateId,
        type: 'business_email',
        value: `creator-${offset + index}@example.com`,
        normalizedValue: `creator-${offset + index}@example.com`,
        sourceUrl: `https://www.youtube.com/channel/stability-${offset + index}/about`,
        confidence: 0.9,
      })),
    )
  }
  await db.insert(workspaceConfigs).values({
    gameId: game.id,
    rootPath: dir,
    workspaceFolder: 'Workspace',
    enabled: true,
  })
  client.close()

  const writeLock = new DatabaseWriteLock(dbFile)
  const release = await writeLock.acquire('MCP startup stability test')
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, MARCAT_DB: dbFile },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (data) => {
    stderr += data.toString()
  })
  const rpc = deferredResponse(child)

  try {
    const startedAt = Date.now()
    const initialized = await rpc.send(
      'initialize',
      {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'startup-stability-test', version: '0' },
      },
      5_000,
    )
    const handshakeMs = Date.now() - startedAt
    if (!initialized.result?.serverInfo || handshakeMs >= 5_000) {
      throw new Error(`MCP handshake was not ready while the database was busy (${handshakeMs}ms)`)
    }
    rpc.notify('notifications/initialized', {})
    const tools = await rpc.send('tools/list', {}, 5_000)
    if ((tools.result?.tools ?? []).length < 90) throw new Error('MCP tool catalogue is incomplete')

    release()
    const calls = []
    for (let index = 0; index < 250; index += 1) {
      calls.push(rpc.send('tools/call', { name: 'list_games', arguments: {} }, 15_000))
      if (calls.length === 10) {
        const batch = await Promise.all(calls.splice(0))
        if (batch.some((response) => response.error || response.result?.isError)) {
          throw new Error('Persistent MCP session returned an error')
        }
      }
    }
    if (calls.length) await Promise.all(calls)
    for (let index = 0; index < 125; index += 1) {
      const reviewed = await rpc.send(
        'tools/call',
        {
          name: 'review_creator_discovery_candidate',
          arguments: {
            runId,
            candidateId: candidateIds[index],
            decision: index < 43 ? 'promote' : 'dismiss',
          },
        },
        30_000,
      )
      if (reviewed.error || reviewed.result?.isError) {
        throw new Error(`Creator review ${index + 1}/125 failed: ${JSON.stringify(reviewed)}`)
      }
      if ((index + 1) % 25 === 0) {
        const page = await rpc.send(
          'tools/call',
          {
            name: 'list_creator_discovery_candidates',
            arguments: { runId, offset: Math.max(0, index - 19), limit: 20 },
          },
          30_000,
        )
        if (page.error || page.result?.isError) throw new Error(`Creator page failed after ${index + 1} reviews`)
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    const finalPage = await rpc.send(
      'tools/call',
      { name: 'list_creator_discovery_candidates', arguments: { runId, status: 'staged', offset: 0, limit: 20 } },
      30_000,
    )
    if (finalPage.error || finalPage.result?.isError) {
      throw new Error(`MCP session failed after 125 creator reviews: ${JSON.stringify(finalPage)}`)
    }
    const finalPageJson = JSON.parse(finalPage.result?.content?.[0]?.text ?? '{}')
    if (!Array.isArray(finalPageJson.items) || finalPageJson.items.length !== 20 || finalPageJson.nextOffset !== 20) {
      throw new Error(`Creator page envelope is not exact in the middle: ${JSON.stringify(finalPageJson)}`)
    }
    let stagedCount = finalPageJson.items.length
    let nextOffset = finalPageJson.nextOffset
    let terminalPageJson = finalPageJson
    while (nextOffset !== null) {
      const page = await rpc.send(
        'tools/call',
        {
          name: 'list_creator_discovery_candidates',
          arguments: { runId, status: 'staged', offset: nextOffset, limit: 20 },
        },
        30_000,
      )
      if (page.error || page.result?.isError) {
        throw new Error(`Creator page at offset ${nextOffset} failed: ${JSON.stringify(page)}`)
      }
      terminalPageJson = JSON.parse(page.result?.content?.[0]?.text ?? '{}')
      if (
        !Array.isArray(terminalPageJson.items) ||
        terminalPageJson.offset !== nextOffset ||
        terminalPageJson.returned !== terminalPageJson.items.length ||
        terminalPageJson.items.length < 1 ||
        terminalPageJson.items.length > 20
      ) {
        throw new Error(`Creator page envelope is invalid: ${JSON.stringify(terminalPageJson)}`)
      }
      stagedCount += terminalPageJson.items.length
      nextOffset = terminalPageJson.nextOffset
    }
    if (stagedCount !== candidateIds.length - 125 || terminalPageJson.items.length >= 20) {
      throw new Error(
        `Creator pagination did not end exactly at the remaining staged rows: ${JSON.stringify({ stagedCount, terminalPageJson })}`,
      )
    }
    if (child.exitCode != null) throw new Error(`MCP process exited unexpectedly with code ${child.exitCode}`)
    child.stdin.end()
    const exitCode = await new Promise((resolve, reject) => {
      if (child.exitCode != null) return resolve(child.exitCode)
      const timer = setTimeout(
        () => reject(new Error('MCP process stayed alive after its stdio client disconnected')),
        5_000,
      )
      child.once('exit', (code) => {
        clearTimeout(timer)
        resolve(code)
      })
    })
    if (exitCode !== 0) throw new Error(`MCP process exited with code ${exitCode}\n${stderr}`)
    const mcpLog = fs.readFileSync(path.join(dir, 'mcp.log'), 'utf8')
    if (!mcpLog.includes('tool complete name=list_creator_discovery_candidates')) {
      throw new Error('Persistent MCP log did not record the final creator candidate page')
    }
    console.log(
      `MCP STARTUP STABILITY OK (handshake ${handshakeMs}ms, 250 reads + 125 creator reviews, clean disconnect, pid ${child.pid})`,
    )
  } finally {
    release()
    if (!child.stdin.destroyed) child.stdin.end()
    await new Promise((resolve) => {
      if (child.exitCode != null) return resolve()
      child.once('exit', resolve)
      setTimeout(() => {
        child.kill()
        resolve()
      }, 5_000).unref()
    })
    removeTempDirectory(dir)
    if (child.exitCode && child.exitCode !== 0) process.stderr.write(stderr)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
