import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const POLICY_MARKER = 'static-precache;navigation-network-only;runtime-cache-none'
const REQUIRED_ARTIFACTS = [
  'index.html',
  'manifest.webmanifest',
  'offline.html',
  'service-worker.js',
  'pwa/icon-192.png',
  'pwa/icon-512.png',
]
const ALLOWED_PRECACHE_URL = /^(?:assets\/[A-Za-z0-9._/-]+|manifest\.webmanifest|offline\.html|pwa\/icon-(?:192|512)\.png)$/
const FORBIDDEN_PRIVATE_URL = /(?:^|[\/._-])(?:api|auth|stream|sse|google(?:apis)?|maps?|places?)(?:[\/._-]|$)/i
const FORBIDDEN_RUNTIME_STRATEGY = /(?:CacheFirst|NetworkFirst|StaleWhileRevalidate|runtimeCaching|backgroundSync)/

function readText(directory, relativePath, violations) {
  const path = join(directory, relativePath)
  if (!existsSync(path)) {
    violations.push({ artifact: relativePath, message: 'required artifact is missing' })
    return ''
  }
  return readFileSync(path, 'utf8')
}

function inspectManifest(directory, violations) {
  const source = readText(directory, 'manifest.webmanifest', violations)
  if (!source) return

  let manifest
  try {
    manifest = JSON.parse(source)
  } catch {
    violations.push({ artifact: 'manifest.webmanifest', message: 'manifest is not valid JSON' })
    return
  }

  const expected = {
    name: 'Dupert Trip Planner',
    short_name: 'Dupert',
    id: '/',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: '#f6f5f2',
    theme_color: '#3f5f53',
  }
  for (const [field, value] of Object.entries(expected)) {
    if (manifest[field] !== value) {
      violations.push({
        artifact: 'manifest.webmanifest',
        message: `${field} must equal ${JSON.stringify(value)}`,
      })
    }
  }

  for (const size of ['192x192', '512x512']) {
    const icon = manifest.icons?.find((candidate) => candidate.sizes === size)
    const purposes = new Set(icon?.purpose?.split(/\s+/) ?? [])
    if (!icon || icon.type !== 'image/png' || !purposes.has('any') || !purposes.has('maskable')) {
      violations.push({
        artifact: 'manifest.webmanifest',
        message: `${size} PNG icon must declare both any and maskable purposes`,
      })
    }
  }
}

function inspectPng(directory, relativePath, expectedSize, violations) {
  const path = join(directory, relativePath)
  if (!existsSync(path)) return
  const image = readFileSync(path)
  const isPng = image.length >= 24 && image.subarray(1, 4).toString('ascii') === 'PNG'
  const width = isPng ? image.readUInt32BE(16) : 0
  const height = isPng ? image.readUInt32BE(20) : 0
  if (!isPng || width !== expectedSize || height !== expectedSize) {
    violations.push({
      artifact: relativePath,
      message: `icon must be a ${expectedSize}x${expectedSize} PNG`,
    })
  }
}

