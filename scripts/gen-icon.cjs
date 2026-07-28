/* Build the app icon (icon.ico + icon.png) from the source marcat_icon.png. */
const fs = require('node:fs')
const path = require('node:path')
const { PNG } = require('pngjs')
const pngToIco = require('png-to-ico')

const root = path.resolve(__dirname, '..')
const srcPath = path.join(root, 'marcat_icon.png')
const outDir = path.join(root, 'apps', 'desktop', 'build')

/** Box-average downscale to a square `size` (good for pixel art). */
function resize(src, size) {
  const out = new PNG({ width: size, height: size })
  const sw = src.width
  const sh = src.height
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor((x * sw) / size)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / size))
      const y0 = Math.floor((y * sh) / size)
      const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / size))
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let n = 0
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (sw * yy + xx) << 2
          r += src.data[i]
          g += src.data[i + 1]
          b += src.data[i + 2]
          a += src.data[i + 3]
          n++
        }
      }
      const o = (size * y + x) << 2
      out.data[o] = Math.round(r / n)
      out.data[o + 1] = Math.round(g / n)
      out.data[o + 2] = Math.round(b / n)
      out.data[o + 3] = Math.round(a / n)
    }
  }
  return out
}

async function main() {
  const src = PNG.sync.read(fs.readFileSync(srcPath))
  console.log(`source ${src.width}x${src.height}`)
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(path.join(outDir, 'icon.png'), PNG.sync.write(resize(src, 256)))
  const ico = await pngToIco([256, 64, 48, 32, 16].map((s) => PNG.sync.write(resize(src, s))))
  fs.writeFileSync(path.join(outDir, 'icon.ico'), ico)
  console.log('icon written to', outDir)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
