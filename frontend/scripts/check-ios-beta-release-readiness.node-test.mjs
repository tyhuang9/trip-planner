import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { assertIosBetaReleaseReadiness, inspectIosBetaReleaseReadiness, loadIosBetaReleaseReadinessResultCopies } from './check-ios-beta-release-readiness.mjs'

const root = resolve(import.meta.dirname, '../..')
const read = (path) => readFile(resolve(root, path), 'utf8')

async function contract() {
  return { template: await read('docs/mobile/ios-beta-release-readiness.template.json'), runbook: await read('docs/mobile/ios-beta-release-readiness-runbook.md'), trackedFiles: [], resultCopies: {} }
}

function completed() {
  const ids = ['auth_device_matrix_and_adr', 'map_renderer_and_restricted_key', 'universal_links_hosted_signed_and_device', 'signed_archive_provenance_and_install', 'privacy_support_deletion_and_store_metadata', 'previous_build_current_staging_smoke', 'rollback_monitoring_and_escalation']
  return JSON.stringify({
    schema_version: 1, template_status: 'COMPLETED', notice: 'COMPLETED RESULTS / CLAIM-BEARING ARTIFACT',
    copy_results_to: 'docs/mobile/evidence/ios-beta-release-readiness/YYYY-MM-DD/<lowercase-run-id>/results.json', platform: 'ios',
    release_roles: { release_owner: '@release', go_no_go_approver: '@approver', support_owner: '@support', monitoring_owner: '@monitoring' },
    checks: ids.map((checkId) => ({ check_id: checkId, status: 'PASS', restricted_evidence_reference: `restricted://ios-beta-release-readiness/beta-run/${checkId}`, summary: 'Reviewed in restricted evidence.' })),
    go_no_go: 'GO', redaction_policy: 'Raw material is retained only in restricted storage.',
    references: { runbook: 'docs/mobile/ios-beta-release-readiness-runbook.md' },
  })
}

test('accepts the unexecuted iOS beta source contract', async () => {
  assert.deepEqual(inspectIosBetaReleaseReadiness(await contract()), [])
})

test('standalone enforcement requires tracked-file input', async () => {
  const value = await contract()
  assert.throws(() => assertIosBetaReleaseReadiness(value), /tracked-file input must not be empty/)
})

test('accepts a complete GO only when every required check is PASS', async () => {
  const value = await contract()
  const path = 'docs/mobile/evidence/ios-beta-release-readiness/2026-08-03/beta-run/results.json'
  value.trackedFiles = [path]
  value.resultCopies = { [path]: completed() }
  assert.deepEqual(inspectIosBetaReleaseReadiness(value), [])
  const rejected = JSON.parse(completed())
  rejected.checks[0].status = 'BLOCKED'
  value.resultCopies = { [path]: JSON.stringify(rejected) }
  assert.ok(inspectIosBetaReleaseReadiness(value).some((entry) => /GO requires every check/.test(entry)))
})

test('rejects untracked results, raw captures, and source-template claims', async () => {
  const value = await contract()
  value.template = value.template.replace('"template_status": "UNEXECUTED"', '"template_status": "PASS"')
  const path = 'docs/mobile/evidence/ios-beta-release-readiness/2026-08-03/beta-run/results.json'
  const result = JSON.parse(completed())
  result.checks[0].summary = 'screenshot.png and Authorization: Bearer unsafe-value'
  value.trackedFiles = [path, 'docs/mobile/evidence/ios-beta-release-readiness/not-results.json']
  value.resultCopies = { [path]: JSON.stringify(result) }
  const output = inspectIosBetaReleaseReadiness(value).join('\n')
  assert.match(output, /template must remain unexecuted/)
  assert.match(output, /raw credential material, capture, or artifact data/)
  assert.match(output, /evidence path is unauthorized/)
})

test('rejects credential-bearing fields and encoded credential material without echoing values', async () => {
  const cases = [
    (result) => { result.private_key = 'sensitive-fixture-value' },
    (result) => { result.clientSecret = 'sensitive-fixture-value' },
    (result) => { result.checks[0].summary = '-----BEGIN PRIVATE KEY----- sensitive-fixture-value' },
  ]
  for (const mutate of cases) {
    const value = await contract()
    const path = 'docs/mobile/evidence/ios-beta-release-readiness/2026-08-03/beta-run/results.json'
    const result = JSON.parse(completed())
    mutate(result)
    value.trackedFiles = [path]
    value.resultCopies = { [path]: JSON.stringify(result) }
    const output = inspectIosBetaReleaseReadiness(value).join('\n')
    assert.match(output, /raw credential material, capture, or artifact data/)
    assert.doesNotMatch(output, /sensitive-fixture-value/)
  }
})

