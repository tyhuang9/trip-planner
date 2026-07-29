import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const MANIFEST_PATH = 'frontend/ios/App/App/PrivacyInfo.xcprivacy'
const INVENTORY_PATH = 'docs/mobile/ios-privacy-manifest-inventory.md'
const PROJECT_PATH = 'frontend/ios/App/App.xcodeproj/project.pbxproj'
const FILE_REF = '7B31F0F7A1B2C3D4E5F60708'
const BUILD_FILE = '7B31F0F8A1B2C3D4E5F60708'
const DATA_TYPES = [
  'NSPrivacyCollectedDataTypeName',
  'NSPrivacyCollectedDataTypeEmailAddress',
  'NSPrivacyCollectedDataTypeUserID',
  'NSPrivacyCollectedDataTypeOtherUserContent',
]

const collectedDataTypes = DATA_TYPES.map((type) => ({
  NSPrivacyCollectedDataType: type,
  NSPrivacyCollectedDataTypeLinked: true,
  NSPrivacyCollectedDataTypeTracking: false,
  NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
}))

const CANONICAL_MANIFEST = {
  NSPrivacyTracking: false,
  NSPrivacyCollectedDataTypes: collectedDataTypes,
}

function parsePlist(source) {
  const tokens = []
  for (const rawToken of source.match(/<[^>]+>|[^<]+/g) ?? []) {
    if (!rawToken.startsWith('<')) {
      if (rawToken.trim()) tokens.push({ kind: 'text', value: rawToken })
      continue
    }
    if (/^<\?xml\s+version="1\.0"\s+encoding="UTF-8"\?>$/.test(rawToken)
      || /^<!DOCTYPE plist PUBLIC "-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN" "http:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd">$/.test(rawToken)) continue
    const closing = rawToken.match(/^<\/([A-Za-z]+)>$/)
    if (closing) {
      tokens.push({ kind: 'close', name: closing[1] })
      continue
    }
    const selfClosing = rawToken.match(/^<([A-Za-z]+)\/>$/)
    if (selfClosing) {
      tokens.push({ kind: 'self', name: selfClosing[1] })
      continue
    }
    const opening = rawToken.match(/^<([A-Za-z]+)(?: version="1\.0")?>$/)
    if (!opening) throw new Error('contains an unsupported XML token')
    if (opening[1] === 'plist' && rawToken !== '<plist version="1.0">') {
      throw new Error('must use plist version 1.0')
    }
    if (opening[1] !== 'plist' && rawToken !== `<${opening[1]}>`) {
      throw new Error(`contains unsupported attributes on ${opening[1]}`)
    }
    tokens.push({ kind: 'open', name: opening[1] })
  }

  let cursor = 0
  function next() {
    return tokens[cursor++]
  }
  function expectClose(name) {
    const token = next()
    if (token?.kind !== 'close' || token.name !== name) throw new Error(`expected </${name}>`)
  }
  function textValue(token) {
    const text = next()
    if (text?.kind !== 'text') throw new Error(`expected text in ${token.name}`)
    expectClose(token.name)
    return text.value
  }
  function value() {
    const token = next()
    if (token?.kind === 'self' && (token.name === 'true' || token.name === 'false')) {
      return token.name === 'true'
    }
    if (token?.kind !== 'open') throw new Error('expected a plist value')
    if (token.name === 'string') return textValue(token)
    if (token.name === 'array') {
      const values = []
      while (tokens[cursor]?.kind !== 'close') values.push(value())
      expectClose('array')
      return values
    }
    if (token.name === 'dict') {
      const dictionary = {}
      while (tokens[cursor]?.kind !== 'close') {
        const keyToken = next()
        if (keyToken?.kind !== 'open' || keyToken.name !== 'key') {
          throw new Error('dictionary keys must use key elements')
        }
        const key = textValue(keyToken)
        if (Object.hasOwn(dictionary, key)) throw new Error(`dictionary repeats ${key}`)
        dictionary[key] = value()
      }
      expectClose('dict')
      return dictionary
    }
    throw new Error(`unsupported plist value ${token.name}`)
  }

  const root = next()
  if (root?.kind !== 'open' || root.name !== 'plist') throw new Error('expected plist root')
  const result = value()
  expectClose('plist')
  if (cursor !== tokens.length) throw new Error('contains content after plist root')
  return result
}

function count(source, pattern) {
  return [...source.matchAll(pattern)].length
}

