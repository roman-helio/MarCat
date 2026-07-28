/* Import the shared Steam-festival tracking Google Sheet into MarCat's industry_events. */
const fs = require('node:fs')
const path = require('node:path')
const { appRouter } = require('@marcat/core')
const { backfillTaskKeys, configureConnection, createDb, fileUrlFromPath, runMigrations } = require('@marcat/db')

const SHEET_ID = '1datCLXWo4cbus6G9hIVIZ5uhb2wRZWvksy8a0P8XiO8'
const GID = '1650006856'
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit?gid=${GID}`
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${GID}`
const DEFAULT_YEAR = 2026

const MONTHS = new Map([
  ['январь', 1],
  ['января', 1],
  ['янв', 1],
  ['февраль', 2],
  ['февраля', 2],
  ['фев', 2],
  ['март', 3],
  ['марта', 3],
  ['мар', 3],
  ['апрель', 4],
  ['апреля', 4],
  ['апр', 4],
  ['май', 5],
  ['мая', 5],
  ['июнь', 6],
  ['июня', 6],
  ['июль', 7],
  ['июля', 7],
  ['август', 8],
  ['августа', 8],
  ['сентябрь', 9],
  ['сентября', 9],
  ['сен', 9],
  ['октябрь', 10],
  ['октября', 10],
  ['окт', 10],
  ['ноябрь', 11],
  ['ноября', 11],
  ['ноя', 11],
  ['декабрь', 12],
  ['декабря', 12],
  ['дек', 12],
])

function pad(n) {
  return String(n).padStart(2, '0')
}

function iso(year, month, day) {
  return `${year}-${pad(month)}-${pad(day)}`
}

function clean(value) {
  return String(value ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
}

function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    const next = text[i + 1]
    if (quoted) {
      if (ch === '"' && next === '"') {
        cell += '"'
        i++
      } else if (ch === '"') {
        quoted = false
      } else {
        cell += ch
      }
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (ch !== '\r') {
      cell += ch
    }
  }
  row.push(cell)
  if (row.some((x) => x !== '') || rows.length === 0) rows.push(row)
  return rows
}

function yearFromToken(token) {
  if (!token) return null
  const n = Number(token)
  if (!Number.isFinite(n)) return null
  if (n < 100) return 2000 + n
  return n
}

function monthFromWord(word) {
  return (
    MONTHS.get(
      String(word || '')
        .toLowerCase()
        .replace(/\.$/, ''),
    ) ?? null
  )
}

function parseSheetDate(raw, state) {
  const original = clean(raw)
  if (!original) return { error: 'missing date' }
  const extraParts = original.split(/\s+\+\s+|;/)
  const primary = extraParts[0].trim()
  const extra = extraParts
    .slice(1)
    .map((x) => x.trim())
    .filter(Boolean)
  const text = primary
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[–—]/g, '-')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const notes = []
  if (extra.length) notes.push(`Additional sheet date text not modeled as a separate event: ${extra.join(' + ')}`)

  let m = text.match(/^(\d{1,2})\s*-\s*(\d{1,2})\s+([а-я.]+)(?:\s+(\d{2,4}))?$/i)
  if (m) {
    const startDay = Number(m[1])
    const endDay = Number(m[2])
    const month = monthFromWord(m[3])
    const year = yearFromToken(m[4]) ?? state.year
    if (!month) return { error: `unknown month in date: ${original}` }
    state.year = year
    state.lastMonth = month
    return { startDate: iso(year, month, startDay), endDate: iso(year, month, endDay), notes }
  }

  m = text.match(/^(\d{1,2})\s+([а-я.]+)(?:\s+(\d{2,4}))?$/i)
  if (m) {
    const day = Number(m[1])
    const month = monthFromWord(m[2])
    const year = yearFromToken(m[3]) ?? state.year
    if (!month) return { error: `unknown month in date: ${original}` }
    state.year = year
    state.lastMonth = month
    return { startDate: iso(year, month, day), endDate: null, notes }
  }

  m = text.match(/^([а-я.]+)\s+(\d{2,4})$/i)
  if (m) {
    const month = monthFromWord(m[1])
    const year = yearFromToken(m[2])
    if (!month || !year) return { error: `unknown month/year in date: ${original}` }
    state.year = year
    state.lastMonth = month
    notes.push('Sheet has only month/year; stored the first day of the month.')
    return { startDate: iso(year, month, 1), endDate: null, notes }
  }

  m = text.match(/^([а-я.]+)$/i)
  if (m) {
    const month = monthFromWord(m[1])
    if (!month) return { error: `unknown month in date: ${original}` }
    const year = state.year || DEFAULT_YEAR
    state.lastMonth = month
    notes.push('Sheet has only month; stored the first day of the month.')
    return { startDate: iso(year, month, 1), endDate: null, notes }
  }

  return { error: `unparsed date: ${original}` }
}

