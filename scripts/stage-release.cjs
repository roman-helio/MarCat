const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const repo = path.resolve(__dirname, '..')
const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version
const releaseDir = path.join(repo, 'apps', 'desktop', 'release')
const buildDir = path.join(releaseDir, '.build')
const candidateDir = path.join(releaseDir, `.candidate-MarCat-${version}`)
const artifacts = [`MarCat-${version}-portable.exe`, `MarCat-Setup-${version}.exe`]
const files = [
  ...artifacts.map((name) => [path.join(buildDir, name), name]),
  [path.join(repo, 'README-PORTABLE-RU.md'), 'README-RU.md'],
  [path.join(repo, 'release-data', 'CHANGELOG.md'), 'CHANGELOG.md'],
]

fs.rmSync(candidateDir, { recursive: true, force: true })
fs.mkdirSync(candidateDir, { recursive: true })
for (const [source, name] of files) {
  if (!fs.existsSync(source)) throw new Error(`Missing release input: ${source}`)
  fs.copyFileSync(source, path.join(candidateDir, name))
}

const checksums = artifacts.map((name) => {
  const checksum = crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(candidateDir, name)))
    .digest('hex')
  return `${checksum}  ${name}`
})
fs.writeFileSync(path.join(candidateDir, 'SHA256SUMS.txt'), `${checksums.join('\n')}\n`)

console.log(`Staged release candidate: ${candidateDir}`)
