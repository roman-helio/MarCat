const fs = require('node:fs')
const path = require('node:path')

const repo = path.resolve(__dirname, '..')
const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version
const releaseDir = path.join(repo, 'apps', 'desktop', 'release')
const candidateName = `.candidate-MarCat-${version}`
const candidateDir = path.join(releaseDir, candidateName)
const finalName = `MarCat-${version}`
const finalDir = path.join(releaseDir, finalName)

if (!fs.existsSync(candidateDir)) throw new Error(`Missing verified release candidate: ${candidateDir}`)

for (const entry of fs.readdirSync(releaseDir, { withFileTypes: true })) {
  if (entry.name === candidateName) continue
  fs.rmSync(path.join(releaseDir, entry.name), { recursive: true, force: true })
}
fs.renameSync(candidateDir, finalDir)

const remaining = fs.readdirSync(releaseDir)
if (remaining.length !== 1 || remaining[0] !== finalName) {
  throw new Error(`Release output is not clean: ${remaining.join(', ')}`)
}

console.log(`Finalized single release bundle: ${finalDir}`)