function parseDeadline(raw, eventYear, startDate) {
  const original = clean(raw)
  if (!original) return { isoDate: null, note: null }
  const text = original
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[–—]/g, '-')
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const m = text.match(/^(\d{1,2})\s+([а-я.]+)(?:\s+(\d{2,4}))?$/i)
  if (!m) return { isoDate: null, note: `Apply deadline from sheet is not an exact date: ${original}` }
  const day = Number(m[1])
  const month = monthFromWord(m[2])
  let year = yearFromToken(m[3]) ?? eventYear
  if (!month) return { isoDate: null, note: `Apply deadline has unknown month: ${original}` }
  let value = iso(year, month, day)
  if (startDate && value > startDate) {
    year -= 1
    value = iso(year, month, day)
  }
  return { isoDate: value, note: null }
}

function parseBool(raw) {
  const value = clean(raw).toLowerCase()
  if (!value) return null
  if (['true', 'yes', 'y', 'да', '1'].includes(value)) return true
  if (['false', 'no', 'n', 'нет', '0'].includes(value)) return false
  return null
}

function parseTri(raw) {
  const value = clean(raw).toLowerCase()
  if (['yes', 'maybe', 'no'].includes(value)) return value
  if (value === 'да') return 'yes'
  if (value === 'нет') return 'no'
  return null
}

function parseFee(raw) {
  const value = clean(raw)
  if (!value) return null
  const match = value.replace(',', '.').match(/-?\d+(?:\.\d+)?/)
  return match ? Math.round(Number(match[0])) : null
}

