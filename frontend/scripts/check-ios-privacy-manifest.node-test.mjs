import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  assertIosPrivacyManifest,
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

async function createRepositoryFixture(t) {
  const container = await mkdtemp(join(tmpdir(), 'dupert-ios-privacy-repository-'))
  const root = join(container, 'repository')
  const current = sources()
  await mkdir(join(root, 'frontend/ios/App/App'), { recursive: true })
  await mkdir(join(root, 'frontend/ios/App/App.xcodeproj'), { recursive: true })
  await mkdir(join(root, 'docs/mobile'), { recursive: true })
  await writeFile(join(root, 'frontend/ios/App/App/PrivacyInfo.xcprivacy'), current.manifest)
  await writeFile(join(root, 'frontend/ios/App/App.xcodeproj/project.pbxproj'), current.project)
  await writeFile(join(root, 'docs/mobile/ios-privacy-manifest-inventory.md'), current.inventory)
  await writeFile(join(root, 'docs/mobile/release-readiness.md'), current.releaseDocument)
  t.after(() => rm(container, { force: true, recursive: true }))
  return root
}

test('accepts the repository-backed app-owned privacy manifest contract', () => {
  assert.deepEqual(inspectIosPrivacyManifest(sources()), [])
})

test('rejects a symlink or non-regular app manifest before reading it', async (t) => {
  const container = await mkdtemp(join(tmpdir(), 'dupert-ios-privacy-files-'))
  const root = join(container, 'repository')
  const appDirectory = join(root, 'frontend/ios/App/App')
  await mkdir(appDirectory, { recursive: true })
  t.after(() => rm(container, { force: true, recursive: true }))

  const outside = join(container, 'outside.xcprivacy')
  await writeFile(outside, 'outside fixture')
  await symlink(outside, join(appDirectory, 'PrivacyInfo.xcprivacy'))
  assert.throws(() => loadIosPrivacyManifestSources(root), /must not be a symlink/)

  await rm(join(appDirectory, 'PrivacyInfo.xcprivacy'))
  await mkdir(join(appDirectory, 'PrivacyInfo.xcprivacy'))
  assert.throws(() => loadIosPrivacyManifestSources(root), /must be a regular file/)
})

test('rejects a repository path that resolves through an escaping parent symlink', async (t) => {
  const container = await mkdtemp(join(tmpdir(), 'dupert-ios-privacy-escape-'))
  const root = join(container, 'repository')
  const outsideFrontend = join(container, 'outside-frontend')
  await mkdir(root)
  await mkdir(join(outsideFrontend, 'ios/App/App'), { recursive: true })
  await symlink(outsideFrontend, join(root, 'frontend'))
  t.after(() => rm(container, { force: true, recursive: true }))

  assert.throws(() => loadIosPrivacyManifestSources(root), /must resolve inside the repository/)
})

test('recursively rejects nested and unaccounted app-owned manifests', async (t) => {
  const root = await createRepositoryFixture(t)
  const nestedDirectory = join(root, 'frontend/ios/App/App/Nested')
  await mkdir(nestedDirectory)
  await writeFile(join(nestedDirectory, 'Other.xcprivacy'), sources().manifest)
  assert.throws(() => assertIosPrivacyManifest(root), /exactly one app-owned/)

  await rm(join(root, 'frontend/ios/App/App/PrivacyInfo.xcprivacy'))
  assert.throws(() => assertIosPrivacyManifest(root), /exactly one app-owned/)
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
  expectRejected((candidate) => {
    candidate.manifest += '\n<?xml version="1.0" encoding="UTF-8"?>\n'
  }, /exactly one canonical XML declaration and DOCTYPE/)
  expectRejected((candidate) => {
    candidate.manifest += '\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
  }, /exactly one canonical XML declaration and DOCTYPE/)
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
      'NSPrivacyCollectedDataTypeSearchHistory',
      'NSPrivacyCollectedDataTypeProductInteraction',
    )
  }, /canonical/)
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
  }, /unexpected|file reference/)
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

