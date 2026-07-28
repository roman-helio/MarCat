const fs = require('node:fs')
const path = require('node:path')

const repo = path.resolve(__dirname, '..')
const seedPath = path.join(repo, 'release-data', 'steam-festivals.json')
const entries = JSON.parse(fs.readFileSync(seedPath, 'utf8'))
const allowedKeys = ['applyDeadline', 'endDate', 'name', 'startDate', 'type']
const isoDay = /^\d{4}-\d{2}-\d{2}$/

if (!Array.isArray(entries) || entries.length === 0) throw new Error('Public festival catalogue is empty')

const seen = new Set()
for (const [index, entry] of entries.entries()) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`Invalid entry at index ${index}`)
  const keys = Object.keys(entry).sort()
  if (keys.join('|') !== allowedKeys.join('|')) {
    throw new Error(
      `Entry ${index} has non-public fields: ${keys.filter((key) => !allowedKeys.includes(key)).join(', ')}`,
    )
  }
  if (typeof entry.name !== 'string' || !entry.name.trim()) throw new Error(`Entry ${index} has no name`)
  if (!['festival', 'sale'].includes(entry.type)) throw new Error(`Entry ${index} has invalid type`)
  for (const field of ['startDate', 'endDate', 'applyDeadline']) {
    if (entry[field] !== null && (typeof entry[field] !== 'string' || !isoDay.test(entry[field]))) {
      throw new Error(`Entry ${index} has invalid ${field}`)
    }
  }
  if (entry.startDate === null) throw new Error(`Entry ${index} has no startDate`)
  const identity = `${entry.name.trim().toLocaleLowerCase('en-US')}\0${entry.startDate}`
  if (seen.has(identity)) throw new Error(`Duplicate public festival: ${entry.name} (${entry.startDate})`)
  seen.add(identity)
}

console.log(`Public festival catalogue is sanitized: ${entries.length} dated entries, public fields only.`)
