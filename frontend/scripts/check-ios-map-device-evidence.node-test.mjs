import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { inspectIosMapDeviceEvidence } from './check-ios-map-device-evidence.mjs'

const root = resolve(import.meta.dirname, '../..')
const read = (path) => readFile(resolve(root, path), 'utf8')

async function sourceContract() {
  return {
    template: await read('docs/mobile/ios-map-device-evidence.template.json'),
    runbook: await read('docs/mobile/ios-map-device-spike.md'),
    adr: await read('docs/mobile/ios-map-renderer-adr-template.md'),
    release: await read('docs/mobile/release-readiness.md'),
    trackedFiles: [],
    resultCopies: {},
  }
}

function completedResult() {
  const gates = [
    'native_renderer_and_restricted_key', 'create_destroy_navigation', 'background_resume_force_relaunch_orientation',
    'camera_markers_polylines_and_place_selection', 'tabs_sheets_overlays_scrolling_and_gestures',
    'voiceover_and_failure_state_accessibility', 'memory_and_map_ready_timing', 'missing_rejected_key_and_network_failures',
  ].map((gateId) => ({ gate_id: gateId, status: 'PASS', evidence: `restricted://issue-66-ios/iphone-map-run/gates/${gateId}` }))
  return JSON.stringify({
    schema_version: 1,
    template_status: 'COMPLETED',
    notice: 'COMPLETED RESULTS / CLAIM-BEARING ARTIFACT',
    copy_results_to: 'docs/mobile/evidence/issue-66-ios/YYYY-MM-DD/<lowercase-run-id>/results.json',
    result_status_vocabulary: ['UNEXECUTED', 'PASS', 'FAIL', 'BLOCKED', 'UNVERIFIED'],
    platform: {
      name: 'ios', device_type: 'physical_iphone', is_simulator: false, commit_or_tag: 'v1.2.3', app_version: '1.2.3',
      platform_build: '42', device_model: 'iPhone', os_version: '18.0', tooling: 'Xcode', staging_environment: 'staging',
      tester_owner: '@owner', tested_at: '2026-08-03T12:00:00Z', artifact_identity_checksum: `sha256:${'a'.repeat(64)}`,
    },
    external_key_restriction: {
      status: 'PASS', restriction: 'iOS application restriction verified externally',
      safe_reference: 'restricted://issue-66-ios/iphone-map-run/key-restriction', redaction_notes: 'Restricted external evidence only.',
    },
    gates,
    adr_contract: {
      selected_renderer: 'native_google_maps_ios_qualified', follow_up_scope: 'none',
      decision_artifact_reference: 'restricted://issue-66-ios/iphone-map-run/decision',
      allowed_renderers: ['native_google_maps_ios_qualified', 'native_google_maps_ios_rejected'],
    },
    redaction_policy: 'Raw captures remain in restricted external storage.',
    references: { runbook: 'docs/mobile/ios-map-device-spike.md', adr: 'docs/mobile/ios-map-renderer-adr-template.md' },
  })
}

test('accepts the unexecuted iOS map evidence source contract', async () => {
  assert.deepEqual(inspectIosMapDeviceEvidence(await sourceContract()), [])
})

test('accepts a complete qualified physical-iPhone result', async () => {
  const contract = await sourceContract()
  const path = 'docs/mobile/evidence/issue-66-ios/2026-08-03/iphone-map-run/results.json'
  contract.trackedFiles = [path]
  contract.resultCopies = { [path]: completedResult() }
  assert.deepEqual(inspectIosMapDeviceEvidence(contract), [])
})

test('rejects raw Maps credentials, captures, and unauthorized paths', async () => {
  const contract = await sourceContract()
  const path = 'docs/mobile/evidence/issue-66-ios/2026-08-03/iphone-map-run/results.json'
  const result = JSON.parse(completedResult())
  result.leaked_api_key = 'not-a-real-map-key'
  result.external_key_restriction.redaction_notes = 'screenshot.png'
  contract.trackedFiles = [path, 'docs/mobile/evidence/issue-66-ios/bad.json']
  contract.resultCopies = { [path]: JSON.stringify(result) }
  const violations = inspectIosMapDeviceEvidence(contract)
  assert.ok(violations.some((entry) => /raw Maps credential or capture/.test(entry)))
  assert.ok(violations.some((entry) => /path is unauthorized/.test(entry)))
})

test('rejects qualification when an iOS map gate fails', async () => {
  const contract = await sourceContract()
  const path = 'docs/mobile/evidence/issue-66-ios/2026-08-03/iphone-map-run/results.json'
  const result = JSON.parse(completedResult())
  result.gates[0].status = 'FAIL'
  contract.trackedFiles = [path]
  contract.resultCopies = { [path]: JSON.stringify(result) }
  assert.ok(inspectIosMapDeviceEvidence(contract).some((entry) => /qualified iOS native Maps requires every gate/.test(entry)))
})
