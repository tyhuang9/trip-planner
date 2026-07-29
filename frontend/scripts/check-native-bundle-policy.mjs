import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const TEXT_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.mjs'])
const FORBIDDEN_PATTERNS = [
  ['service-worker registration', /navigator\s*\.\s*serviceWorker|serviceWorker\s*\.\s*register|registerSW|workbox/i],
  ['browser Google Maps loader', /maps\.googleapis\.com\/maps\/api\/js/i],
  ['browser Google Maps renderer', /@vis\.gl\/react-google-maps/i],
  ['browser Maps environment variable name', /VITE_GOOGLE_MAPS_API_KEY/],
  ['app-access environment variable name', /VITE_APP_ACCESS_PASSWORD/],
  ['AppAccessGate UI', /private trip planner|that password does not match/i],
  ['Vercel Speed Insights package reference', /@vercel\/speed-insights/i],
]

function collectFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return collectFiles(path)
    return entry.isFile() ? [path] : []
  })
}

function inspectTextFile(path, configuredBrowserValues) {
  if (!TEXT_EXTENSIONS.has(extname(path))) return []

  const contents = readFileSync(path, 'utf8')
  const findings = FORBIDDEN_PATTERNS
    .filter(([, pattern]) => pattern.test(contents))
    .map(([label]) => label)

  for (const [name, value] of configuredBrowserValues) {
    if (value && contents.includes(value)) {
      findings.push(`${name} value`)
    }
  }

  return findings
}

function inspectBundleContents(outputDirectory, environment) {
  const configuredBrowserValues = [
    ['VITE_GOOGLE_MAPS_API_KEY', environment.VITE_GOOGLE_MAPS_API_KEY?.trim()],
    ['VITE_APP_ACCESS_PASSWORD', environment.VITE_APP_ACCESS_PASSWORD?.trim()],
  ]
  const violations = []

  for (const path of collectFiles(outputDirectory)) {
    if (statSync(path).size === 0) continue
    const findings = inspectTextFile(path, configuredBrowserValues)
    if (findings.length > 0) {
      violations.push({ file: path.slice(outputDirectory.length + 1), findings })
    }
  }

  return violations
}

function assertNoViolations(violations) {
  if (violations.length === 0) return

  const affectedFiles = violations
    .map(({ file, findings }) => `${file}: ${findings.join(', ')}`)
    .join('\n')
  throw new Error(`Native bundle includes browser-only code or public configuration:\n${affectedFiles}`)
}

export function inspectNativeBundle(directory, environment = process.env) {
  const outputDirectory = resolve(directory)
  const manifestPath = join(outputDirectory, '.vite', 'manifest.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`Could not find a Vite manifest at ${manifestPath}. Build a native profile first.`)
  }

  return inspectBundleContents(outputDirectory, environment)
}

export function assertNativeBundlePolicy(directory, environment = process.env) {
  assertNoViolations(inspectNativeBundle(directory, environment))
}

export function assertPackagedNativeBundlePolicy(directory, environment = process.env) {
  const outputDirectory = resolve(directory)
  const entrypointPath = join(outputDirectory, 'index.html')
  if (!existsSync(entrypointPath) || !statSync(entrypointPath).isFile()) {
    throw new Error(`Could not find the packaged native entrypoint at ${entrypointPath}.`)
  }

  assertNoViolations(inspectBundleContents(outputDirectory, environment))
}

const invokedPath = process.argv[1] && resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  const outputDirectory = resolve(process.cwd(), process.argv[2] ?? 'dist')
  assertNativeBundlePolicy(outputDirectory)
  console.log(`PASS native bundle policy: ${basename(outputDirectory)}`)
}
