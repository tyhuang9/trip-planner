import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { inspectIosBetaReleaseReadiness } from './check-ios-beta-release-readiness.mjs'

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
  assert.match(output, /raw secret, capture, or artifact/)
  assert.match(output, /evidence path is unauthorized/)
})
