/* Inspect the latest AI run: prompt, summary, changes, raw output (debug Phase 4). */
const path = require('node:path')
const { createDb, fileUrlFromPath } = require('@marcat/db')

async function main() {
  const dbPath = path.join(process.env.APPDATA, 'MarCat', 'marcat.db')
  const { client } = createDb(fileUrlFromPath(dbPath))
  const r = await client.execute(
    'SELECT id, prompt, status, summary, model, error, raw_output FROM ai_runs ORDER BY created_at DESC LIMIT 1',
  )
  const run = r.rows[0]
  if (!run) return console.log('no runs')
  console.log('PROMPT:', run.prompt)
  console.log('STATUS:', run.status, '| MODEL:', run.model, '| ERROR:', run.error)
  console.log('SUMMARY:', run.summary)
  const ch = await client.execute(
    'SELECT op, entity, after_json FROM ai_proposal_changes WHERE run_id = ? ORDER BY created_at',
    [run.id],
  )
  console.log('CHANGES (', ch.rows.length, '):')
  for (const c of ch.rows) console.log(' -', c.op, c.entity, c.after_json)
  console.log('\nRAW (first 1500):\n', String(run.raw_output).slice(0, 1500))
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