function inspectIndex(directory, violations) {
  const html = readText(directory, 'index.html', violations)
  if (!html) return
  const requirements = [
    ['web manifest link', /<link[^>]+rel=["']manifest["'][^>]+href=["']\/manifest\.webmanifest["']/i],
    ['theme color', /<meta[^>]+name=["']theme-color["'][^>]+content=["']#3f5f53["']/i],
    ['safe-area viewport', /<meta[^>]+name=["']viewport["'][^>]+content=["'][^"']*viewport-fit=cover/i],
    ['Apple touch icon', /<link[^>]+rel=["']apple-touch-icon["'][^>]+href=["']\/pwa\/icon-192\.png["']/i],
    ['iOS standalone mode', /<meta[^>]+name=["']apple-mobile-web-app-capable["'][^>]+content=["']yes["']/i],
    ['iOS app title', /<meta[^>]+name=["']apple-mobile-web-app-title["'][^>]+content=["']Dupert["']/i],
  ]
  for (const [label, pattern] of requirements) {
    if (!pattern.test(html)) {
      violations.push({ artifact: 'index.html', message: `${label} metadata is missing` })
    }
  }
}

function inspectOfflineShell(directory, violations) {
  const html = readText(directory, 'offline.html', violations)
  if (!html) return
  if (!html.includes('data-dupert-offline-shell')) {
    violations.push({ artifact: 'offline.html', message: 'offline shell marker is missing' })
  }
  if (!/does not store private trip data/i.test(html)) {
    violations.push({ artifact: 'offline.html', message: 'private-data boundary is not explained' })
  }
  if (!/viewport-fit=cover/i.test(html)) {
    violations.push({ artifact: 'offline.html', message: 'safe-area viewport metadata is missing' })
  }
}

function inspectServiceWorker(directory, violations) {
  const source = readText(directory, 'service-worker.js', violations)
  if (!source) return
  if (!source.includes(POLICY_MARKER)) {
    violations.push({ artifact: 'service-worker.js', message: 'explicit no-runtime-cache policy marker is missing' })
  }
  if (FORBIDDEN_RUNTIME_STRATEGY.test(source)) {
    violations.push({ artifact: 'service-worker.js', message: 'runtime cache strategy code is present' })
  }

  const offlineIdentifier = source.match(
    /(?:(?:const|let|var)\s+|[,;])([A-Za-z_$][\w$]*)\s*=\s*[`"']\/offline\.html[`"']/,
  )?.[1]
  const policyOffset = source.indexOf(POLICY_MARKER)
  const navigationHandler = policyOffset >= 0
    ? source.slice(policyOffset, policyOffset + 600).replace(/\s+/g, '')
    : ''
  const fetchesNavigationFromNetwork = /try\{returnawaitfetch\([^)]*\.request\)\}catch\{/.test(navigationHandler)
  const fallsBackOnlyToOfflineShell = offlineIdentifier
    ? new RegExp(`catch\\{returnawait[A-Za-z_$][\\w$]*\\(${offlineIdentifier}\\)\\?\\?Response\\.error\\(\\)\\}`).test(navigationHandler)
    : false
  if (!fetchesNavigationFromNetwork || !fallsBackOnlyToOfflineShell) {
    violations.push({
      artifact: 'service-worker.js',
      message: 'failed navigations must use network first and fall back only to /offline.html',
    })
  }

  const precacheUrls = [...source.matchAll(/(?:["']url["']|\burl)\s*:\s*["']([^"']+)["']/g)]
    .map((match) => match[1].replace(/^\//, ''))
  if (precacheUrls.length === 0) {
    violations.push({ artifact: 'service-worker.js', message: 'precache manifest is missing' })
    return
  }
  for (const requiredUrl of ['offline.html', 'manifest.webmanifest', 'pwa/icon-192.png', 'pwa/icon-512.png']) {
    if (!precacheUrls.includes(requiredUrl)) {
      violations.push({ artifact: 'service-worker.js', message: `${requiredUrl} is not precached` })
    }
  }
  for (const url of precacheUrls) {
    if (!ALLOWED_PRECACHE_URL.test(url)) {
      violations.push({ artifact: 'service-worker.js', message: `precache URL is not an allowed static asset: ${url}` })
    }
    if (FORBIDDEN_PRIVATE_URL.test(url)) {
      violations.push({ artifact: 'service-worker.js', message: `private or external URL must not be precached: ${url}` })
    }
  }
}

export function inspectPwaBundle(directory) {
  const outputDirectory = resolve(directory)
  const violations = []
  for (const artifact of REQUIRED_ARTIFACTS) {
    if (!existsSync(join(outputDirectory, artifact))) {
      violations.push({ artifact, message: 'required artifact is missing' })
    }
  }
  inspectManifest(outputDirectory, violations)
  inspectPng(outputDirectory, 'pwa/icon-192.png', 192, violations)
  inspectPng(outputDirectory, 'pwa/icon-512.png', 512, violations)
  inspectIndex(outputDirectory, violations)
  inspectOfflineShell(outputDirectory, violations)
  inspectServiceWorker(outputDirectory, violations)
  return violations.filter((violation, index, all) =>
    all.findIndex((candidate) => candidate.artifact === violation.artifact && candidate.message === violation.message) === index,
  )
}

export function assertPwaBundlePolicy(directory) {
  const violations = inspectPwaBundle(directory)
  if (violations.length === 0) return
  const details = violations.map(({ artifact, message }) => `${artifact}: ${message}`).join('\n')
  throw new Error(`Web PWA bundle violates installability or cache policy:\n${details}`)
}

const invokedPath = process.argv[1] && resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  const outputDirectory = resolve(process.cwd(), process.argv[2] ?? 'dist')
  assertPwaBundlePolicy(outputDirectory)
  console.log(`PASS PWA bundle policy: ${basename(outputDirectory)}`)
}
