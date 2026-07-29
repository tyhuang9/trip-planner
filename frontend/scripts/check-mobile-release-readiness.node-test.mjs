import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { assertMobileReleaseReadiness, inspectMobileReleaseReadiness, loadMobileReleaseSources } from './check-mobile-release-readiness.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sources = () => loadMobileReleaseSources(root)
const messages = (candidate) => inspectMobileReleaseReadiness(candidate).join('\n')
const sourceFiles = ['docs/mobile/auth-session-device-evidence.catalog.json', 'docs/mobile/auth-session-device-evidence.template.json', 'docs/mobile/auth-session-device-spike.md', 'docs/mobile/auth-session-transport-adr-template.md']
const resultPath = 'docs/mobile/evidence/issue-64/2026-07-29/safe-run-1/results.json'

function completed() {
  const value = JSON.parse(sources().authSessionEvidenceTemplate)
  value.template_status = 'COMPLETED'
  value.notice = 'COMPLETED RESULTS / CLAIM-BEARING ARTIFACT'
  const fill = (item, key = '') => item === 'UNEXECUTED' ? (key === 'status' ? 'PASS' : key === 'artifact_identity_checksum' ? 'sha256:' + 'a'.repeat(64) : key === 'test_date_time' ? '2026-07-29T12:00:00Z' : 'restricted://issue-64/run-1') : Array.isArray(item) ? (key === 'result_status_vocabulary' ? item : item.map((x) => fill(x))) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([k, x]) => [k, fill(x, k)])) : item
  const result = fill(value)
  result.adr_contract.selected_outcome = 'cookie_only_proven'
  result.adr_contract.decision_artifact_reference = 'restricted://issue-64/safe-run-1/decision'
  let referenceId = 0
  for (const [platformIndex, platform] of result.platforms.entries()) {
    const checksum = 'sha256:' + (platformIndex === 0 ? 'a' : 'b').repeat(64)
    platform.metadata.device_type = platform.platform === 'ios' ? 'physical_iphone' : 'physical_android'
    platform.metadata.is_simulator = false
    platform.metadata.is_emulator = false
    platform.metadata.app_version = '1.2.3'
    platform.metadata.platform_build = platform.platform === 'ios' ? 'ios-101' : 'android-202'
    platform.metadata.artifact_identity_checksum = checksum
    platform.attestation = { platform: platform.platform, device_type: platform.metadata.device_type, safe_reference: `restricted://issue-64/safe-run-1/${platform.platform}/attestation`, artifact_identity_checksum: checksum, captured_at: platform.metadata.test_date_time }
    const setEvidence = (evidence, context) => { evidence.safe_reference = `restricted://issue-64/safe-run-1/${platform.platform}/${context}/artifact-${referenceId++}`; evidence.network_trace_reference = `restricted://issue-64/safe-run-1/${platform.platform}/${context}/trace-${referenceId++}`; evidence.artifact_identity_checksum = checksum }
    for (const context of platform.contexts) {
      for (const caseEntry of context.cases) { setEvidence(caseEntry.evidence, context.context_id); for (const boundary of caseEntry.session_boundaries ?? []) setEvidence(boundary.evidence, context.context_id) }
      for (const stage of context.credential_lifecycle) setEvidence(stage.evidence, context.context_id)
    }
    for (const caseEntry of platform.platform_cases) setEvidence(caseEntry.evidence, 'platform')
  }
  return result
}
function tracked(result = completed()) {
  const candidate = sources()
  candidate.trackedFiles = [...sourceFiles, resultPath]
  candidate.resultCopies = { [resultPath]: JSON.stringify(result) }
  return candidate
}
function trackedAt(runId, result = completed(), date = '2026-07-29') {
  const path = `docs/mobile/evidence/issue-64/${date}/${runId}/results.json`
  const candidate = sources()
  candidate.trackedFiles = [...sourceFiles, path]
  candidate.resultCopies = { [path]: JSON.stringify(result).replaceAll('safe-run-1', runId) }
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
  const candidate = sources(); const document = JSON.parse(candidate.authSessionEvidenceTemplate); document.platforms[0].contexts[0].cases[0].status = 'PASS'; delete document.redaction_policy.raw_capture_policy; document.adr_contract.allowed_outcomes.push('endpoint_only_fallback'); candidate.authSessionEvidenceTemplate = JSON.stringify(document); const output = messages(candidate); assert.match(output, /status must be PASS/); assert.match(output, /redaction policy must contain exactly/); assert.match(output, /ADR catalogs are invalid/)
})

