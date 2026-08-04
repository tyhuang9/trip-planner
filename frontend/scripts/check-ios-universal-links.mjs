import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ID = 'io.github.tyhuang9.dupert'
const APPLE_TEAM_ID = 'UK537LHYVG'
const HOST = 'dupert.vercel.app'
const ENTITLEMENT = `applinks:${HOST}`
const ASSOCIATION_PATH = '/.well-known/apple-app-site-association'
const ASSOCIATION_PATHS = ['/share/*', '/verify-email', '/reset-password', '/trips/*']

function unique(values) { return [...new Set(values)] }
function parseJson(value, label, violations) { try { return JSON.parse(value) } catch { violations.push(`${label} must be valid JSON`); return undefined } }

export function loadIosUniversalLinkSources(repositoryRoot) {
  const read = (path) => readFileSync(resolve(repositoryRoot, path), 'utf8')
  return {
    project: read('frontend/ios/App/App.xcodeproj/project.pbxproj'),
    entitlements: read('frontend/ios/App/App/App.entitlements'),
    association: read('frontend/public/.well-known/apple-app-site-association'),
    vercel: read('frontend/vercel.json'),
    policy: read('frontend/src/deep-links/policy.ts'),
  }
}

export function inspectIosUniversalLinks(sources) {
  const violations = []
  const entitlementSettings = [...sources.project.matchAll(/CODE_SIGN_ENTITLEMENTS\s*=\s*([^;]+);/g)].map((match) => match[1].trim())
  if (entitlementSettings.length !== 2 || entitlementSettings.some((value) => value !== 'App/App.entitlements')) violations.push('Debug and Release must use only App/App.entitlements')
  const entitlementValues = [...sources.entitlements.matchAll(/<string>([^<]+)<\/string>/g)].map((match) => match[1])
  if (JSON.stringify(unique(entitlementValues)) !== JSON.stringify([ENTITLEMENT]) || entitlementValues.length !== 1) violations.push(`associated domains must contain only ${ENTITLEMENT}`)

  const association = parseJson(sources.association, 'apple-app-site-association', violations)
  if (JSON.stringify(Object.keys(association ?? {}).sort()) !== JSON.stringify(['applinks'])) violations.push('apple-app-site-association must contain only applinks')
  if (JSON.stringify(association?.applinks?.apps) !== JSON.stringify([])) violations.push('apple-app-site-association legacy apps must be empty')
  const detail = association?.applinks?.details
  if (!Array.isArray(detail) || detail.length !== 1) violations.push('apple-app-site-association must contain exactly one applinks detail')
  else {
    const [entry] = detail
    if (JSON.stringify(Object.keys(entry ?? {}).sort()) !== JSON.stringify(['appIDs', 'components'])) violations.push('apple-app-site-association detail keys are invalid')
    if (JSON.stringify(entry?.appIDs) !== JSON.stringify([`${APPLE_TEAM_ID}.${APP_ID}`])) violations.push('apple-app-site-association appID is invalid')
    const components = entry?.components
    if (!Array.isArray(components) || components.some((component) => JSON.stringify(Object.keys(component ?? {}).sort()) !== JSON.stringify(['/'])) || JSON.stringify(components.map((component) => component?.['/'])) !== JSON.stringify(ASSOCIATION_PATHS)) violations.push('apple-app-site-association routes are invalid')
  }

  const vercel = parseJson(sources.vercel, 'Vercel configuration', violations)
  const associationHeaders = vercel?.headers?.filter((entry) => entry?.source === ASSOCIATION_PATH)
  if (!Array.isArray(associationHeaders) || associationHeaders.length !== 1) violations.push('Vercel must define exactly one Apple association header rule')
  else {
    const headers = associationHeaders[0].headers
    const contentType = headers?.find((header) => header?.key === 'Content-Type')?.value
    if (contentType !== 'application/json') violations.push('Apple association response must use application/json')
  }
  if (!sources.policy.includes(`const ORIGIN = 'https://${HOST}'`)) violations.push('deep-link policy must use the owned Universal Links host')
  return violations
}

export function assertIosUniversalLinks(repositoryRoot) {
  const violations = inspectIosUniversalLinks(loadIosUniversalLinkSources(repositoryRoot))
  if (violations.length) throw new Error(`iOS Universal Links source check failed:\n${violations.map((item) => `- ${item}`).join('\n')}`)
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  assertIosUniversalLinks(resolve(dirname(fileURLToPath(import.meta.url)), '../..'))
  console.log('PASS iOS Universal Links source contract (deployment and device association remain blocked)')
}