function inspectXcodeProject(project, violations) {
  const fileReference = new RegExp(`${FILE_REF} /\\* PrivacyInfo\\.xcprivacy \\*/ = \\{isa = PBXFileReference; lastKnownFileType = text\\.plist\\.xml; path = PrivacyInfo\\.xcprivacy; sourceTree = "<group>"; \\};`, 'g')
  const buildFile = new RegExp(`${BUILD_FILE} /\\* PrivacyInfo\\.xcprivacy in Resources \\*/ = \\{isa = PBXBuildFile; fileRef = ${FILE_REF} /\\* PrivacyInfo\\.xcprivacy \\*/; \\};`, 'g')
  if (count(project, /\/\* PrivacyInfo\.xcprivacy \*\/ =/g) !== 1) {
    violations.push('Xcode project must contain one privacy manifest file reference and one build file')
  }
  if (count(project, fileReference) !== 1) violations.push('Xcode privacy manifest file reference is missing, duplicated, or wrong')
  if (count(project, buildFile) !== 1) violations.push('Xcode privacy manifest build file is missing, duplicated, or wrong')

  const resources = project.match(/504EC3021FED79650016851F \/\* Resources \*\/ = \{[\s\S]*?files = \(([\s\S]*?)\);/)
  if (!resources || count(resources[1], new RegExp(`${BUILD_FILE} /\\* PrivacyInfo\\.xcprivacy in Resources \\*/`, 'g')) !== 1) {
    violations.push('Xcode privacy manifest must be a single member of the App Resources phase')
  }
  const appTarget = project.match(/504EC3031FED79650016851F \/\* App \*\/ = \{[\s\S]*?buildPhases = \(([\s\S]*?)\);/)
  if (!appTarget || count(appTarget[1], /504EC3021FED79650016851F \/\* Resources \*\//g) !== 1) {
    violations.push('Xcode App target must contain the Resources phase exactly once')
  }
}

function inspectDocumentation(inventory, releaseDocument, violations) {
  const requiredInventoryClaims = [
    '`frontend/ios/App/App/PrivacyInfo.xcprivacy`',
    '`frontend/ios/App/App/AppDelegate.swift`',
    '`frontend/src/api/auth.ts`',
    '`frontend/src/api/trips.ts`',
    '`frontend/src/api/activities.ts`',
    'vendor SDK manifests remain separate',
    '`NSPrivacyTracking` is `false`',
    '`NSPrivacyTrackingDomains` and\n`NSPrivacyAccessedAPITypes` are absent',
    'Xcode archive\nproduces its privacy report',
    'App\nStore Connect',
  ]
  for (const claim of requiredInventoryClaims) {
    if (!inventory.includes(claim)) violations.push(`privacy inventory is missing required claim: ${claim.replaceAll('\n', ' ')}`)
  }
  for (const dataType of DATA_TYPES) {
    if (!inventory.includes(`\`${dataType}\``)) violations.push(`privacy inventory is missing ${dataType}`)
  }
  if (/\bPASS\b/i.test(inventory) || /App Store (?:approved|ready)/i.test(inventory)) {
    violations.push('privacy inventory must not claim PASS or App Store readiness')
  }
  const privacyGate = releaseDocument.match(/^\| Privacy and store metadata \| ([A-Z]+) \| .*$/m)
  if (privacyGate?.[1] !== 'BLOCKED') violations.push('Privacy and store metadata must remain BLOCKED')
  if (!releaseDocument.includes('Xcode archive privacy report + App Store Connect reconciliation')) {
    violations.push('release readiness must require the archive privacy report and App Store Connect reconciliation')
  }
  if (/^\| Privacy and store metadata \| PASS \|/m.test(releaseDocument)
    || /Privacy and store metadata[^\n]*(?:ready|approved)/i.test(releaseDocument)) {
    violations.push('release readiness must not claim privacy or store readiness')
  }
}

export function loadIosPrivacyManifestSources(repositoryRoot) {
  const root = resolve(repositoryRoot)
  const appDirectory = resolve(root, 'frontend/ios/App/App')
  const manifestPaths = existsSync(appDirectory)
    ? readdirSync(appDirectory).filter((entry) => entry.endsWith('.xcprivacy')).map((entry) => `frontend/ios/App/App/${entry}`)
    : []
  return {
    manifestPaths,
    manifest: manifestPaths.length === 1 ? readFileSync(resolve(root, manifestPaths[0]), 'utf8') : null,
    project: readFileSync(resolve(root, PROJECT_PATH), 'utf8'),
    inventory: readFileSync(resolve(root, INVENTORY_PATH), 'utf8'),
    releaseDocument: readFileSync(resolve(root, 'docs/mobile/release-readiness.md'), 'utf8'),
  }
}

export function inspectIosPrivacyManifest(sources) {
  const violations = []
  if (sources.manifestPaths.length !== 1 || sources.manifestPaths[0] !== MANIFEST_PATH || !sources.manifest) {
    violations.push('exactly one app-owned PrivacyInfo.xcprivacy manifest is required')
  } else {
    try {
      const parsed = parsePlist(sources.manifest)
      if (!isDeepStrictEqual(parsed, CANONICAL_MANIFEST)) {
        violations.push('privacy manifest must match the canonical app-owned collection declaration')
      }
    } catch (error) {
      violations.push(`privacy manifest is malformed: ${error.message}`)
    }
  }
  inspectXcodeProject(sources.project, violations)
  inspectDocumentation(sources.inventory, sources.releaseDocument, violations)
  return violations
}

export function assertIosPrivacyManifest(repositoryRoot) {
  const violations = inspectIosPrivacyManifest(loadIosPrivacyManifestSources(repositoryRoot))
  if (violations.length > 0) throw new Error(`iOS privacy manifest preflight failed:\n${violations.map((violation) => `- ${violation}`).join('\n')}`)
}

const invokedPath = process.argv[1] && resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  assertIosPrivacyManifest(resolve(fileURLToPath(import.meta.url), '../../..'))
  console.log('PASS iOS privacy manifest source contract (archive and App Store reconciliation remain blocked)')
}