test('rejects falsely completed source template status and evidence', () => {
  const candidate = sources(); const document = JSON.parse(candidate.authSessionEvidenceTemplate); document.template_status = 'PASS'; document.platforms[0].contexts[0].cases[0].evidence.safe_reference = 'restricted://issue-64/run-1'; candidate.authSessionEvidenceTemplate = JSON.stringify(document); const output = messages(candidate); assert.match(output, /template status must remain UNEXECUTED/); assert.match(output, /safe_reference must remain UNEXECUTED/)
})

test('rejects removal of raw-secret redaction policy', () => {
  const candidate = sources(); const document = JSON.parse(candidate.authSessionEvidenceTemplate); delete document.redaction_policy.raw_capture_policy; candidate.authSessionEvidenceTemplate = JSON.stringify(document); assert.match(messages(candidate), /redaction policy must contain exactly/)
})

test('rejects ADR option drift', () => {
  const candidate = sources(); const document = JSON.parse(candidate.authSessionEvidenceTemplate); document.adr_contract.allowed_outcomes.push('endpoint_only_fallback'); candidate.authSessionEvidenceTemplate = JSON.stringify(document); assert.match(messages(candidate), /ADR catalogs are invalid/)
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
    ['MAYBE', /status must be PASS/, (r) => { r.platforms[0].contexts[0].cases[0].status = 'MAYBE' }],
    ['bad reference', /safe_reference must be scoped/, (r) => { r.platforms[0].contexts[0].cases[0].evidence.safe_reference = 'https://x/?token=no' }],
    ['bad metadata', /test_date_time must be component-valid RFC3339/, (r) => { r.platforms[0].metadata.test_date_time = 'tomorrow' }],
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
  assert.match(messages(tracked(result)), /notice must exactly match/)
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

test('rejects schema v3 in the source template', () => {
  const candidate = sources(); const document = JSON.parse(candidate.authSessionEvidenceTemplate); document.schema_version = 3; candidate.authSessionEvidenceTemplate = JSON.stringify(document); assert.match(messages(candidate), /schema_version must be 2/)
})

test('rejects schema v3 in a completed result', () => {
  const result = completed(); result.schema_version = 3; assert.match(messages(tracked(result)), /schema_version must be 2/)
})

test('uses explicit context for offline boundaries regardless of member and guest path text', () => {
  assert.deepEqual(inspectMobileReleaseReadiness(trackedAt('member-guest-run')), [])
  const result = completed(); const ios = result.platforms[0]; const memberBoundaries = ios.contexts[0].cases.find((x) => x.case_id === 'offline_loss_reconnect_each_session_boundary').session_boundaries; ios.contexts[1].cases.find((x) => x.case_id === 'offline_loss_reconnect_each_session_boundary').session_boundaries = memberBoundaries; assert.match(messages(trackedAt('member-run', result)), /guest offline_loss.*session boundaries must contain exactly/)
})

test('rejects missing, multiple, invalid, or forbidden ADR selections', () => {
  for (const mutate of [(r) => { delete r.adr_contract.selected_outcome }, (r) => { r.adr_contract.selected_outcome = ['cookie_only_proven', 'native_credential_transport'] }, (r) => { r.adr_contract.selected_outcome = 'anything' }, (r) => { r.adr_contract.selected_outcome = 'endpoint_only_fallback' }]) { const result = completed(); mutate(result); assert.match(messages(tracked(result)), /ADR/) }
})

test('rejects missing, mismatched, or unsafe ADR decision references', () => {
  for (const mutate of [(r) => { delete r.adr_contract.decision_artifact_reference }, (r) => { r.adr_contract.decision_artifact_reference = 'restricted://issue-64/other-run/decision' }, (r) => { r.adr_contract.decision_artifact_reference = 'https://example.test/decision?code=raw' }]) { const result = completed(); mutate(result); assert.match(messages(tracked(result)), /ADR|raw credential/) }
})

test('rejects Authorization Basic in completed procedural fields', () => {
  const result = completed(); result.platforms[0].contexts[0].cases[0].actions = 'Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ=='; assert.match(messages(tracked(result)), /raw credential/)
})

test('rejects raw password values in completed procedural fields', () => {
  const result = completed(); result.platforms[0].contexts[0].cases[0].preconditions = 'password=hunter2'; assert.match(messages(tracked(result)), /raw credential/)
})

test('rejects reset and verification URLs in completed procedural fields', () => {
  for (const url of ['https://example.test/reset/abc', 'https://example.test/verification/abc']) { const result = completed(); result.platforms[0].contexts[0].cases[0].actions = url; assert.match(messages(tracked(result)), /raw credential/) }
})

test('rejects query code secrets in completed procedural fields', () => {
  const result = completed(); result.platforms[0].contexts[0].cases[0].actions = 'https://example.test/callback?code=raw-code'; assert.match(messages(tracked(result)), /raw credential/)
})

test('rejects appended Markdown claims and raw credentials', () => {
  for (const appended of ['\nPASS\n', '\nAPPROVED\n', '\nDecision: endpoint_only_fallback\n', '\npassword=raw-secret\n']) { const candidate = sources(); candidate.authSessionAdrTemplate += appended; assert.match(messages(candidate), /canonical instruction-only document|raw credential/) }
})

test('rejects duplicate or conflicting policy markers', () => {
  const candidate = sources(); candidate.authSessionDeviceSpike += '\n<!-- issue64-spike-policy\ncontract_version=3\n-->\n'; candidate.releaseDocument += '\n<!-- issue64-release-policy\ncontract_version=3\n-->\n'; const output = messages(candidate); assert.match(output, /issue64-spike-policy marker must appear exactly once/); assert.match(output, /issue64-release-policy marker must appear exactly once/)
})

test('rejects nonexistent, timezone-free, and path-mismatched result timestamps', () => {
  for (const [timestamp, date, expected] of [['2026-02-30T12:00:00Z', '2026-02-28', /RFC3339|result path date/], ['2026-07-29T12:00:00', '2026-07-29', /RFC3339/], ['2026-07-28T12:00:00Z', '2026-07-29', /result path date/]]) { const result = completed(); for (const platform of result.platforms) { platform.metadata.test_date_time = timestamp; platform.attestation.captured_at = timestamp }; assert.match(messages(trackedAt('timestamp-run', result, date)), expected) }
})

test('rejects empty tracked input and untracked or unauthorized result copies', () => {
  assert.throws(() => assertMobileReleaseReadiness(root, []), /tracked-file input must not be empty/)
  const candidate = sources(); candidate.resultCopies = { [resultPath]: JSON.stringify(completed()), 'docs/mobile/evidence/issue-64/raw.json': '{}' }; const output = messages(candidate); assert.match(output, /result copy must be tracked/)
})

test('rejects missing and contradictory physical-device attestations', () => {
  for (const mutate of [(r) => { delete r.platforms[0].attestation }, (r) => { r.platforms[0].attestation.platform = 'android' }, (r) => { r.platforms[0].attestation.device_type = 'physical_android' }]) { const result = completed(); mutate(result); assert.match(messages(tracked(result)), /attestation/) }
})

test('rejects simulator or emulator wording in completed device metadata', () => {
  const result = completed(); result.platforms[0].metadata.device_model = 'iPhone Simulator'; result.platforms[1].metadata.tooling = 'Android Emulator'; assert.match(messages(tracked(result)), /must not describe a simulator or emulator/)
})

test('rejects reused references and cloned cross-platform evidence', () => {
  const reused = completed(); reused.platforms[0].contexts[1].cases[0].evidence.safe_reference = reused.platforms[0].contexts[0].cases[0].evidence.safe_reference; assert.match(messages(tracked(reused)), /must not reuse|must be scoped/)
  const cloned = completed(); cloned.platforms[1].contexts[0].cases[0].evidence = structuredClone(cloned.platforms[0].contexts[0].cases[0].evidence); assert.match(messages(tracked(cloned)), /must be scoped|checksum must match/)
})

test('unrelated release violations do not suppress device-contract violations', () => {
  const candidate = sources(); candidate.workflow = candidate.workflow.replace("node-version: '22'", "node-version: '24'"); const document = JSON.parse(candidate.authSessionEvidenceTemplate); document.schema_version = 3; candidate.authSessionEvidenceTemplate = JSON.stringify(document); const output = messages(candidate); assert.match(output, /CI Node version/); assert.match(output, /schema_version must be 2/)
})

test('rejects an all-FAIL completed result with cookie-only selected', () => {
  const result = completed(); const fail = (value) => { if (Array.isArray(value)) value.forEach(fail); else if (value && typeof value === 'object') { for (const [key, child] of Object.entries(value)) { if (key === 'status') value[key] = 'FAIL'; else fail(child) } } }; fail(result.platforms); assert.match(messages(tracked(result)), /must be PASS for a selected ADR decision/)
})

test('rejects a non-PASS required case', () => {
  const result = completed(); result.platforms[0].contexts[0].cases[0].status = 'BLOCKED'; assert.match(messages(tracked(result)), /status must be PASS/)
})

test('rejects a non-PASS offline boundary', () => {
  const result = completed(); result.platforms[0].contexts[0].cases.find((x) => x.session_boundaries).session_boundaries[0].status = 'UNVERIFIED'; assert.match(messages(tracked(result)), /boundary status must be PASS/)
})

test('rejects a non-PASS credential lifecycle stage', () => {
  const result = completed(); result.platforms[1].contexts[1].credential_lifecycle[0].status = 'FAIL'; assert.match(messages(tracked(result)), /lifecycle stage status must be PASS/)
})

test('rejects a non-PASS platform case while accepting the all-PASS control', () => {
  assert.deepEqual(inspectMobileReleaseReadiness(tracked()), []); const result = completed(); result.platforms[1].platform_cases[0].status = 'BLOCKED'; assert.match(messages(tracked(result)), /platform case status must be PASS/)
})

test('rejects reset_token keyed values', () => {
  const result = completed(); result.platforms[0].contexts[0].cases[0].actions = 'reset_token=raw'; assert.match(messages(tracked(result)), /raw credential/)
})

test('rejects verification-code keyed values', () => {
  const result = completed(); result.platforms[0].contexts[0].cases[0].actions = 'verification-code: raw'; assert.match(messages(tracked(result)), /raw credential/)
})

test('rejects reset-token URL query values', () => {
  const result = completed(); result.platforms[0].contexts[0].cases[0].actions = 'https://example.test/callback?reset_token=raw'; assert.match(messages(tracked(result)), /raw credential/)
})

test('rejects X-API-Key headers without flagging safe policy prose', () => {
  assert.deepEqual(inspectMobileReleaseReadiness(sources()), []); const result = completed(); result.platforms[0].contexts[0].cases[0].actions = 'X-API-Key: raw-secret'; assert.match(messages(tracked(result)), /raw credential/)
})

test('rejects issue-64 approval claims outside the release gate table', () => {
  const candidate = sources(); candidate.releaseDocument += '\nAuthentication and guest sessions: PASS. Physical-device evidence APPROVED.\n'; assert.match(messages(candidate), /outside the canonical gate table/)
})

test('rejects duplicate toolchain and release-gate blocks', () => {
  const contract = sources().releaseDocument.match(/<!-- mobile-release-contract[\s\S]*?-->/)[0]; const gates = sources().releaseDocument.match(/<!-- mobile-release-gates:start -->[\s\S]*?<!-- mobile-release-gates:end -->/)[0]; const candidate = sources(); candidate.releaseDocument += `\n${contract}\n${gates}\n`; const output = messages(candidate); assert.match(output, /exactly one machine-readable toolchain contract/); assert.match(output, /exactly one release-gate table block/)
})

test('rejects RFC3339 24:00 rollover and accepts a valid timezone offset', () => {
  const invalid = completed(); for (const platform of invalid.platforms) { platform.metadata.test_date_time = '2026-07-29T24:00:00Z'; platform.attestation.captured_at = platform.metadata.test_date_time }; assert.match(messages(tracked(invalid)), /component-valid RFC3339/); const valid = completed(); for (const platform of valid.platforms) { platform.metadata.test_date_time = '2026-07-29T12:30:45-05:00'; platform.attestation.captured_at = platform.metadata.test_date_time }; assert.deepEqual(inspectMobileReleaseReadiness(tracked(valid)), [])
})

test('requires identical commit and semantic app version across platforms', () => {
  const commitMismatch = completed(); commitMismatch.platforms[1].metadata.commit_or_tag = 'different'; assert.match(messages(tracked(commitMismatch)), /same commit_or_tag/); const versionMismatch = completed(); versionMismatch.platforms[1].metadata.app_version = '1.2.4'; assert.match(messages(tracked(versionMismatch)), /same app_version/); const invalidVersion = completed(); for (const platform of invalidVersion.platforms) platform.metadata.app_version = 'release'; assert.match(messages(tracked(invalidVersion)), /semantic versioning/)
})

test('rejects simulator wording independently from emulator wording', () => {
  const simulator = completed(); simulator.platforms[0].metadata.device_model = 'iPhone Simulator'; assert.match(messages(tracked(simulator)), /must not describe a simulator/); const emulator = completed(); emulator.platforms[1].metadata.tooling = 'Android Emulator'; assert.match(messages(tracked(emulator)), /must not describe a simulator/)
})

test('rejects untracked and outside-path result copies independently', () => {
  const untracked = sources(); untracked.trackedFiles = sourceFiles; untracked.resultCopies = { [resultPath]: JSON.stringify(completed()) }; assert.match(messages(untracked), /result copy must be tracked/); const outside = sources(); outside.resultCopies = { 'docs/mobile/evidence/issue-64/raw.json': '{}' }; assert.match(messages(outside), /result copy must be tracked/)
})

test('rejects duplicate ADR markers independently', () => {
  const candidate = sources(); const block = candidate.authSessionAdrTemplate.match(/<!-- issue64-adr-policy[\s\S]*?-->/)[0]; candidate.authSessionAdrTemplate += `\n${block}\n`; assert.match(messages(candidate), /issue64-adr-policy marker must appear exactly once/)
})

test('rejects network-reference reuse independently', () => {
  const result = completed(); result.platforms[0].contexts[0].cases[1].evidence.network_trace_reference = result.platforms[0].contexts[0].cases[0].evidence.network_trace_reference; assert.match(messages(tracked(result)), /must not reuse an evidence reference/)
})