function normalizeUrl(raw) {
  let value = clean(raw)
  if (!value) return null
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`
  try {
    const url = new URL(value)
    if (url.hostname === 'www.google.com' && url.pathname === '/url' && url.searchParams.get('q')) {
      return normalizeUrl(url.searchParams.get('q'))
    }
    return url.toString()
  } catch {
    return null
  }
}

function extractApplication(raw) {
  const value = clean(raw)
  if (!value) return { url: null, applyUrl: null, note: null }
  const emails = [...value.matchAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)].map((x) => x[0])
  const withoutEmails = value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, ' ')
  const urlMatches = withoutEmails.match(/https?:\/\/[^\s"<>]+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s"<>]*)?/gi) ?? []
  const urls = [...new Set(urlMatches.map(normalizeUrl).filter(Boolean))]
  const isApply = (url) =>
    /docs\.google\.com\/forms|forms\.gle|jotform\.com|\/viewform|\/closedform|partner\.steamgames\.com\/optin/i.test(
      url,
    )
  const applyUrl = urls.find(isApply) ?? null
  const url = urls.find((u) => u !== applyUrl && !isApply(u)) ?? (applyUrl ? null : (urls[0] ?? null))
  const extras = []
  if (emails.length) extras.push(`Contacts from sheet: ${emails.join(', ')}`)
  const leftover = value
    .replace(/https?:\/\/[^\s"<>]+|(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s"<>]*)?/gi, ' ')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (leftover) extras.push(`Application/source raw text: ${leftover}`)
  return { url, applyUrl, note: extras.length ? extras.join('\n') : null }
}

function inferType(name) {
  return /\bsale\b|распродаж/i.test(name) ? 'sale' : 'festival'
}

function normalizeName(name) {
  return clean(name).replace(/\s+/g, ' ')
}

function importKey(item) {
  return `${normalizeName(item.name).toLowerCase()}|${item.startDate}`
}

function rowObjects(rows) {
  const headers = rows[0].map((h) => clean(h).toLowerCase())
  return rows.slice(1).map((row) => {
    const obj = {}
    headers.forEach((h, i) => {
      obj[h] = row[i] ?? ''
    })
    return obj
  })
}

function buildItems(objects) {
  const state = { year: DEFAULT_YEAR, lastMonth: 1 }
  const items = []
  const skipped = []
  const pickStatuses = new Map()
  for (const row of objects) {
    const name = normalizeName(row['название'])
    if (!name) continue
    const date = parseSheetDate(row['даты'], state)
    if (!date.startDate) {
      skipped.push({ name, rawDate: clean(row['даты']), reason: date.error })
      continue
    }
    const eventYear = Number(date.startDate.slice(0, 4))
    const deadline = parseDeadline(row['дедлайн подачи заявки'], eventYear, date.startDate)
    const application = extractApplication(row['заявка'])
    const submitted = parseBool(row['заявился?'])
    const approved = parseBool(row['одобрили?'])
    const notes = [
      `Imported from ${SHEET_URL}`,
      clean(row['даты']) ? `Raw sheet date: ${clean(row['даты'])}` : null,
      ...date.notes,
      deadline.note,
      application.note,
      submitted || approved
        ? `Sheet participation flags: submitted=${submitted === true}, approved=${approved === true}`
        : null,
    ].filter(Boolean)
    const item = {
      name,
      startDate: date.startDate,
      type: inferType(name),
      endDate: date.endDate,
      applyDeadline: deadline.isoDate,
      url: application.url,
      applyUrl: application.applyUrl,
      organizer: null,
      description: clean(row['описание']) || null,
      notes: notes.join('\n'),
      steamEvent: parseTri(row['steam event']),
      steamFeature: parseTri(row['steam feature']),
      media: parseBool(row['сми']),
      offline: parseBool(row['оффлайн']),
      costUsd: parseFee(row['$']),
    }
    items.push(item)
    if (approved === true) pickStatuses.set(importKey(item), 'approved')
    else if (submitted === true) pickStatuses.set(importKey(item), 'submitted')
  }
  return { items, skipped, pickStatuses }
}

function activeDbPath() {
  const appdata = process.env.APPDATA || process.env.HOME
  if (!appdata) throw new Error('APPDATA/HOME is unavailable; set MARCAT_DB explicitly.')
  if (process.env.MARCAT_DB) return process.env.MARCAT_DB
  const userData = path.join(appdata, 'MarCat')
  const marker = path.join(userData, 'active-db-path.txt')
  try {
    const markedPath = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8').trim() : ''
    const resolvedUserData = path.resolve(userData)
    const resolvedMarkedPath = path.resolve(markedPath)
    if (markedPath && resolvedMarkedPath.startsWith(resolvedUserData) && fs.existsSync(resolvedMarkedPath))
      return resolvedMarkedPath
  } catch {
    /* ignore invalid marker */
  }
  return path.join(userData, 'marcat.db')
}

async function main() {
  const res = await fetch(CSV_URL)
  if (!res.ok) throw new Error(`Failed to download sheet CSV: ${res.status} ${res.statusText}`)
  const csv = await res.text()
  const { items, skipped, pickStatuses } = buildItems(rowObjects(parseCsv(csv)))

  const dbPath = activeDbPath()
  const { db, client } = createDb(fileUrlFromPath(dbPath))
  try {
    await configureConnection(client)
    await runMigrations(db, client, path.join(__dirname, '..', 'packages', 'db', 'migrations'))
    await backfillTaskKeys(db)
    const caller = appRouter.createCaller({ db })
    const result = items.length ? await caller.festivals.importMany({ items }) : { imported: 0, created: 0, updated: 0 }

    const games = await caller.games.list()
    let picked = 0
    if (games.length === 1 && pickStatuses.size) {
      const events = await caller.festivals.list()
      const byKey = new Map(events.map((event) => [importKey(event), event.id]))
      for (const [key, status] of pickStatuses) {
        const industryEventId = byKey.get(key)
        if (!industryEventId) continue
        await caller.festivals.pick({ gameId: games[0].id, industryEventId })
        await caller.festivals.setStatus({ gameId: games[0].id, industryEventId, status })
        picked++
      }
    }

    const count = await client.execute('select count(*) as count from industry_events')
    console.log(
      JSON.stringify(
        {
          dbPath,
          source: SHEET_URL,
          parsed: items.length,
          skipped,
          import: result,
          picked,
          totalIndustryEvents: Number(count.rows[0]?.count ?? 0),
        },
        null,
        2,
      ),
    )
  } finally {
    client.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
