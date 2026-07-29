import assert from 'node:assert/strict'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import {
  inspectMobileReleaseReadiness,
  loadMobileReleaseSources,
} from './check-mobile-release-readiness.mjs'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function sources() {
  return loadMobileReleaseSources(repositoryRoot)
}

function messages(candidate) {
  return inspectMobileReleaseReadiness(candidate).join('\n')
}

function mutateEvidenceTemplate(candidate, mutate) {
  const document = JSON.parse(candidate.authSessionEvidenceTemplate)
  mutate(document)
  candidate.authSessionEvidenceTemplate = JSON.stringify(document)
}

test('accepts the repository-backed release-readiness contract', () => {
  assert.deepEqual(inspectMobileReleaseReadiness(sources()), [])
})

test('rejects native identifier and version drift', () => {
  const candidate = sources()
  candidate.androidAppBuild = candidate.androidAppBuild
    .replace('applicationId "io.github.tyhuang9.dupert"', 'applicationId "io.github.tyhuang9.other"')
    .replace('versionName "1.0"', 'versionName "1.1"')

  const result = messages(candidate)
  assert.match(result, /Android applicationId must match Capacitor appId/)
  assert.match(result, /Android and iOS marketing versions must agree/)
})

test('rejects an unsafe production backend origin', () => {
  const candidate = sources()
  candidate.nativeProductionEnvironment = 'VITE_BACKEND_API_URL=http://localhost:8000?token=unsafe\n'

  const result = messages(candidate)
  assert.match(result, /must use HTTPS/)
  assert.match(result, /must not include credentials, query, or fragment data/)
  assert.match(result, /must be a deployed non-placeholder origin/)
})

test('rejects tracked signing and provisioning material', () => {
  const candidate = sources()
  candidate.trackedFiles = [...candidate.trackedFiles, 'frontend/android/app/release.keystore', 'frontend/ios/App/App.mobileprovision']

  const result = messages(candidate)
  assert.match(result, /release\.keystore/)
  assert.match(result, /App\.mobileprovision/)
})

test('rejects incomplete checklist evidence schema', () => {
  const candidate = sources()
  candidate.releaseDocument = candidate.releaseDocument
    .replace(/^\| Monitoring and ownership \|.*\n/m, '')
    .replace('| Repository contract | PASS | Engineering |', '| Repository contract | PASS | Unassigned |')

  const result = messages(candidate)
  assert.match(result, /release gate is missing: Monitoring and ownership/)
  assert.match(result, /Repository contract cannot pass without an accountable owner/)
})

test('rejects inconsistent CI pins and duplicate release gates', () => {
  const candidate = sources()
  candidate.workflow = candidate.workflow.replace("node-version: '22'", "node-version: '24'")
  candidate.releaseDocument = candidate.releaseDocument.replace(
    '| Artifact provenance | BLOCKED |',
    '| Repository contract | BLOCKED | Unassigned | Duplicate row |\n| Artifact provenance | BLOCKED |',
  )

  const result = messages(candidate)
  assert.match(result, /CI Node version must be present and consistent across jobs/)
  assert.match(result, /release-gate table must not repeat gate names/)
})

test('rejects a missing physical platform entry', () => {
  const candidate = sources()
  mutateEvidenceTemplate(candidate, (document) => {
    document.platforms = document.platforms.filter(({ platform }) => platform !== 'android')
  })

  assert.match(messages(candidate), /device evidence platform is missing: android/)
})

test('rejects missing device metadata and case identifiers', () => {
  const candidate = sources()
  mutateEvidenceTemplate(candidate, (document) => {
    delete document.metadata.device_model
    document.cases = document.cases.filter(({ case_id }) => case_id !== 'guest_claim')
  })

  const result = messages(candidate)
  assert.match(result, /device evidence metadata is missing: device_model/)
  assert.match(result, /device evidence case is missing: guest_claim/)
})

test('rejects missing credential lifecycle stage and evidence field', () => {
  const candidate = sources()
  mutateEvidenceTemplate(candidate, (document) => {
    document.credential_lifecycle = document.credential_lifecycle.filter(({ stage_id }) => stage_id !== 'claimed')
    delete document.cases.find(({ case_id }) => case_id === 'trip_write').evidence.safe_reference
  })

  const result = messages(candidate)
  assert.match(result, /credential lifecycle stage is missing: claimed/)
  assert.match(result, /trip_write is missing evidence field: safe_reference/)
})

test('rejects falsely completed status and evidence values', () => {
  const candidate = sources()
  mutateEvidenceTemplate(candidate, (document) => {
    document.template_status = 'PASS'
    document.cases[0].evidence.safe_reference = 'artifacts/run-1.json'
  })

  const result = messages(candidate)
  assert.match(result, /device evidence template status must remain UNEXECUTED/)
  assert.match(result, /member_login safe_reference must remain UNEXECUTED/)
})

test('rejects removal of the raw-secret redaction policy', () => {
  const candidate = sources()
  mutateEvidenceTemplate(candidate, (document) => {
    delete document.redaction_policy.raw_secret_policy
  })

  assert.match(messages(candidate), /credential redaction policy must prohibit committing raw secrets/)
})

test('rejects ADR option drift', () => {
  const candidate = sources()
  mutateEvidenceTemplate(candidate, (document) => {
    document.adr_contract.allowed_outcomes.push({ option_id: 'endpoint_only_fallback', scope: 'UNEXECUTED' })
  })

  assert.match(messages(candidate), /ADR must allow exactly the two approved outcomes/)
})

test('rejects an issue #64 gate becoming PASS', () => {
  const candidate = sources()
  candidate.releaseDocument = candidate.releaseDocument.replace(
    '| Authentication and guest sessions | BLOCKED |',
    '| Authentication and guest sessions | PASS |',
  )

  assert.match(messages(candidate), /Authentication and guest sessions must remain BLOCKED/)
})
