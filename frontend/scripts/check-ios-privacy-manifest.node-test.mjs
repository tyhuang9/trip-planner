import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  inspectIosPrivacyManifest,
  loadIosPrivacyManifestSources,
} from './check-ios-privacy-manifest.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function sources() {
  return loadIosPrivacyManifestSources(repositoryRoot)
}

function violations(candidate) {
  return inspectIosPrivacyManifest(candidate).join('\n')
}

function expectRejected(mutate, expected = /privacy manifest|Xcode|privacy inventory|Privacy and store metadata|release readiness/) {
  const candidate = sources()
  mutate(candidate)
  assert.match(violations(candidate), expected)
}

test('accepts the repository-backed app-owned privacy manifest contract', () => {
  assert.deepEqual(inspectIosPrivacyManifest(sources()), [])
})

test('rejects missing or duplicate app-owned manifests', () => {
  expectRejected((candidate) => {
    candidate.manifestPaths = []
    candidate.manifest = null
  }, /exactly one app-owned/)
  expectRejected((candidate) => {
    candidate.manifestPaths = [
      'frontend/ios/App/App/PrivacyInfo.xcprivacy',
      'frontend/ios/App/App/Other.xcprivacy',
    ]
    candidate.manifest = null
  }, /exactly one app-owned/)
})

test('rejects malformed or non-canonical plist structure and keys', () => {
  expectRejected((candidate) => { candidate.manifest = '<plist version="1.0"><dict>' }, /malformed/)
  expectRejected((candidate) => {
    candidate.manifest = candidate.manifest.replace(
      '<key>NSPrivacyCollectedDataTypes</key>',
      '<key>Unexpected</key><false/><key>NSPrivacyCollectedDataTypes</key>',
    )
  }, /canonical/)
  expectRejected((candidate) => {
    candidate.manifest = candidate.manifest.replace(
      '<key>NSPrivacyTracking</key>\n\t<false/>',
      '<key>NSPrivacyTracking</key>\n\t<true/>',
    )
  }, /canonical/)
  expectRejected((candidate) => {
    candidate.manifest = candidate.manifest.replace(
      '<key>NSPrivacyTracking</key>',
      '<string>NSPrivacyTracking</string>',
    )
  }, /malformed/)
  expectRejected((candidate) => {
    candidate.manifest = candidate.manifest.replace(
      '<string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string>',
      '<key>NSPrivacyCollectedDataTypePurposeAppFunctionality</key>',
    )
  }, /malformed/)
})

test('rejects tracking domains and any accessed API declaration, including an empty array', () => {
  expectRejected((candidate) => {
    candidate.manifest = candidate.manifest.replace(
      '<key>NSPrivacyTracking</key>',
      '<key>NSPrivacyTrackingDomains</key><array><string>tracking.example</string></array><key>NSPrivacyTracking</key>',
    )
  }, /canonical/)
  expectRejected((candidate) => {
    candidate.manifest = candidate.manifest.replace(
      '<key>NSPrivacyTracking</key>',
      '<key>NSPrivacyAccessedAPITypes</key><array></array><key>NSPrivacyTracking</key>',
    )
  }, /canonical/)
})

test('rejects missing, extra, duplicate, and wrong collected data types', () => {
  expectRejected((candidate) => {
    candidate.manifest = candidate.manifest.replace(
      'NSPrivacyCollectedDataTypeOtherUserContent',
      'NSPrivacyCollectedDataTypeName',
    )
  }, /canonical/)
  expectRejected((candidate) => {
    candidate.manifest = candidate.manifest.replace(
      'NSPrivacyCollectedDataTypeName',
      'NSPrivacyCollectedDataTypePhoneNumber',
    )
  }, /canonical/)
  expectRejected((candidate) => {
    candidate.manifest = candidate.manifest.replace(
      '\t</array>\n</dict>\n</plist>',
      '\t\t<dict><key>NSPrivacyCollectedDataType</key><string>NSPrivacyCollectedDataTypeName</string><key>NSPrivacyCollectedDataTypeLinked</key><true/><key>NSPrivacyCollectedDataTypeTracking</key><false/><key>NSPrivacyCollectedDataTypePurposes</key><array><string>NSPrivacyCollectedDataTypePurposeAppFunctionality</string></array></dict>\n\t</array>\n</dict>\n</plist>',
    )
  }, /canonical/)
})

test('rejects incorrect linked, tracking, and purpose flags', () => {
  expectRejected((candidate) => {
    candidate.manifest = candidate.manifest.replace(
      '<key>NSPrivacyCollectedDataTypeLinked</key>\n\t\t\t<true/>',
      '<key>NSPrivacyCollectedDataTypeLinked</key>\n\t\t\t<false/>',
    )
  }, /canonical/)
  expectRejected((candidate) => {
    candidate.manifest = candidate.manifest.replace(
      '<key>NSPrivacyCollectedDataTypeTracking</key>\n\t\t\t<false/>',
      '<key>NSPrivacyCollectedDataTypeTracking</key>\n\t\t\t<true/>',
    )
  }, /canonical/)
  expectRejected((candidate) => {
    candidate.manifest = candidate.manifest.replace(
      'NSPrivacyCollectedDataTypePurposeAppFunctionality',
      'NSPrivacyCollectedDataTypePurposeAnalytics',
    )
  }, /canonical/)
})

test('rejects missing, duplicate, or wrong Xcode manifest references and Resources membership', () => {
  expectRejected((candidate) => {
    candidate.project = candidate.project.replace('path = PrivacyInfo.xcprivacy;', 'path = Wrong.xcprivacy;')
  }, /file reference/)
  expectRejected((candidate) => {
    candidate.project += '\n7B31F0F7A1B2C3D4E5F60708 /* PrivacyInfo.xcprivacy */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = PrivacyInfo.xcprivacy; sourceTree = "<group>"; };\n'
  }, /file reference|must contain one/)
  expectRejected((candidate) => {
    candidate.project = candidate.project.replace('fileRef = 7B31F0F7A1B2C3D4E5F60708', 'fileRef = DEADBEEFDEADBEEFDEADBEEF')
  }, /build file/)
  expectRejected((candidate) => {
    candidate.project = candidate.project.replace('7B31F0F8A1B2C3D4E5F60708 /* PrivacyInfo.xcprivacy in Resources */,\n', '')
  }, /Resources/)
  expectRejected((candidate) => {
    candidate.project = candidate.project.replace('\t\t\t\t504EC3021FED79650016851F /* Resources */,\n', '')
  }, /App target/)
})

test('rejects privacy documentation that claims PASS or broadens the contract', () => {
  expectRejected((candidate) => {
    candidate.inventory = candidate.inventory.replace('**BLOCKED**', '**PASS**')
  }, /inventory/)
  expectRejected((candidate) => {
    candidate.inventory = candidate.inventory.replace('vendor SDK manifests remain separate', 'vendor SDK behavior is declared')
  }, /inventory/)
  expectRejected((candidate) => {
    candidate.releaseDocument = candidate.releaseDocument.replace(
      '| Privacy and store metadata | BLOCKED |',
      '| Privacy and store metadata | PASS |',
    )
  }, /must remain BLOCKED/)
  expectRejected((candidate) => {
    candidate.releaseDocument = candidate.releaseDocument.replace(
      'Xcode archive privacy report + App Store Connect reconciliation',
      'privacy declaration is ready for App Store approval',
    )
  }, /archive privacy report|must not claim privacy/)
})
