import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { inspectMobileReleaseReadiness, loadMobileReleaseSources } from './check-mobile-release-readiness.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sources = () => loadMobileReleaseSources(root)
const messages = (candidate) => inspectMobileReleaseReadiness(candidate).join('\n')
const sourceFiles = ['docs/mobile/auth-session-device-evidence.template.json', 'docs/mobile/auth-session-device-spike.md', 'docs/mobile/auth-session-transport-adr-template.md']
const resultPath = 'docs/mobile/evidence/issue-64/2026-07-29/safe-run-1/results.json'

function completed() {
  const value = JSON.parse(sources().authSessionEvidenceTemplate)
  value.template_status = 'COMPLETED'
  value.notice = 'COMPLETED RESULTS / CLAIM-BEARING ARTIFACT'
  const fill = (item, key = '') => item === 'UNEXECUTED' ? (key === 'status' ? 'PASS' : key === 'artifact_identity_checksum' ? 'sha256:' + 'a'.repeat(64) : key === 'test_date_time' ? '2026-07-29T12:00:00Z' : 'restricted://issue-64/run-1') : Array.isArray(item) ? (key === 'result_status_vocabulary' ? item : item.map((x) => fill(x))) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([k, x]) => [k, fill(x, k)])) : item
  const result = fill(value)
  for (const platform of result.platforms) { platform.metadata.device_type = platform.platform === 'ios' ? 'physical_iphone' : 'physical_android'; platform.metadata.is_simulator = false; platform.metadata.is_emulator = false }
  return result
}
function tracked(result = completed()) {
  const candidate = sources()
  candidate.trackedFiles = [...sourceFiles, resultPath]
  candidate.resultCopies = { [resultPath]: JSON.stringify(result) }
  return candidate
}

test('accepts source contract and safe completed result', () => {
  assert.deepEqual(inspectMobileReleaseReadiness(sources()), [])
  assert.deepEqual(inspectMobileReleaseReadiness(tracked()), [])
})

test('rejects native identifier and version drift', () => {
  const candidate = sources()
  candidate.androidAppBuild = candidate.androidAppBuild.replace('applicationId "io.github.tyhuang9.dupert"', 'applicationId "io.github.tyhuang9.other"').replace('versionName "1.0"', 'versionName "1.1"')
  const output = messages(candidate)
  assert.match(output, /Android applicationId must match Capacitor appId/)
  assert.match(output, /Android and iOS marketing versions must agree/)
})

test('rejects unsafe production backend origin', () => {
  const candidate = sources()
  candidate.nativeProductionEnvironment = 'VITE_BACKEND_API_URL=http://localhost:8000?token=unsafe\n'
  const output = messages(candidate)
  assert.match(output, /must use HTTPS/)
  assert.match(output, /must not include credentials, query, or fragment data/)
})

test('rejects tracked signing and provisioning material', () => {
  const candidate = sources()
  candidate.trackedFiles = ['frontend/android/app/release.keystore', 'frontend/ios/App/App.mobileprovision']
  assert.match(messages(candidate), /release\.keystore/)
})

test('rejects missing and duplicate release gates', () => {
  const candidate = sources()
  candidate.releaseDocument = candidate.releaseDocument.replace(/^\| Monitoring and ownership \|.*\n/m, '').replace('| Artifact provenance | BLOCKED |', '| Repository contract | BLOCKED | Unassigned | duplicate |\n| Artifact provenance | BLOCKED |')
  const output = messages(candidate)
  assert.match(output, /release gate is missing: Monitoring and ownership/)
  assert.match(output, /must not repeat gate names/)
})

test('rejects CI pin drift', () => {
  const candidate = sources()
  candidate.workflow = candidate.workflow.replace("node-version: '22'", "node-version: '24'")
  assert.match(messages(candidate), /CI Node version must be present and consistent/)
})