test('rejects alternate privacy object IDs, comments, and Resources decoys', () => {
  expectRejected((candidate) => {
    candidate.project = candidate.project.replace(
      '/* End PBXFileReference section */',
      '\t\tDEADBEEFDEADBEEFDEADBEEF /* Decoy */ = {isa = PBXFileReference; lastKnownFileType = text.plist.xml; path = PrivacyInfo.xcprivacy; sourceTree = "<group>"; };\n/* End PBXFileReference section */',
    )
  }, /unexpected/)
  expectRejected((candidate) => {
    candidate.project = candidate.project.replace(
      '/* End PBXBuildFile section */',
      `\t\tDEADBEEFDEADBEEFDEADBEEF /* Decoy */ = {isa = PBXBuildFile; fileRef = 7B31F0F7A1B2C3D4E5F60708; };\n/* End PBXBuildFile section */`,
    )
  }, /build file/)
  expectRejected((candidate) => {
    candidate.project = candidate.project.replace(
      '7B31F0F8A1B2C3D4E5F60708 /* PrivacyInfo.xcprivacy in Resources */,',
      'DEADBEEFDEADBEEFDEADBEEF /* PrivacyInfo.xcprivacy in Resources */,\n\t\t\t\t7B31F0F8A1B2C3D4E5F60708 /* PrivacyInfo.xcprivacy in Resources */,',
    )
  }, /unexpected|Resources/)
})

test('rejects canonical privacy object IDs reused behind decoy comments', () => {
  expectRejected((candidate) => {
    candidate.project = candidate.project.replace(
      '/* End PBXResourcesBuildPhase section */',
      '\t\tDEADBEEFDEADBEEFDEADBEEF /* Other Resources */ = {\n\t\t\tisa = PBXResourcesBuildPhase;\n\t\t\tfiles = (\n\t\t\t\t7B31F0F8A1B2C3D4E5F60708 /* Decoy */,\n\t\t\t);\n\t\t};\n/* End PBXResourcesBuildPhase section */',
    )
  }, /object IDs/)
  expectRejected((candidate) => {
    candidate.project = candidate.project.replace(
      '/* End PBXGroup section */',
      '\t\tDEADBEEFDEADBEEFDEADBEEF /* Other */ = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n\t\t\t\t7B31F0F7A1B2C3D4E5F60708 /* Decoy */,\n\t\t\t);\n\t\t};\n/* End PBXGroup section */',
    )
  }, /object IDs/)
})

test('rejects duplicate Xcode sections and duplicate App or Resources objects', () => {
  expectRejected((candidate) => {
    candidate.project += '\n/* Begin PBXResourcesBuildPhase section */\n/* End PBXResourcesBuildPhase section */\n'
  }, /exactly one PBXResourcesBuildPhase section/)
  expectRejected((candidate) => {
    candidate.project = candidate.project.replace(
      '/* End PBXResourcesBuildPhase section */',
      '\t\t504EC3021FED79650016851F /* Resources */ = {\n\t\t\tisa = PBXResourcesBuildPhase;\n\t\t};\n/* End PBXResourcesBuildPhase section */',
    )
  }, /Resources phase/)
  expectRejected((candidate) => {
    candidate.project = candidate.project.replace(
      '/* End PBXNativeTarget section */',
      '\t\t504EC3031FED79650016851F /* App */ = {\n\t\t\tisa = PBXNativeTarget;\n\t\t};\n/* End PBXNativeTarget section */',
    )
  }, /App target/)
  expectRejected((candidate) => {
    candidate.project = candidate.project.replace(
      '/* End PBXResourcesBuildPhase section */',
      '\t\t504EC3021FED79650016851F /* Decoy */ = {\n\t\t\tisa = PBXResourcesBuildPhase;\n\t\t};\n/* End PBXResourcesBuildPhase section */',
    )
  }, /canonical occurrences/)
  expectRejected((candidate) => {
    candidate.project = candidate.project.replace(
      '/* End PBXNativeTarget section */',
      '\t\t504EC3031FED79650016851F /* Decoy */ = {\n\t\t\tisa = PBXNativeTarget;\n\t\t};\n/* End PBXNativeTarget section */',
    )
  }, /canonical occurrences/)
})

