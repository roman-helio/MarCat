/*
 * Print what is inside every MarCat database on this machine, ranked so the live
 * one is first.
 *
 * The point is to answer "which of these is my real data?" without opening the
 * app and without comparing thousands of rows by hand. Every file is copied
 * before it is read, so running this can never modify a database or a backup.
 *
 *   npm run db:identify
 */
const fs = require('node:fs')
const path = require('node:path')
const { summarizeDatabase, compareDatabases, describeShortfall } = require('@marcat/db')

const userData = path.join(process.env.APPDATA || process.env.HOME || '', 'MarCat')

function candidates() {
  const found = []
  const scan = (dir, depth) => {
    if (!fs.existsSync(dir)) return
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name)
      let stats
      try {
        stats = fs.statSync(full)
      } catch {
        continue
      }
      // Never descend into dot-directories: scratch space belongs to tools, and
      // a scan that reads its own working copies reports them as candidates.
      if (stats.isDirectory() && depth > 0 && !name.startsWith('.')) scan(full, depth - 1)
      else if (stats.isFile() && name.endsWith('.db') && !name.startsWith('.')) found.push(full)
    }
  }
  scan(userData, 2)
  return found
}

function marker() {
  const file = path.join(userData, 'active-db-path.txt')
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : ''
  } catch {
    return ''
  }
}

async function main() {
  const files = candidates()
  if (!files.length) {
    console.log(`No databases found under ${userData}`)
    return
  }
  const active = marker() || path.join(userData, 'marcat.db')
  console.log(`Data folder : ${userData}`)
  console.log(`In use      : ${active}${marker() ? ' (from the marker)' : ' (default, no marker)'}`)
  console.log(`Scanned     : ${files.length} database files\n`)

  const summaries = []
  for (const file of files) summaries.push(await summarizeDatabase(file))
  const ranked = summaries.filter((s) => s.readable).sort(compareDatabases)
  const best = ranked[0]

  const row = (summary) => {
    const name = summary.path.replace(userData + path.sep, '')
    const inUse = path.resolve(summary.path) === path.resolve(active) ? ' <= IN USE' : ''
    if (!summary.readable) return `  ${name}\n      unreadable: ${summary.error}`
    const shortfall = best && summary !== best ? describeShortfall(summary, best) : undefined
    return [
      `  ${name}${inUse}`,
      `      last change ${summary.newestChange ?? 'unknown'} · ${summary.totalRows} rows · ` +
        `${(summary.sizeBytes / 1048576).toFixed(1)} MB`,
      `      creators ${summary.counts.creators ?? 0} · picks ${summary.counts.creator_picks ?? 0} · ` +
        `tasks ${summary.counts.tasks ?? 0} · events ${summary.counts.events ?? 0} · ` +
        `wishlist ${summary.counts.wishlist_points ?? 0}`,
      shortfall ? `      behind the fullest one by: ${shortfall}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  }

  console.log('Ranked by how recent the data inside them is:\n')
  for (const summary of ranked) console.log(row(summary) + '\n')

  const unreadable = summaries.filter((s) => !s.readable)
  if (unreadable.length) {
    console.log('Could not be read:\n')
    for (const summary of unreadable) console.log(row(summary) + '\n')
  }

  if (best && path.resolve(best.path) !== path.resolve(active)) {
    console.log('WARNING: the database in use is not the fullest one available.')
    const activeSummary = summaries.find((s) => path.resolve(s.path) === path.resolve(active))
    const shortfall = activeSummary ? describeShortfall(activeSummary, best) : undefined
    if (shortfall) console.log(`         In use is behind ${path.basename(best.path)} by: ${shortfall}`)
  } else if (best) {
    console.log('The database in use is the fullest one available.')
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
