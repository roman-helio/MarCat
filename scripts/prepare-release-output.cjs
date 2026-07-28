const fs = require('node:fs')
const path = require('node:path')

const repo = path.resolve(__dirname, '..')
const releaseDir = path.join(repo, 'apps', 'desktop', 'release')
const buildDir = path.join(releaseDir, '.build')

fs.mkdirSync(releaseDir, { recursive: true })
fs.rmSync(buildDir, { recursive: true, force: true })
for (const entry of fs.readdirSync(releaseDir, { withFileTypes: true })) {
  if (entry.name.startsWith('.candidate-MarCat-')) {
    fs.rmSync(path.join(releaseDir, entry.name), { recursive: true, force: true })
  }
}

console.log(`Prepared intermediate release output: ${buildDir}`)
