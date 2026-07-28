const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const asar = require('@electron/asar')

const repo = path.resolve(__dirname, '..')
const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version
const releaseDir = path.join(repo, 'apps', 'desktop', 'release')
const buildDir = path.join(releaseDir, '.build')
const candidateDir = path.join(releaseDir, `.candidate-MarCat-${version}`)
const artifacts = [`MarCat-${version}-portable.exe`, `MarCat-Setup-${version}.exe`]
const expectedBundleNames = ['CHANGELOG.md', ...artifacts, 'README-RU.md', 'SHA256SUMS.txt'].sort()
const bundleNames = fs.readdirSync(candidateDir).sort()
if (bundleNames.join('|') !== expectedBundleNames.join('|')) {
  throw new Error(`Release candidate contains unexpected files: ${bundleNames.join(', ')}`)
}

const resources = path.join(buildDir, 'win-unpacked', 'resources')
if (!fs.existsSync(resources)) throw new Error(`Missing packaged resources: ${resources}`)
const forbidden =
  /(^|[\\/])(?:active-db-path\.txt|secret-.+\.bin|\.env(?:\..+)?|[^\\/]*\.(?:db|db-wal|db-shm|sqlite|sqlite3))$/i
const pending = [resources]
const leaks = []
while (pending.length) {
  const current = pending.pop()
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const target = path.join(current, entry.name)
    if (entry.isDirectory()) pending.push(target)
    else if (forbidden.test(target)) leaks.push(path.relative(resources, target))
  }
}
if (leaks.length) throw new Error(`Private runtime files found in release:\n${leaks.join('\n')}`)

for (const resourceName of ['steam-festivals.json', 'README-RU.md', 'CHANGELOG.md']) {
  if (!fs.existsSync(path.join(resources, resourceName))) throw new Error(`Missing packaged resource: ${resourceName}`)
}
for (const resourceName of [
  path.join('mcp', 'index.cjs'),
  path.join('mcp', 'package.json'),
  path.join('mcp', 'node_modules', 'libsql', 'index.js'),
  path.join('mcp', 'node_modules', '@libsql', 'win32-x64-msvc', 'index.node'),
]) {
  if (!fs.existsSync(path.join(resources, resourceName)))
    throw new Error(`Missing packaged MCP resource: ${resourceName}`)
}

const privateContent = [
  /[A-Z]:\\Users\\[^\\"'\s]+/i,
  /[A-Z]:\\Repo\\/i,
  /Salt and Soil/i,
  /amy\.graves/i,
  /@mythwright/i,
]
for (const resourceName of ['steam-festivals.json', 'README-RU.md', 'CHANGELOG.md', path.join('mcp', 'index.cjs')]) {
  const content = fs.readFileSync(path.join(resources, resourceName), 'utf8')
  const match = privateContent.find((pattern) => pattern.test(content))
  if (match) throw new Error(`Private content ${match} found in packaged resource: ${resourceName}`)
}

const asarPath = path.join(resources, 'app.asar')
for (const archivedPath of asar.listPackage(asarPath)) {
  if (!/^\\out\\(?:main|preload|renderer)\\/i.test(archivedPath) || !/\.(?:js|json|html|md)$/i.test(archivedPath))
    continue
  const content = asar.extractFile(asarPath, archivedPath.replace(/^\\/, '')).toString('utf8')
  const match = privateContent.find((pattern) => pattern.test(content))
  if (match) throw new Error(`Private content ${match} found in app.asar: ${archivedPath}`)
}

const recordedChecksums = fs.readFileSync(path.join(candidateDir, 'SHA256SUMS.txt'), 'utf8').trim().split(/\r?\n/)
const expectedChecksums = artifacts.map((name) => {
  const checksum = crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(candidateDir, name)))
    .digest('hex')
  return `${checksum}  ${name}`
})
if (recordedChecksums.join('|') !== expectedChecksums.join('|')) {
  throw new Error('Release executable SHA-256 checksums are invalid')
}

console.log(
  `MarCat ${version} release candidate verified: installer, portable app, checksums, release docs, sanitized resources, no runtime data files.`,
)
