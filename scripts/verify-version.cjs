const fs = require('node:fs')
const path = require('node:path')

const repo = path.resolve(__dirname, '..')
const manifests = [
  'package.json',
  'apps/desktop/package.json',
  'packages/core/package.json',
  'packages/db/package.json',
  'packages/mcp-server/package.json',
]
const versions = manifests.map((file) => ({
  file,
  version: JSON.parse(fs.readFileSync(path.join(repo, file), 'utf8')).version,
}))
const expected = versions[0].version
const mismatch = versions.find((entry) => entry.version !== expected)
if (mismatch) throw new Error(`Version mismatch: ${mismatch.file} is ${mismatch.version}; expected ${expected}`)

const lock = JSON.parse(fs.readFileSync(path.join(repo, 'package-lock.json'), 'utf8'))
const lockedVersions = [
  ['package-lock.json', lock.version],
  ['package-lock.json packages[""]', lock.packages?.['']?.version],
  ...manifests
    .slice(1)
    .map((file) => [
      `package-lock.json packages["${file.replace('/package.json', '')}"]`,
      lock.packages?.[file.replace('/package.json', '')]?.version,
    ]),
]
const lockedMismatch = lockedVersions.find(([, version]) => version !== expected)
if (lockedMismatch)
  throw new Error(`Version mismatch: ${lockedMismatch[0]} is ${lockedMismatch[1]}; expected ${expected}`)

const changelog = fs.readFileSync(path.join(repo, 'CHANGELOG.md'), 'utf8')
if (!changelog.includes(`## ${expected}`)) throw new Error(`CHANGELOG.md has no section for ${expected}`)

const builder = fs.readFileSync(path.join(repo, 'apps/desktop/electron-builder.yml'), 'utf8')
if (!builder.includes('${productName}-${version}-portable.${ext}')) {
  throw new Error('Portable artifact name must contain ${version}')
}
if (!builder.includes('${productName}-Setup-${version}.${ext}')) {
  throw new Error('Installer artifact name must contain ${version}')
}
if (!builder.includes('output: release/.build')) {
  throw new Error('Electron Builder output must remain isolated in release/.build')
}
if (!fs.existsSync(path.join(repo, 'RELEASE.md'))) throw new Error('Missing canonical RELEASE.md manifest')
console.log(`MarCat version ${expected} is synchronized across manifests and changelog.`)
