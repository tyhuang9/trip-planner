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

function platform(document, name) {
  return document.platforms.find((entry) => entry.platform === name)
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

test('rejects missing iOS and Android platform entries', () => {
  const candidate = sources()
  mutateEvidenceTemplate(candidate, (document) => {
    document.platforms = document.platforms.filter(({ platform }) => platform !== 'ios')
  })
  assert.match(messages(candidate), /device evidence platform is missing: ios/)

  const androidCandidate = sources()
  mutateEvidenceTemplate(androidCandidate, (document) => {
    document.platforms = document.platforms.filter(({ platform }) => platform !== 'android')
  })
  assert.match(messages(androidCandidate), /device evidence platform is missing: android/)
})

test('rejects missing platform-scoped metadata and a case on only one platform', () => {
  const candidate = sources()
  mutateEvidenceTemplate(candidate, (document) => {
    delete platform(document, 'ios').metadata.device_model
    platform(document, 'android').cases = platform(document, 'android').cases
      .filter(({ case_id }) => case_id !== 'guest_claim')
  })

  const result = messages(candidate)
  assert.match(result, /ios device metadata must contain exactly:.*device_model/)
  assert.match(result, /android device evidence case is missing: guest_claim/)
})

test('requires distinct iOS and Android case structures', () => {
  const candidate = sources()
  mutateEvidenceTemplate(candidate, (document) => {
    platform(document, 'ios').cases[0].shared_result = platform(document, 'android').cases[0]
  })

  assert.match(messages(candidate), /ios device evidence case member_login must contain exactly/)
})

test('rejects dated-copy workflow drift', () => {
  const candidate = sources()
  mutateEvidenceTemplate(candidate, (document) => {
    document.copy_results_to = 'docs/mobile/evidence/results.json'
  })
  candidate.authSessionDeviceSpike = candidate.authSessionDeviceSpike
    .replace('Edit only that dated copy', 'Edit the tracked template')

  const result = messages(candidate)
  assert.match(result, /must require the dated issue #64 results\.json copy path/)
  assert.match(result, /must require the immutable template and dated-copy-only workflow/)
})

test('rejects missing offline boundary, lifecycle stage, and evidence field on one platform', () => {
  const candidate = sources()
  mutateEvidenceTemplate(candidate, (document) => {
    const android = platform(document, 'android')
    android.credential_lifecycle = android.credential_lifecycle.filter(({ stage_id }) => stage_id !== 'claimed')
    delete platform(document, 'ios').cases.find(({ case_id }) => case_id === 'trip_write').evidence.safe_reference
    android.cases.find(({ case_id }) => case_id === 'offline_loss_reconnect_each_session_boundary')
      .session_boundaries = android.cases.find(({ case_id }) => case_id === 'offline_loss_reconnect_each_session_boundary')
        .session_boundaries.filter(({ boundary }) => boundary !== 'sse_streaming')
  })

  const result = messages(candidate)
  assert.match(result, /android credential lifecycle stage is missing: claimed/)
  assert.match(result, /ios device evidence case trip_write evidence must contain exactly/)
  assert.match(result, /android offline session-boundary evidence is missing: sse_streaming/)
})

test('rejects falsely completed status and evidence values', () => {
  const candidate = sources()
  mutateEvidenceTemplate(candidate, (document) => {
    document.template_status = 'PASS'
    platform(document, 'ios').cases[0].evidence.safe_reference = 'artifacts/run-1.json'
  })

  const result = messages(candidate)
  assert.match(result, /device evidence template status must remain UNEXECUTED/)
  assert.match(result, /ios device evidence case member_login evidence safe_reference must remain UNEXECUTED/)
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

test('rejects either issue #64 gate moving away from BLOCKED', () => {
  const candidate = sources()
  candidate.releaseDocument = candidate.releaseDocument.replace(
    '| Authentication and guest sessions | BLOCKED |',
    '| Authentication and guest sessions | PASS |',
  )

  assert.match(messages(candidate), /Authentication and guest sessions must remain BLOCKED/)

  const smokeCandidate = sources()
  smokeCandidate.releaseDocument = smokeCandidate.releaseDocument.replace(
    '| Device install smoke | BLOCKED |',
    '| Device install smoke | UNVERIFIED |',
  )
  assert.match(messages(smokeCandidate), /Device install smoke must remain BLOCKED/)
})
