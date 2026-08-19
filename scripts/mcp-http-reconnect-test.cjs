/* Verify that independent Codex-style HTTP sessions can reconnect to one durable MarCat MCP endpoint. */
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { appRouter } = require('@marcat/core')
const { createDb, fileUrlFromPath, runMigrations } = require('@marcat/db')
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client')

async function freePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function waitForHealth(url, stderr) {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) return response.json()
    } catch {
      // The listener may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`MCP HTTP endpoint did not become healthy\n${stderr()}`)
}

async function connectAndRead(url, expectedGameId, sequence) {
  const client = new Client(
    { name: `marcat-http-reconnect-${sequence}`, version: '0' },
    { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 5_000 } } },
  )
  const transport = new StreamableHTTPClientTransport(new URL(url))
  try {
    await client.connect(transport)
    const tools = await client.listTools()
    if (tools.tools.length < 90) throw new Error(`MCP HTTP tool catalogue is incomplete (${tools.tools.length})`)
    const result = await client.callTool({ name: 'list_games', arguments: {} })
    if (result.isError) throw new Error(`MCP HTTP read failed: ${JSON.stringify(result.content)}`)
    const text = result.content?.find((item) => item.type === 'text')?.text ?? ''
    if (!text.includes(expectedGameId)) throw new Error(`MCP HTTP read did not return the seeded game: ${text}`)
    return tools.tools.length
  } finally {
    await client.close().catch(() => transport.close())
  }
}

async function removeDirectoryEventually(dir) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      return
    } catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt === 9) throw error
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
    }
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marcat-mcp-http-'))
  const dbFile = path.join(dir, 'marcat.db')
  const serverPath = path.join(__dirname, '..', 'packages', 'mcp-server', 'dist', 'index.cjs')
  const port = await freePort()
  const mcpUrl = `http://127.0.0.1:${port}/mcp`
  let child
  let stderr = ''
  try {
    const database = createDb(fileUrlFromPath(dbFile))
    await runMigrations(
      database.db,
      database.client,
      path.join(require.resolve('@marcat/db'), '..', '..', 'migrations'),
    )
    const game = await appRouter.createCaller({ db: database.db }).games.create({ name: 'MCP HTTP reconnect' })
    database.client.close()

    child = spawn(process.execPath, [serverPath, '--http', '--port', String(port)], {
      env: { ...process.env, MARCAT_DB: dbFile },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    child.stderr.on('data', (data) => {
      stderr += data.toString()
    })
    const firstHealth = await waitForHealth(`http://127.0.0.1:${port}/health`, () => stderr)
    const toolCount = await connectAndRead(mcpUrl, game.id, 1)

    // Closing a task/client must not close the shared endpoint. A later task negotiates a fresh session.
    await new Promise((resolve) => setTimeout(resolve, 500))
    const secondHealth = await waitForHealth(`http://127.0.0.1:${port}/health`, () => stderr)
    if (secondHealth.pid !== firstHealth.pid) throw new Error('MCP HTTP server restarted between client sessions')
    await connectAndRead(mcpUrl, game.id, 2)
    console.log(`MCP HTTP reconnect OK (${toolCount} tools, stable pid ${firstHealth.pid})`)
  } finally {
    if (child && child.exitCode === null) {
      child.kill()
      await new Promise((resolve) => child.once('exit', resolve))
    }
    await removeDirectoryEventually(dir)
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