test('keeps both issue 64 release gates blocked', () => {
  for (const gate of ['Authentication and guest sessions', 'Device install smoke']) {
    const candidate = sources()
    candidate.releaseDocument = candidate.releaseDocument.replace(`| ${gate} | BLOCKED |`, `| ${gate} | PASS |`)
    assert.match(messages(candidate), new RegExp(`${gate} must remain BLOCKED`))
  }
})

test('rejects missing iOS and Android platform entries', () => {
  for (const name of ['ios', 'android']) { const candidate = sources(); const document = JSON.parse(candidate.authSessionEvidenceTemplate); document.platforms = document.platforms.filter((x) => x.platform !== name); candidate.authSessionEvidenceTemplate = JSON.stringify(document); assert.match(messages(candidate), /platforms must contain exactly/) }
})

test('rejects missing platform metadata and context cases', () => {
  const candidate = sources(); const document = JSON.parse(candidate.authSessionEvidenceTemplate); delete document.platforms[0].metadata.device_model; document.platforms[1].contexts[1].cases.pop(); candidate.authSessionEvidenceTemplate = JSON.stringify(document); const output = messages(candidate); assert.match(output, /metadata must contain exactly/); assert.match(output, /guest cases must contain exactly/)
})

test('requires distinct platform and context structures', () => {
  const candidate = sources(); const document = JSON.parse(candidate.authSessionEvidenceTemplate); document.platforms[0].contexts[1].cases = document.platforms[0].contexts[0].cases; candidate.authSessionEvidenceTemplate = JSON.stringify(document); assert.match(messages(candidate), /ios guest cases must contain exactly/)
})

test('rejects dated-copy workflow drift', () => {
  const candidate = sources(); const document = JSON.parse(candidate.authSessionEvidenceTemplate); document.copy_results_to = 'docs/mobile/evidence/results.json'; candidate.authSessionEvidenceTemplate = JSON.stringify(document); assert.match(messages(candidate), /copy_results_to is invalid/)
})

test('rejects missing boundary, lifecycle stage, and evidence field', () => {
  const candidate = sources(); const document = JSON.parse(candidate.authSessionEvidenceTemplate); const member = document.platforms[0].contexts[0]; member.credential_lifecycle.pop(); member.cases.find((x) => x.case_id === 'offline_loss_reconnect_each_session_boundary').session_boundaries.pop(); delete member.cases[0].evidence.safe_reference; candidate.authSessionEvidenceTemplate = JSON.stringify(document); const output = messages(candidate); assert.match(output, /lifecycle must contain exactly/); assert.match(output, /session boundaries must contain exactly/); assert.match(output, /evidence must contain exactly/)
})

test('rejects source template claims and redaction or ADR drift', () => {
  const candidate = sources(); const document = JSON.parse(candidate.authSessionEvidenceTemplate); document.platforms[0].contexts[0].cases[0].status = 'PASS'; delete document.redaction_policy.raw_capture_policy; document.adr_contract.allowed_outcomes.push('endpoint_only_fallback'); candidate.authSessionEvidenceTemplate = JSON.stringify(document); const output = messages(candidate); assert.match(output, /status is invalid/); assert.match(output, /redaction policy must contain exactly/); assert.match(output, /ADR contract is invalid/)
})

test('rejects falsely completed source template status and evidence', () => {
  const candidate = sources(); const document = JSON.parse(candidate.authSessionEvidenceTemplate); document.template_status = 'PASS'; document.platforms[0].contexts[0].cases[0].evidence.safe_reference = 'restricted://issue-64/run-1'; candidate.authSessionEvidenceTemplate = JSON.stringify(document); const output = messages(candidate); assert.match(output, /template status must remain UNEXECUTED/); assert.match(output, /safe_reference must remain UNEXECUTED/)
})

