/* Guard against invalid MCP transports produced by Codex's layered config merge. */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const repo = path.resolve(__dirname, '..')
const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
const layers = [
  { label: 'global', file: path.join(codexHome, 'config.toml') },
  { label: 'project', file: path.join(repo, '.codex', 'config.toml') },
]

function unquoteTomlName(name) {
  const value = name.trim()
  if (value.length >= 2 && value[0] === '"' && value.at(-1) === '"') {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (value.length >= 2 && value[0] === "'" && value.at(-1) === "'") {
    return value.slice(1, -1).replace(/''/g, "'")
  }
  return value
}

function readMcpTransports(layer) {
  if (!fs.existsSync(layer.file)) return []

  const entries = []
  let current = null
  const lines = fs.readFileSync(layer.file, 'utf8').split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const section = line.match(/^\s*\[\s*mcp_servers\.((?:"(?:\\.|[^"])*)"|'[^']*'|[^.\]\s]+)\s*\]\s*(?:#.*)?$/)
    if (section) {
      current = { name: unquoteTomlName(section[1]), line: index + 1 }
      continue
    }

    if (/^\s*\[/.test(line)) {
      current = null
      continue
    }

    if (!current) continue
    const key = line.match(/^\s*(command|url)\s*=/)
    if (key) {
      entries.push({
        name: current.name,
        transport: key[1] === 'command' ? 'stdio' : 'streamable_http',
        key: key[1],
        layer: layer.label,
        file: layer.file,
        line: index + 1,
      })
    }
  }

  return entries
}

const entries = layers.flatMap(readMcpTransports)
const byName = new Map()
for (const entry of entries) {
  const group = byName.get(entry.name) ?? []
  group.push(entry)
  byName.set(entry.name, group)
}

const conflicts = [...byName.entries()].filter(([, definitions]) => {
  return new Set(definitions.map((definition) => definition.transport)).size > 1
})

if (conflicts.length > 0) {
  console.error('Invalid layered Codex MCP configuration:')
  for (const [name, definitions] of conflicts) {
    console.error(`  ${name} resolves to more than one transport:`)
    for (const definition of definitions) {
      console.error(
        `    ${definition.layer}: ${definition.key} (${definition.transport}) at ${definition.file}:${definition.line}`,
      )
    }
  }
  console.error('\nUse either command/args (stdio) or url (streamable HTTP) for each server name across all layers.')
  process.exitCode = 1
} else {
  const checked = layers.filter((layer) => fs.existsSync(layer.file)).map((layer) => layer.file)
  console.log(`Codex MCP config is transport-safe (${checked.join(' + ') || 'no config files found'}).`)
}