test('rejects standalone provider token shapes without echoing them', async () => {
  const alphabeticPayload = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  const githubPayload = `${alphabeticPayload}abcdef`
  const opaqueLegacyGithubTokens = ['p', 'o', 'u', 'r'].map((kind) => [`gh${kind}_`, 'A'.repeat(20), '_', 'B'.repeat(20)].join(''))
  const fineGrainedGithubPat = ['github', '_pat_', 'A'.repeat(22), '_', 'B'.repeat(59)].join('')
  const statelessGithubAppToken = ['ghs_', '123456', '_', 'headerABC', '.', 'payload-with_url', '.', 'signatureABC'].join('')
  const trailingOpaqueGithubAppTokens = ['_', '-'].map((suffix) => ['ghs_', 'A'.repeat(36), suffix].join(''))
  const providerTokens = [
    ...['p', 'o', 'u', 'r'].map((kind) => `gh${kind}_${githubPayload}`),
    ...opaqueLegacyGithubTokens,
    fineGrainedGithubPat,
    statelessGithubAppToken,
    ...trailingOpaqueGithubAppTokens,
    ['glpat-', alphabeticPayload].join(''),
    ...['b', 'a', 'p', 'r', 's'].map((kind) => `xox${kind}-1234567890-abcdefghijklmnop`),
    ['sk_', 'live_', alphabeticPayload].join(''),
    ['sk_', 'test_', alphabeticPayload].join(''),
    ['AK', 'IA', 'IOSFODNN7EXAMPLE'].join(''),
    ['AS', 'IA', 'IOSFODNN7EXAMPLE'].join(''),
  ]
  for (const providerToken of providerTokens) {
    const value = await contract()
    const path = 'docs/mobile/evidence/ios-beta-release-readiness/2026-08-03/beta-run/results.json'
    const result = JSON.parse(completed())
    result.checks[0].summary = `Reviewed ${providerToken} in restricted evidence.`
    value.trackedFiles = [path]
    value.resultCopies = { [path]: JSON.stringify(result) }
    const output = inspectIosBetaReleaseReadiness(value).join('\n')
    assert.match(output, /raw credential material, capture, or artifact data/)
    assert.doesNotMatch(output, new RegExp(providerToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
})

test('allows provider prefix prose and token-like substrings inside ordinary identifiers', async () => {
  const embeddedGithubIdentifier = ['build_ghp_', 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef', '_reference'].join('')
  const embeddedOpaqueLegacyGithubIdentifier = ['build_ghp_', 'A'.repeat(20), '_', 'B'.repeat(20), '_reference'].join('')
  const embeddedFineGrainedIdentifier = ['build_', 'github_pat_', 'A'.repeat(22), '_', 'B'.repeat(59), '_reference'].join('')
  const embeddedStatelessIdentifier = ['build_ghs_', '123456_headerABC.payload-with_url.signatureABC', '_reference'].join('')
  const embeddedTrailingOpaqueIdentifier = ['build_ghs_', 'A'.repeat(36), '-_reference'].join('')
  const embeddedAwsIdentifier = ['fixture_AK', 'IAIOSFODNN7EXAMPLE_reference'].join('')
  const summaries = [
    'The ghp_, ghs_, github_pat_, glpat-, xoxb-, and sk_test_ prefixes are prohibited here.',
    'The AWS access-key prefixes are AKIA and ASIA.',
    `Build identifier ${embeddedGithubIdentifier} was already scrubbed.`,
    `Build identifier ${embeddedOpaqueLegacyGithubIdentifier} was already scrubbed.`,
    `Build identifier ${embeddedFineGrainedIdentifier} was already scrubbed.`,
    `Build identifier ${embeddedStatelessIdentifier} was already scrubbed.`,
    `Build identifier ${embeddedTrailingOpaqueIdentifier} was already scrubbed.`,
    `Fixture identifier ${embeddedAwsIdentifier} is not a standalone credential.`,
  ]
  for (const summary of summaries) {
    const value = await contract()
    const path = 'docs/mobile/evidence/ios-beta-release-readiness/2026-08-03/beta-run/results.json'
    const result = JSON.parse(completed())
    result.checks[0].summary = summary
    value.trackedFiles = [path]
    value.resultCopies = { [path]: JSON.stringify(result) }
    assert.deepEqual(inspectIosBetaReleaseReadiness(value), [])
  }
})

test('never echoes a secret-shaped check_id through secondary violations', async () => {
  const secretCheckId = ['github', '_pat_', 'C'.repeat(22), '_', 'D'.repeat(59)].join('')
  const value = await contract()
  const path = 'docs/mobile/evidence/ios-beta-release-readiness/2026-08-03/beta-run/results.json'
  const unauthorizedPath = `docs/mobile/evidence/ios-beta-release-readiness/${secretCheckId}/results.json`
  const result = JSON.parse(completed())
  result.checks[0] = {
    check_id: secretCheckId,
    status: 'INVALID',
    restricted_evidence_reference: 'invalid-reference',
    summary: '',
  }
  value.trackedFiles = [path, unauthorizedPath]
  value.resultCopies = { [path]: JSON.stringify(result), [unauthorizedPath]: '{}' }
  const output = inspectIosBetaReleaseReadiness(value).join('\n')
  assert.match(output, /iOS beta check 1 \(auth_device_matrix_and_adr\) must use its expected check_id/)
  assert.match(output, /has invalid completed status/)
  assert.match(output, /must be a scoped restricted evidence reference/)
  assert.match(output, /requires a summary/)
  assert.match(output, /iOS beta result copy 2 must be tracked at an authorized dated path/)
  assert.match(output, /tracked iOS beta evidence path is unauthorized \(position 2\)/)
  assert.doesNotMatch(output, new RegExp(secretCheckId))
})

test('uses a positional parse label instead of echoing a result path', async () => {
  const value = await contract()
  const path = 'docs/mobile/evidence/ios-beta-release-readiness/2026-08-03/parse-label-run/results.json'
  value.trackedFiles = [path]
  value.resultCopies = { [path]: '{ invalid json' }
  const output = inspectIosBetaReleaseReadiness(value).join('\n')
  assert.match(output, /iOS beta result copy 1 must be valid JSON/)
  assert.doesNotMatch(output, /docs\/mobile\/evidence/)
})

test('standalone result loader accepts regular files and rejects symlink escapes without echoing paths', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'ios-beta-result-loader-'))
  const outsideRoot = mkdtempSync(join(tmpdir(), 'ios-beta-result-outside-'))
  try {
    const regularPath = 'docs/mobile/evidence/ios-beta-release-readiness/2026-08-03/regular-run/results.json'
    const symlinkPath = 'docs/mobile/evidence/ios-beta-release-readiness/2026-08-03/symlink-run/results.json'
    const escapePath = 'docs/mobile/evidence/ios-beta-release-readiness/2026-08-03/escape-run/results.json'
    mkdirSync(dirname(join(temporaryRoot, regularPath)), { recursive: true })
    mkdirSync(dirname(join(temporaryRoot, symlinkPath)), { recursive: true })
    mkdirSync(dirname(dirname(join(temporaryRoot, escapePath))), { recursive: true })
    writeFileSync(join(temporaryRoot, regularPath), '{"safe":true}\n')
    const outsideFile = join(outsideRoot, 'results.json')
    writeFileSync(outsideFile, '{"outside":true}\n')
    symlinkSync(outsideFile, join(temporaryRoot, symlinkPath))
    symlinkSync(outsideRoot, dirname(join(temporaryRoot, escapePath)), 'dir')

    const loaded = loadIosBetaReleaseReadinessResultCopies(temporaryRoot, [regularPath, symlinkPath, escapePath])
    assert.equal(loaded.resultCopies[regularPath], '{"safe":true}\n')
    assert.equal(loaded.resultCopies[symlinkPath], undefined)
    assert.equal(loaded.resultCopies[escapePath], undefined)
    assert.equal(loaded.sourceViolations.length, 2)
    const output = loaded.sourceViolations.join('\n')
    assert.match(output, /iOS beta result copy 2 must be a readable regular non-symlink file inside the repository/)
    assert.match(output, /iOS beta result copy 3 must be a readable regular non-symlink file inside the repository/)
    assert.doesNotMatch(output, /symlink-run|escape-run|ios-beta-result-outside/)
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
    rmSync(outsideRoot, { recursive: true, force: true })
  }
})

test('rejects dot-segment and non-canonical restricted evidence references', async () => {
  const references = [
    'restricted://ios-beta-release-readiness/beta-run/check/../../outside',
    'restricted://ios-beta-release-readiness/beta-run/check/%2e%2e/outside',
    'restricted://ios-beta-release-readiness/beta-run/check//outside',
    'restricted://ios-beta-release-readiness/beta-run/check?scope=outside',
  ]
  for (const reference of references) {
    const value = await contract()
    const path = 'docs/mobile/evidence/ios-beta-release-readiness/2026-08-03/beta-run/results.json'
    const result = JSON.parse(completed())
    result.checks[0].restricted_evidence_reference = reference
    value.trackedFiles = [path]
    value.resultCopies = { [path]: JSON.stringify(result) }
    assert.match(inspectIosBetaReleaseReadiness(value).join('\n'), /must be a scoped restricted evidence reference/)
  }
})
