const fs = require('node:fs')
const path = require('node:path')

const repo = path.resolve(__dirname, '..')
const source = path.join(repo, 'CHANGELOG.md')
const destination = path.join(repo, 'release-data', 'CHANGELOG.md')
const replacements = [
  [/Salt and Soil/g, 'существующего проекта'],
  [/\bSAS-\d+\b/g, 'задачи проекта'],
]

let publicChangelog = fs.readFileSync(source, 'utf8')
for (const [privateText, replacement] of replacements)
  publicChangelog = publicChangelog.replace(privateText, replacement)
fs.writeFileSync(destination, publicChangelog)
console.log(`Prepared public changelog: ${destination}`)
