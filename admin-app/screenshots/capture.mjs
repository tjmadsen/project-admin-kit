#!/usr/bin/env node
/**
 * Renders the admin console against fixture data and captures screenshots, or
 * compares two capture directories pixel by pixel.
 *
 *   node screenshots/capture.mjs shoot <outDir> [--themes light,dark] [--scenes a,b] [--viewports desktop,mobile]
 *   node screenshots/capture.mjs compare <beforeDir> <afterDir> <diffDir>
 *
 * Needs a Playwright module (PLAYWRIGHT_MODULE=/path/to/node_modules/playwright,
 * otherwise any npx-cached copy is used) and Google Chrome, or CHROMIUM_PATH
 * pointing at a Chromium binary.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

const VIEWPORTS = {
  desktop: { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
}
// `attribute` is what the harness writes to <html data-theme>; `colorScheme`
// emulates the OS preference so the "system" path can be photographed too.
const THEMES = {
  light: { attribute: 'light', colorScheme: 'light' },
  dark: { attribute: 'dark', colorScheme: 'dark' },
  'system-light': { attribute: 'system', colorScheme: 'light' },
  'system-dark': { attribute: 'system', colorScheme: 'dark' },
}
const SCENES = [
  { name: 'dashboard', route: '/', query: {} },
  { name: 'features-list', route: '/features', query: {} },
  { name: 'features-detail', route: '/features', query: { item: 'FR-25' } },
  { name: 'tasks-list', route: '/tasks', query: {} },
  { name: 'loops', route: '/loops', query: {} },
  {
    name: 'nav-drawer', route: '/features', query: {}, viewports: ['mobile'],
    prepare: async (page) => { await page.getByRole('button', { name: 'Open navigation' }).click(); await page.waitForTimeout(400) },
  },
]

function parseArgs(argv) {
  const positional = []
  const options = {}
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value.startsWith('--')) { options[value.slice(2)] = argv[index + 1]; index += 1 } else positional.push(value)
  }
  return { positional, options }
}

function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE].filter(Boolean)
  try { candidates.push(require.resolve('playwright')) } catch { /* not installed locally */ }
  const npxCache = path.join(os.homedir(), '.npm', '_npx')
  if (fs.existsSync(npxCache)) {
    for (const entry of fs.readdirSync(npxCache)) {
      const candidate = path.join(npxCache, entry, 'node_modules', 'playwright')
      if (fs.existsSync(candidate)) candidates.push(candidate)
    }
  }
  for (const candidate of candidates) {
    try { return require(candidate) } catch { /* try the next one */ }
  }
  throw new Error('Playwright not found. Set PLAYWRIGHT_MODULE=/path/to/node_modules/playwright')
}

async function launch(chromium) {
  if (process.env.CHROMIUM_PATH) return chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH })
  try { return await chromium.launch({ headless: true, channel: 'chrome' }) }
  catch (error) {
    console.warn(`[capture] Google Chrome unavailable (${error.message.split('\n')[0]}); trying the bundled Chromium`)
    return chromium.launch({ headless: true })
  }
}

async function settle(page) {
  await page.waitForLoadState('networkidle')
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(350)
}

async function shoot(outDir, options) {
  const themes = (options.themes || 'light,dark').split(',').filter((theme) => THEMES[theme])
  const scenes = options.scenes ? SCENES.filter((scene) => options.scenes.split(',').includes(scene.name)) : SCENES
  const viewports = (options.viewports || 'desktop,mobile').split(',').filter((viewport) => VIEWPORTS[viewport])
  fs.mkdirSync(outDir, { recursive: true })

  const { createServer } = await import('vite')
  const server = await createServer({ configFile: path.join(here, 'vite.config.ts'), server: { port: 5199 } })
  await server.listen()
  const base = server.resolvedUrls.local[0].replace(/\/$/, '')
  const { chromium } = loadPlaywright()
  const browser = await launch(chromium)
  const written = []
  try {
    for (const scene of scenes) {
      for (const viewportName of viewports) {
        if (scene.viewports && !scene.viewports.includes(viewportName)) continue
        for (const themeName of themes) {
          const theme = THEMES[themeName]
          const context = await browser.newContext({ ...VIEWPORTS[viewportName], colorScheme: theme.colorScheme })
          const page = await context.newPage()
          const url = new URL(`${base}/harness.html`)
          url.searchParams.set('route', scene.route)
          for (const [key, value] of Object.entries(scene.query)) url.searchParams.set(key, value)
          url.searchParams.set('theme', theme.attribute)
          await page.goto(url.toString())
          await settle(page)
          if (scene.prepare) await scene.prepare(page)
          const file = path.join(outDir, `${scene.name}-${viewportName}-${themeName}.png`)
          await page.screenshot({ path: file })
          written.push(file)
          console.log(`[capture] ${path.relative(process.cwd(), file)}`)
          await context.close()
        }
      }
    }
  } finally {
    await browser.close()
    await server.close()
  }
  return written
}

