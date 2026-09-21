// Re-renders every designed image in assets/readme/ from the HTML sources here.
//   node assets/readme/src/render.mjs [shotsDir]
// shotsDir holds the raw app captures (overview-light.png, ...). Defaults to ./raw.
import { chromium } from '../../../node_modules/playwright/index.mjs'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SRC = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(SRC, '..')
const RAW = resolve(process.argv[2] ?? join(SRC, 'raw'))
mkdirSync(OUT, { recursive: true })

// terminal.html embeds a live capture of the CLI's own output.
const tuiHtml = execFileSync(process.execPath, [join(SRC, 'ansi2html.mjs')], {
  input: readFileSync(join(SRC, 'tui.ansi')), encoding: 'utf-8',
})
writeFileSync(join(SRC, '.terminal.built.html'),
  readFileSync(join(SRC, 'terminal.html'), 'utf-8').replace('<!--TUI-->', tuiHtml))

// The repo pins no browser download, so fall back to whatever Chromium is on the machine.
const exe = process.env.CODEBURN_RENDER_CHROMIUM
const browser = await chromium.launch(exe ? { executablePath: exe } : { channel: 'chrome' })
const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 1100, height: 900 } })

async function render(file, out, theme, query = '', opts = {}) {
  const url = pathToFileURL(join(SRC, file)).href + (query ? '?' + query : '')
  await page.goto(url)
  await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), theme)
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(400)
  // Shoot the body box, not the viewport, so nothing is padded out to the window height.
  await page.locator('body').screenshot({ path: join(OUT, out), ...opts })
  console.log(out)
}

for (const theme of ['light', 'dark']) {
  await render('hero.html', `hero-${theme}.png`, theme)
  await render('tools.html', `tools-${theme}.png`, theme)
  await render('.terminal.built.html', `terminal-${theme}.png`, theme)
  for (const name of ['overview', 'sessions', 'spend', 'compare-periods', 'optimize']) {
    const img = join(RAW, `${name}-${theme}.png`)
    if (!existsSync(img)) { console.log('skip', name, theme); continue }
    await render('frame.html', `${name}-${theme}.png`, theme, 'img=' + encodeURIComponent(pathToFileURL(img).href))
  }
  // A photo-like source: JPEG keeps it a tenth of the PNG.
  await render('frame.html', `ambient-${theme}.jpg`, theme,
    'img=' + encodeURIComponent(pathToFileURL(resolve(OUT, '../capacity-dock.jpg')).href),
    { type: 'jpeg', quality: 88 })
}

await browser.close()
