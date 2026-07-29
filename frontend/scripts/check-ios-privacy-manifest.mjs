import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const MANIFEST_PATH = 'frontend/ios/App/App/PrivacyInfo.xcprivacy'
const INVENTORY_PATH = 'docs/mobile/ios-privacy-manifest-inventory.md'
const PROJECT_PATH = 'frontend/ios/App/App.xcodeproj/project.pbxproj'
const FILE_REF = '7B31F0F7A1B2C3D4E5F60708'
const BUILD_FILE = '7B31F0F8A1B2C3D4E5F60708'
const PRIVACY_GATE_ROW = '| Privacy and store metadata | BLOCKED | Unassigned | App-owned manifest source contract passes, but Xcode archive privacy report + App Store Connect reconciliation, vendor manifests, disclosures, review data, and screenshots are not recorded |'
const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>'
const PLIST_DOCTYPE = '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
const DATA_TYPES = [
  'NSPrivacyCollectedDataTypeName',
  'NSPrivacyCollectedDataTypeEmailAddress',
  'NSPrivacyCollectedDataTypeUserID',
  'NSPrivacyCollectedDataTypeOtherUserContent',
  'NSPrivacyCollectedDataTypeSearchHistory',
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
  const prefix = `${XML_DECLARATION}\n${PLIST_DOCTYPE}\n`
  if (!source.startsWith(prefix)
    || source.split(XML_DECLARATION).length !== 2
    || source.split(PLIST_DOCTYPE).length !== 2) {
    throw new Error('must begin with exactly one canonical XML declaration and DOCTYPE')
  }
  const tokens = []
  for (const rawToken of source.slice(prefix.length).match(/<[^>]+>|[^<]+/g) ?? []) {
    if (!rawToken.startsWith('<')) {
      if (rawToken.trim()) tokens.push({ kind: 'text', value: rawToken })
      continue
    }
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

function projectSection(project, name, violations) {
  const begin = new RegExp(`/\\* Begin ${name} section \\*/`, 'g')
  const end = new RegExp(`/\\* End ${name} section \\*/`, 'g')
  if (count(project, begin) !== 1 || count(project, end) !== 1) {
    violations.push(`Xcode project must contain exactly one ${name} section`)
    return null
  }
  return project.match(new RegExp(`/\\* Begin ${name} section \\*/([\\s\\S]*?)/\\* End ${name} section \\*/`))?.[1] ?? null
}

function inspectXcodeProject(project, violations) {
  const fileReferenceLine = `${FILE_REF} /* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = PrivacyInfo.xcprivacy; sourceTree = "<group>"; };`
  const buildFileLine = `${BUILD_FILE} /* PrivacyInfo.xcprivacy in Resources */ = {isa = PBXBuildFile; fileRef = ${FILE_REF} /* PrivacyInfo.xcprivacy */; };`
  const groupLine = `${FILE_REF} /* PrivacyInfo.xcprivacy */,`
  const resourceLine = `${BUILD_FILE} /* PrivacyInfo.xcprivacy in Resources */,`
  const allowedPrivacyLines = new Set([fileReferenceLine, buildFileLine, groupLine, resourceLine])
  const privacyLines = project.split('\n').map((line) => line.trim()).filter((line) => line.includes('.xcprivacy'))
  if (privacyLines.some((line) => !allowedPrivacyLines.has(line))
    || privacyLines.filter((line) => line === fileReferenceLine).length !== 1
    || privacyLines.filter((line) => line === buildFileLine).length !== 1
    || privacyLines.filter((line) => line === resourceLine).length !== 1
    || privacyLines.filter((line) => line === groupLine).length > 1) {
    violations.push('Xcode project contains an unexpected or duplicate privacy manifest reference')
  }
  if (count(project, new RegExp(BUILD_FILE, 'g')) !== 2
    || count(project, new RegExp(FILE_REF, 'g')) !== 3) {
    violations.push('Xcode privacy manifest object IDs must have only their canonical references')
  }

  const buildSection = projectSection(project, 'PBXBuildFile', violations)
  const fileSection = projectSection(project, 'PBXFileReference', violations)
  const resourcesSection = projectSection(project, 'PBXResourcesBuildPhase', violations)
  const targetSection = projectSection(project, 'PBXNativeTarget', violations)
  if (!fileSection || fileSection.split('\n').filter((line) => line.trim() === fileReferenceLine).length !== 1) {
    violations.push('Xcode privacy manifest file reference is missing, duplicated, or wrong')
  }
  if (!buildSection
    || buildSection.split('\n').filter((line) => line.trim() === buildFileLine).length !== 1
    || count(buildSection, new RegExp(`isa = PBXBuildFile; fileRef = ${FILE_REF}\\b`, 'g')) !== 1) {
    violations.push('Xcode privacy manifest build file is missing, duplicated, or wrong')
  }

  const resources = resourcesSection?.match(/504EC3021FED79650016851F \/\* Resources \*\/ = \{[\s\S]*?files = \(([\s\S]*?)\);/)
  if (!resourcesSection
    || count(resourcesSection, /^\s*504EC3021FED79650016851F \/\* Resources \*\/ = \{$/gm) !== 1
    || !resources || resources[1].split('\n').filter((line) => line.trim() === resourceLine).length !== 1) {
    violations.push('Xcode privacy manifest must be a single member of the App Resources phase')
  }
  const appTarget = targetSection?.match(/504EC3031FED79650016851F \/\* App \*\/ = \{[\s\S]*?buildPhases = \(([\s\S]*?)\);/)
  if (!targetSection
    || count(targetSection, /^\s*504EC3031FED79650016851F \/\* App \*\/ = \{$/gm) !== 1
    || !appTarget || count(appTarget[1], /504EC3021FED79650016851F \/\* Resources \*\//g) !== 1) {
    violations.push('Xcode App target must contain the Resources phase exactly once')
  }
}

function inspectDocumentation(inventory, releaseDocument, violations) {
  const visibleInventory = inventory.replace(/<!--[\s\S]*?-->/g, '')
  const requiredInventoryClaims = [
    '`frontend/ios/App/App/PrivacyInfo.xcprivacy`',
    '`frontend/ios/App/App/AppDelegate.swift`',
    '`frontend/src/api/auth.ts`',
    '`frontend/src/api/trips.ts`',
    '`frontend/src/api/activities.ts`',
    '`frontend/src/components/googlePlaces.ts`',
    '`backend/src/main/java/com/trip/service/google/GoogleMapsService.java`',
    '`backend/src/main/java/com/trip/service/google/GoogleCacheService.java`',
    'vendor SDK manifests remain separate',
    '`NSPrivacyTracking` is `false`',
    '`NSPrivacyTrackingDomains` and\n`NSPrivacyAccessedAPITypes` are absent',
    'Xcode archive\nproduces its privacy report',
    'App\nStore Connect',
  ]
  for (const claim of requiredInventoryClaims) {
    if (!visibleInventory.includes(claim)) violations.push(`privacy inventory is missing required claim: ${claim.replaceAll('\n', ' ')}`)
  }
  for (const dataType of DATA_TYPES) {
    if (!visibleInventory.includes(`\`${dataType}\``)) violations.push(`privacy inventory is missing ${dataType}`)
  }
  if (/<!--|-->/.test(inventory)) {
    violations.push('privacy inventory must keep contract claims visible rather than in HTML comments')
  }
  if (/\b(?:PASS|CLEARED|GO|READY|APPROVED)\b/i.test(visibleInventory)) {
    violations.push('privacy inventory must not claim release or approval status')
  }
  const gateBlocks = [...releaseDocument.matchAll(/<!-- mobile-release-gates:start -->([\s\S]*?)<!-- mobile-release-gates:end -->/g)]
  const privacyRows = releaseDocument.split('\n').map((line) => line.trim()).filter((line) => line.startsWith('| Privacy and store metadata |'))
  if (count(releaseDocument, /<!-- mobile-release-gates:start -->/g) !== 1
    || count(releaseDocument, /<!-- mobile-release-gates:end -->/g) !== 1
    || gateBlocks.length !== 1 || privacyRows.length !== 1
    || privacyRows[0] !== PRIVACY_GATE_ROW || !gateBlocks[0][1].includes(PRIVACY_GATE_ROW)) {
    violations.push('release readiness must contain exactly one canonical BLOCKED privacy and store gate')
  }
}

function checkedPath(repositoryRoot, relativePath, expectedType) {
  const root = realpathSync(repositoryRoot)
  const candidate = resolve(repositoryRoot, relativePath)
  const stats = lstatSync(candidate)
  if ((expectedType === 'file' && !stats.isFile()) || (expectedType === 'directory' && !stats.isDirectory())) {
    throw new Error(`${relativePath} must be a regular ${expectedType}`)
  }
  const actual = realpathSync(candidate)
  const fromRoot = relative(root, actual)
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${relativePath} must resolve inside the repository`)
  }
  return actual
}

function readRepositoryFile(repositoryRoot, relativePath) {
  return readFileSync(checkedPath(repositoryRoot, relativePath, 'file'), 'utf8')
}

function privacyManifestPaths(repositoryRoot, directory, relativeDirectory) {
  const paths = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = `${relativeDirectory}/${entry.name}`
    if (entry.isSymbolicLink()) throw new Error(`${relativePath} must not be a symlink`)
    if (entry.name.endsWith('.xcprivacy')) paths.push(relativePath)
    if (entry.isDirectory()) {
      const child = checkedPath(repositoryRoot, relativePath, 'directory')
      paths.push(...privacyManifestPaths(repositoryRoot, child, relativePath))
    }
  }
  return paths.sort()
}

export function loadIosPrivacyManifestSources(repositoryRoot) {
  const root = resolve(repositoryRoot)
  const appDirectory = checkedPath(root, 'frontend/ios/App/App', 'directory')
  const manifestPaths = privacyManifestPaths(root, appDirectory, 'frontend/ios/App/App')
  return {
    manifestPaths,
    manifest: manifestPaths.length === 1 ? readRepositoryFile(root, manifestPaths[0]) : null,
    project: readRepositoryFile(root, PROJECT_PATH),
    inventory: readRepositoryFile(root, INVENTORY_PATH),
    releaseDocument: readRepositoryFile(root, 'docs/mobile/release-readiness.md'),
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