const compareInPage = async ({ before, after, mainX }) => {
  const load = (encoded) => new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = reject
    image.src = `data:image/png;base64,${encoded}`
  })
  const [imageA, imageB] = await Promise.all([load(before), load(after)])
  const width = Math.max(imageA.width, imageB.width)
  const height = Math.max(imageA.height, imageB.height)
  const pixels = (image) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    return context.getImageData(0, 0, width, height).data
  }
  const dataA = pixels(imageA)
  const dataB = pixels(imageB)
  const output = document.createElement('canvas')
  output.width = width
  output.height = height
  const outputContext = output.getContext('2d')
  const diffImage = outputContext.createImageData(width, height)
  const stats = { width, height, total: width * height, changed: 0, maxDelta: 0, mainTotal: 0, mainChanged: 0, mainChangedOver8: 0, mainChangedOver24: 0, mainMaxDelta: 0 }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4
      const delta = Math.max(
        Math.abs(dataA[index] - dataB[index]),
        Math.abs(dataA[index + 1] - dataB[index + 1]),
        Math.abs(dataA[index + 2] - dataB[index + 2]),
        Math.abs(dataA[index + 3] - dataB[index + 3]),
      )
      const inMain = x >= mainX
      if (inMain) stats.mainTotal += 1
      if (delta > 0) {
        stats.changed += 1
        stats.maxDelta = Math.max(stats.maxDelta, delta)
        if (inMain) {
          stats.mainChanged += 1
          if (delta > 8) stats.mainChangedOver8 += 1
          if (delta > 24) stats.mainChangedOver24 += 1
          stats.mainMaxDelta = Math.max(stats.mainMaxDelta, delta)
        }
        diffImage.data[index] = 220
        diffImage.data[index + 1] = 40
        diffImage.data[index + 2] = 40
        diffImage.data[index + 3] = 255
      } else {
        // Unchanged pixels are drawn as a pale ghost of the "after" image.
        diffImage.data[index] = 255 - Math.round((255 - dataB[index]) * 0.22)
        diffImage.data[index + 1] = 255 - Math.round((255 - dataB[index + 1]) * 0.22)
        diffImage.data[index + 2] = 255 - Math.round((255 - dataB[index + 2]) * 0.22)
        diffImage.data[index + 3] = 255
      }
    }
  }
  outputContext.putImageData(diffImage, 0, 0)
  return { ...stats, png: output.toDataURL('image/png').split(',')[1] }
}

async function compare(beforeDir, afterDir, diffDir) {
  const files = fs.readdirSync(beforeDir).filter((file) => file.endsWith('.png') && fs.existsSync(path.join(afterDir, file))).sort()
  if (files.length === 0) throw new Error(`No matching PNG files between ${beforeDir} and ${afterDir}`)
  fs.mkdirSync(diffDir, { recursive: true })
  const { chromium } = loadPlaywright()
  const browser = await launch(chromium)
  const rows = []
  try {
    const page = await browser.newPage()
    await page.setContent('<!doctype html><title>diff</title>')
    for (const file of files) {
      const desktop = file.includes('-desktop-')
      // The 250px sidebar is excluded from the "main column" numbers so a
      // deliberate sidebar change (like a new control) does not mask the rest.
      const mainX = desktop ? 250 * VIEWPORTS.desktop.deviceScaleFactor : 0
      const result = await page.evaluate(compareInPage, {
        before: fs.readFileSync(path.join(beforeDir, file)).toString('base64'),
        after: fs.readFileSync(path.join(afterDir, file)).toString('base64'),
        mainX,
      })
      fs.writeFileSync(path.join(diffDir, file), Buffer.from(result.png, 'base64'))
      const { png, ...stats } = result
      rows.push({ file, ...stats })
    }
  } finally {
    await browser.close()
  }
  fs.writeFileSync(path.join(diffDir, 'summary.json'), `${JSON.stringify(rows, null, 2)}\n`)
  const percent = (part, whole) => (whole === 0 ? '0.00' : ((part / whole) * 100).toFixed(2))
  console.log('| Screenshot | Changed (any) | Max delta | Main column changed (any) | Main > 8 levels | Main > 24 levels | Main max delta |')
  console.log('|---|---|---|---|---|---|---|')
  for (const row of rows) {
    console.log(`| ${row.file} | ${percent(row.changed, row.total)}% | ${row.maxDelta} | ${percent(row.mainChanged, row.mainTotal)}% | ${percent(row.mainChangedOver8, row.mainTotal)}% | ${percent(row.mainChangedOver24, row.mainTotal)}% | ${row.mainMaxDelta} |`)
  }
  return rows
}

const { positional, options } = parseArgs(process.argv.slice(2))
const [command, ...rest] = positional
try {
  if (command === 'shoot' && rest[0]) await shoot(path.resolve(rest[0]), options)
  else if (command === 'compare' && rest.length === 3) await compare(path.resolve(rest[0]), path.resolve(rest[1]), path.resolve(rest[2]))
  else {
    console.error('Usage:\n  node screenshots/capture.mjs shoot <outDir> [--themes light,dark] [--scenes a,b] [--viewports desktop,mobile]\n  node screenshots/capture.mjs compare <beforeDir> <afterDir> <diffDir>')
    process.exit(2)
  }
} catch (error) {
  console.error(error)
  process.exit(1)
}