test('allows unrelated Xcode resource phases and native targets', () => {
  const candidate = sources()
  candidate.project = candidate.project
    .replace(
      '/* End PBXResourcesBuildPhase section */',
      '\t\tDEADBEEFDEADBEEFDEADBEEF /* Other Resources */ = {\n\t\t\tisa = PBXResourcesBuildPhase;\n\t\t};\n/* End PBXResourcesBuildPhase section */',
    )
    .replace(
      '/* End PBXNativeTarget section */',
      '\t\tFEEDFACEFEEDFACEFEEDFACE /* Other */ = {\n\t\t\tisa = PBXNativeTarget;\n\t\t};\n/* End PBXNativeTarget section */',
    )
  assert.deepEqual(inspectIosPrivacyManifest(candidate), [])
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
  }, /exactly one canonical BLOCKED/)
  expectRejected((candidate) => {
    candidate.releaseDocument = candidate.releaseDocument.replace(
      'Xcode archive privacy report + App Store Connect reconciliation',
      'privacy declaration is ready for App Store approval',
    )
  }, /exactly one canonical BLOCKED/)
  for (const status of ['CLEARED', 'GO', 'READY', 'APPROVED']) {
    expectRejected((candidate) => {
      candidate.inventory = candidate.inventory.replace('**BLOCKED**', `**${status}**`)
    }, /must not claim release or approval status/)
  }
})

test('rejects duplicate or contradictory privacy ledger rows and blocks', () => {
  expectRejected((candidate) => {
    const privacyRow = candidate.releaseDocument.split('\n').find((line) => line.startsWith('| Privacy and store metadata |'))
    candidate.releaseDocument = candidate.releaseDocument.replace(privacyRow, `${privacyRow}\n${privacyRow}`)
  }, /exactly one canonical BLOCKED/)
  expectRejected((candidate) => {
    const gateBlock = candidate.releaseDocument.match(/<!-- mobile-release-gates:start -->[\s\S]*?<!-- mobile-release-gates:end -->/)[0]
    candidate.releaseDocument += `\n${gateBlock}\n`
  }, /exactly one canonical BLOCKED/)
  expectRejected((candidate) => {
    candidate.releaseDocument = candidate.releaseDocument.replace(
      '<!-- mobile-release-gates:start -->',
      '<!-- mobile-release-gates:start -->\n<!-- mobile-release-gates:start -->',
    )
  }, /exactly one canonical BLOCKED/)
  expectRejected((candidate) => {
    const privacyRow = candidate.releaseDocument.split('\n').find((line) => line.startsWith('| Privacy and store metadata |'))
    candidate.releaseDocument = `${privacyRow}\n${candidate.releaseDocument.replace(privacyRow, '| Privacy and store metadata | PASS | Owner | Decoy |')}`
  }, /exactly one canonical BLOCKED/)
  expectRejected((candidate) => {
    const privacyRow = candidate.releaseDocument.split('\n').find((line) => line.startsWith('| Privacy and store metadata |'))
    candidate.releaseDocument = candidate.releaseDocument.replace(privacyRow, `<!--\n${privacyRow}\n-->`)
  }, /exactly one canonical BLOCKED/)
  expectRejected((candidate) => {
    candidate.releaseDocument += '\nPrivacy and store metadata is READY.\n'
  }, /exactly one canonical BLOCKED/)
})

test('rejects a vendor-boundary claim hidden only in an HTML comment', () => {
  expectRejected((candidate) => {
    candidate.inventory = candidate.inventory.replace(
      'vendor SDK manifests remain separate',
      '<!-- vendor SDK manifests remain separate --> vendor behavior is unspecified',
    )
  }, /claims visible|missing required claim/)
})