test('rejects removal of raw-secret redaction policy', () => {
  const candidate = sources(); const document = JSON.parse(candidate.authSessionEvidenceTemplate); delete document.redaction_policy.raw_capture_policy; candidate.authSessionEvidenceTemplate = JSON.stringify(document); assert.match(messages(candidate), /redaction policy must contain exactly/)
})

test('rejects ADR option drift', () => {
  const candidate = sources(); const document = JSON.parse(candidate.authSessionEvidenceTemplate); document.adr_contract.allowed_outcomes.push('endpoint_only_fallback'); candidate.authSessionEvidenceTemplate = JSON.stringify(document); assert.match(messages(candidate), /ADR contract is invalid/)
})

test('rejects session collapse, raw evidence, invalid device and unknown keys', () => {
  const result = completed()
  const ios = result.platforms[0]
  ios.contexts[1].cases = ios.contexts[0].cases
  ios.metadata.is_simulator = true
  ios.contexts[0].cases[0].evidence.safe_reference = 'Authorization: Bearer secret'
  ios.contexts[0].cases[0].evidence.extra = 'hidden'
  const output = messages(tracked(result))
  assert.match(output, /guest cases must contain exactly/)
  assert.match(output, /must record a physical device/)
  assert.match(output, /contains a raw credential/)
  assert.match(output, /must contain exactly/)
})

test('rejects completed-result status, metadata, references, and procedural secrets independently', () => {
  const cases = [
    ['MAYBE', /status is invalid/, (r) => { r.platforms[0].contexts[0].cases[0].status = 'MAYBE' }],
    ['bad reference', /safe_reference must be a restricted/, (r) => { r.platforms[0].contexts[0].cases[0].evidence.safe_reference = 'https://x/?token=no' }],
    ['bad metadata', /test_date_time must be an ISO timestamp/, (r) => { r.platforms[0].metadata.test_date_time = 'tomorrow' }],
    ['bad checksum', /metadata artifact_identity_checksum must be sha256/, (r) => { r.platforms[0].metadata.artifact_identity_checksum = 'bad' }],
    ['procedural Bearer', /contains a raw credential/, (r) => { r.platforms[0].contexts[0].cases[0].actions = 'Bearer abcdefghijklmnopqrstuvwxyz' }],
  ]
  for (const [, expected, mutate] of cases) { const result = completed(); mutate(result); assert.match(messages(tracked(result)), expected) }
})

test('rejects missing result copy and completed template notice drift', () => {
  const candidate = sources()
  candidate.trackedFiles = [...sourceFiles, resultPath]
  candidate.resultCopies = {}
  assert.match(messages(candidate), /could not be safely read/)
  const result = completed()
  result.notice = 'TEMPLATE / NOT EVIDENCE'
  assert.match(messages(tracked(result)), /notice must be the completed-results marker/)
})

test('rejects untracked templates, invalid paths, marker drift, extra gates, and malformed headers', () => {
  const candidate = tracked()
  candidate.trackedFiles = [resultPath, 'docs/mobile/evidence/issue-64/2026-02-30/Bad/results.json', 'docs/mobile/evidence/issue-64/raw.json']
  candidate.authSessionDeviceSpike = candidate.authSessionDeviceSpike.replace('results_json_only', 'markdown')
  candidate.authSessionAdrTemplate = candidate.authSessionAdrTemplate.replace('cookie_only_proven,native_credential_transport', 'anything')
  candidate.releaseDocument = candidate.releaseDocument.replace('| Gate | Status | Owner | Evidence |', '| bad |').replace('<!-- mobile-release-gates:end -->', '| Extra | BLOCKED | Unassigned | none |\n<!-- mobile-release-gates:end -->')
  const output = messages(candidate)
  assert.match(output, /immutable issue #64 source must be tracked/)
  assert.match(output, /unauthorized/)
  assert.match(output, /unauthorized/)
  assert.match(output, /issue64-spike-policy marker/)
  assert.match(output, /issue64-adr-policy marker/)
  assert.match(output, /release-gate table must use/)
})
