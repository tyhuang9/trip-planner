import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REQUIRED_GATES = ['Repository contract', 'Artifact provenance', 'Signing and secrets', 'Identity and versioning', 'Production configuration', 'Authentication and guest sessions', 'Maps', 'Universal/App Links', 'Privacy and store metadata', 'Device install smoke', 'Backward compatibility and rollback', 'Monitoring and ownership']
const ALLOWED_GATE_STATUSES = new Set(['PASS', 'BLOCKED', 'UNVERIFIED', 'FAIL'])
const FORBIDDEN_TRACKED_RELEASE_FILES = /(?:^|\/)(?:[^/]+\.(?:jks|keystore|p12|p8|pfx|pem|key|cer|crt|mobileprovision|provisionprofile)|keystore\.properties)$/i
const RESULT_PATH = /^docs\/mobile\/evidence\/issue-64\/(\d{4}-\d{2}-\d{2})\/([a-z0-9]+(?:-[a-z0-9]+)*)\/results\.json$/
const RESULT_SHAPE = /^docs\/mobile\/evidence\/issue-64\/([^/]+)\/([^/]+)\/results\.json$/
const IOS_BETA_RESULT_PATH = /^docs\/mobile\/evidence\/issue-64-ios\/(\d{4}-\d{2}-\d{2})\/([a-z0-9]+(?:-[a-z0-9]+)*)\/results\.json$/
const IOS_BETA_RESULT_SHAPE = /^docs\/mobile\/evidence\/issue-64-ios\/([^/]+)\/([^/]+)\/results\.json$/
const REQUIRED_SOURCE_FILES = ['docs/mobile/auth-session-device-evidence.catalog.json', 'docs/mobile/auth-session-device-evidence.template.json', 'docs/mobile/auth-session-device-spike.md', 'docs/mobile/auth-session-transport-adr-template.md']
const REQUIRED_IOS_BETA_SOURCE_FILES = ['docs/mobile/ios-beta-auth-session-evidence.catalog.json', 'docs/mobile/ios-beta-auth-session-device-evidence.template.json', 'docs/mobile/ios-beta-auth-session-device-spike.md', 'docs/mobile/ios-beta-auth-session-transport-adr-template.md']
const EVIDENCE_KEYS = ['safe_reference', 'observed_result', 'network_trace_reference', 'artifact_identity_checksum', 'redaction_notes']
const CASE_KEYS = ['case_id', 'preconditions', 'actions', 'expected_outcome', 'cleanup', 'status', 'evidence']
const ADR_TEXT_FIELDS = ['security_properties', 'migration_compatibility', 'revised_estimate']
const ADR_WORK_FIELDS = ['frontend_work', 'backend_work']
const ADR_ACCEPTANCE_FIELDS = ['selected_outcome', 'decision_artifact_reference', 'security_properties', ...ADR_WORK_FIELDS, 'migration_compatibility', 'revised_estimate', 'follow_up_issue_references']
const ADR_CONTRACT_KEYS = [...ADR_ACCEPTANCE_FIELDS, 'allowed_outcomes', 'fallback_outcomes', 'forbidden_fallbacks']
const FOLLOW_UP_ISSUE_REFERENCE = /^https:\/\/github\.com\/tyhuang9\/dupert\/issues\/([1-9]\d*)$/
const NO_FALLBACK_WORK = 'NO_FALLBACK_WORK'
const ADR_WORK_REQUIREMENTS = {
  cookie_only_proven: {
    frontend: { classification: 'no_fallback_work', scope_ids: [] },
    backend: { classification: 'no_fallback_work', scope_ids: [] },
  },
  native_credential_transport: {
    frontend: {
      classification: 'explicit_native_transport_work',
      scope_ids: ['member_credential_storage', 'guest_credential_storage', 'member_and_guest_request_attachment', 'refresh_rotation_and_session_boundaries', 'verification_and_password_reset_returns', 'rest_and_sse_transport'],
    },
    backend: {
      classification: 'explicit_native_transport_work',
      scope_ids: ['member_credential_issue_rotate_revoke', 'guest_credential_issue_claim_revoke', 'login_verification_logout_deletion', 'guest_acceptance_expiry_revocation', 'rest_and_sse_authentication', 'migration_and_web_compatibility'],
    },
  },
}
const RAW_SECRET = /(?:authorization\s*[:=]\s*(?:bearer|basic)|x[-_]api[-_]key\s*[:=]|\bbearer\s+[a-z0-9._-]{20,}|\bbasic\s+[a-z0-9+/=]{12,}|\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]+\.|(?:access|refresh|guest|reset)[_-]?token\s*[:=]|verification[-_]code\s*[:=]|api[-_]?key\s*[:=]|(?:set-)?cookie\s*[:=]|password\s*[:=]\s*[^\s"']+|https?:\/\/[^\s"']+\/(?:reset|verify|verification)[^\s"']*|[?&](?:token|secret|api[-_]?key|password|code|reset[-_]?token|verification[-_]?code)=)/i
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const IMMUTABLE_DOCUMENT_HASHES = {
  'auth-session-device-spike.md': '340242b7c9ef8c1407ddecab95a07a1469762951b838deaf93ddb99491755969',
  'auth-session-transport-adr-template.md': '023fec092f7b2275828ddb1745c42ace63df39464a2add045ceee725be5cbe17',
  'ios-beta-auth-session-device-spike.md': '34a284302e2803e7190c7ec9fc84613826eb782538021429edea42e6d85d3896',
  'ios-beta-auth-session-transport-adr-template.md': '9fd0ba015f64a477b23864b1072da0a21fa0196a84a9f25dcb28a1717bc7ba4e',
}
const SHARED_CROSS_PLATFORM_EVIDENCE_CONTRACT = {
  schemaVersion: 4,
  releaseTrack: 'shared_cross_platform',
  qualification: 'final_cross_platform_qualification',
  evidenceReferenceScope: 'issue-64',
  copyResultsTo: 'docs/mobile/evidence/issue-64/YYYY-MM-DD/<lowercase-run-id>/results.json',
  platformSpecs: [['ios', 'physical_iphone', 'ios_webview_domain_configuration'], ['android', 'physical_android', 'android_third_party_cookie_behavior']],
  references: {
    catalog: 'docs/mobile/auth-session-device-evidence.catalog.json',
    spike: 'docs/mobile/auth-session-device-spike.md',
    adr: 'docs/mobile/auth-session-transport-adr-template.md',
  },
}
const IOS_BETA_EVIDENCE_CONTRACT = {
  schemaVersion: 4,
  releaseTrack: 'ios_beta',
  qualification: 'provisional_ios_implementation',
  evidenceReferenceScope: 'issue-64-ios',
  copyResultsTo: 'docs/mobile/evidence/issue-64-ios/YYYY-MM-DD/<lowercase-run-id>/results.json',
  platformSpecs: [['ios', 'physical_iphone', 'ios_webview_domain_configuration']],
  references: {
    catalog: 'docs/mobile/ios-beta-auth-session-evidence.catalog.json',
    spike: 'docs/mobile/ios-beta-auth-session-device-spike.md',
    adr: 'docs/mobile/ios-beta-auth-session-transport-adr-template.md',
  },
}

function capture(text, pattern, label, violations) { const match = text.match(pattern); if (!match) { violations.push(`${label} is missing`); return null }; return match[1] }
function uniqueCaptures(text, pattern) { return [...new Set([...text.matchAll(pattern)].map((match) => match[1]))] }
function parseJsonDocument(raw, label, violations) { try { return JSON.parse(raw) } catch { violations.push(`${label} must be valid JSON`); return null } }
function requireObject(value, label, violations) { if (!value || typeof value !== 'object' || Array.isArray(value)) { violations.push(`${label} must be an object`); return false }; return true }
function requireExactKeys(value, keys, label, violations) { if (!requireObject(value, label, violations)) return false; const actual = Object.keys(value).sort(); const expected = [...keys].sort(); if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) { violations.push(`${label} must contain exactly: ${expected.join(', ')}`); return false }; return true }
function exactIds(entries, key, expected, label, violations) { const ids = entries.map((x) => x?.[key]); if (new Set(ids).size !== ids.length) violations.push(`${label} must not repeat ${key}s`); if (ids.length !== expected.length || ids.some((id) => !expected.includes(id))) violations.push(`${label} must contain exactly: ${expected.join(', ')}`) }
function marker(document, name, expected, violations) { const blocks = [...document.matchAll(new RegExp(`<!-- ${name}\\n([\\s\\S]*?)\\n-->`, 'g'))]; if (blocks.length !== 1) { violations.push(`${name} marker must appear exactly once`); return }; const pairs = new Map(); for (const line of blocks[0][1].split('\n').filter(Boolean)) { const [key, ...values] = line.split('='); if (!key || !values.length || pairs.has(key)) violations.push(`${name} marker is malformed`); else pairs.set(key, values.join('=')) }; for (const [key, value] of Object.entries(expected)) if (pairs.get(key) !== value) violations.push(`${name} marker ${key} must equal ${value}`); if (pairs.size !== Object.keys(expected).length) violations.push(`${name} marker must not contain unknown fields`) }
function isCalendarDate(value) { const date = new Date(`${value}T00:00:00Z`); return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value }
function isRfc3339(value) { const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value ?? ''); return Boolean(match && isCalendarDate(match[1]) && Number(match[2]) <= 23 && Number(match[3]) <= 59 && Number(match[4]) <= 59 && (!match[6] || (Number(match[6]) <= 23 && Number(match[7]) <= 59))) }

function inspectCatalog(catalog, contract, violations) {
  const violationCount = violations.length
  if (!requireExactKeys(catalog, ['schema_version', 'release_track', 'qualification', 'platforms', 'contexts', 'adr'], 'device evidence catalog', violations)) return false
  if (catalog.schema_version !== contract.schemaVersion) violations.push(`device evidence catalog schema_version must be ${contract.schemaVersion}`)
  if (catalog.release_track !== contract.releaseTrack) violations.push(`device evidence catalog release_track must be ${contract.releaseTrack}`)
  if (catalog.qualification !== contract.qualification) violations.push(`device evidence catalog qualification must be ${contract.qualification}`)
  if (!requireExactKeys(catalog.platforms, contract.platformSpecs.map(([platform]) => platform), 'device evidence catalog platforms', violations)) return false
  if (!requireExactKeys(catalog.contexts, ['member', 'guest'], 'device evidence catalog contexts', violations)) return false
  for (const [platform, deviceType, platformCase] of contract.platformSpecs) {
    if (requireExactKeys(catalog.platforms[platform], ['device_type', 'platform_case'], `catalog ${platform}`, violations) && (catalog.platforms[platform].device_type !== deviceType || catalog.platforms[platform].platform_case !== platformCase)) violations.push(`catalog ${platform} semantics are invalid`)
  }
  for (const context of ['member', 'guest']) if (requireExactKeys(catalog.contexts[context], ['cases', 'credential_lifecycle'], `catalog ${context}`, violations)) {
    for (const key of ['cases', 'credential_lifecycle']) if (!Array.isArray(catalog.contexts[context][key]) || !catalog.contexts[context][key].length || new Set(catalog.contexts[context][key]).size !== catalog.contexts[context][key].length) violations.push(`catalog ${context} ${key} must be a nonempty unique array`)
  }
  if (!requireExactKeys(catalog.adr, ['allowed_outcomes', 'fallback_outcomes', 'forbidden_fallbacks', 'required_acceptance_fields', 'work_requirements'], 'catalog ADR', violations)) return false
  if (JSON.stringify(catalog.adr.allowed_outcomes) !== JSON.stringify(['cookie_only_proven', 'native_credential_transport'])
    || JSON.stringify(catalog.adr.fallback_outcomes) !== JSON.stringify(['native_credential_transport'])
    || JSON.stringify(catalog.adr.forbidden_fallbacks) !== JSON.stringify(['endpoint_only_fallback', 'web_storage_refresh_or_guest_token_workaround'])
    || JSON.stringify(catalog.adr.required_acceptance_fields) !== JSON.stringify(ADR_ACCEPTANCE_FIELDS)
    || JSON.stringify(catalog.adr.work_requirements) !== JSON.stringify(ADR_WORK_REQUIREMENTS)) violations.push('catalog ADR semantics are invalid')
  return violations.length === violationCount
}

function inspectEvidence(value, label, options, violations) {
  const { template, platform, context, runId, platformChecksum, usedReferences, evidenceReferenceScope } = options
  if (!template && RAW_SECRET.test(JSON.stringify(value))) violations.push(`${label} contains a raw credential or capture`)
  if (!requireExactKeys(value, EVIDENCE_KEYS, label, violations)) return
  if (template) {
    for (const key of EVIDENCE_KEYS) if (value[key] !== 'UNEXECUTED') violations.push(`${label} ${key} must remain UNEXECUTED`)
    return
  }
  for (const key of EVIDENCE_KEYS) if (typeof value[key] !== 'string' || !value[key].trim() || value[key] === 'UNEXECUTED') violations.push(`${label} ${key} must be a completed redaction-safe string`)
  const referencePattern = new RegExp(`^restricted://${evidenceReferenceScope}/${runId}/${platform}/${context}/[a-z0-9][a-z0-9._-]*$`)
  for (const key of ['safe_reference', 'network_trace_reference']) {
    const reference = value[key]
    if (!referencePattern.test(reference ?? '')) violations.push(`${label} ${key} must be scoped to its run, platform, and context`)
    if (usedReferences.has(reference)) violations.push(`${label} ${key} must not reuse an evidence reference`)
    else usedReferences.add(reference)
  }
  if (!/^sha256:[a-f0-9]{64}$/i.test(value.artifact_identity_checksum)) violations.push(`${label} artifact_identity_checksum must be sha256:<64 hex>`)
  if (value.artifact_identity_checksum !== platformChecksum) violations.push(`${label} checksum must match its platform artifact checksum`)
}

function inspectCase(entry, expectedId, label, contextId, options, violations) {
  const keys = expectedId === 'offline_loss_reconnect_each_session_boundary' ? [...CASE_KEYS, 'session_boundaries'] : CASE_KEYS
  if (!requireExactKeys(entry, keys, label, violations)) return
  if (entry.case_id !== expectedId) violations.push(`${label} case_id must be ${expectedId}`)
  if (options.template ? entry.status !== 'UNEXECUTED' : !['PASS', 'FAIL'].includes(entry.status)) violations.push(`${label} status must be PASS or FAIL for a selected ADR decision`)
  if (!options.template) options.completedStatuses.push(entry.status)
  for (const key of ['preconditions', 'actions', 'expected_outcome', 'cleanup']) if (options.template ? entry[key] !== 'UNEXECUTED' : typeof entry[key] !== 'string' || !entry[key].trim() || entry[key] === 'UNEXECUTED') violations.push(`${label} ${key} must be completed text`)
  inspectEvidence(entry.evidence, `${label} evidence`, { ...options, context: contextId }, violations)
  if (expectedId === 'offline_loss_reconnect_each_session_boundary') {
    if (!Array.isArray(entry.session_boundaries)) return violations.push(`${label} session_boundaries must be an array`)
    const expected = options.catalog.contexts[contextId].cases.filter((id) => id !== expectedId)
    exactIds(entry.session_boundaries, 'boundary', expected, `${label} session boundaries`, violations)
    for (const boundary of entry.session_boundaries) {
      if (!requireExactKeys(boundary, ['boundary', 'status', 'evidence'], `${label} boundary`, violations)) continue
      if (options.template ? boundary.status !== 'UNEXECUTED' : !['PASS', 'FAIL'].includes(boundary.status)) violations.push(`${label} boundary status must be PASS or FAIL for a selected ADR decision`)
      if (!options.template) options.completedStatuses.push(boundary.status)
      inspectEvidence(boundary.evidence, `${label} boundary evidence`, { ...options, context: contextId }, violations)
    }
  }
}

function fallbackFlowIds(catalog) {
  return Object.entries(catalog.contexts).flatMap(([contextId, context]) => [
    ...context.cases.map((caseId) => `${contextId}.case.${caseId}`),
    ...context.credential_lifecycle.map((stageId) => `${contextId}.credential_lifecycle.${stageId}`),
  ])
}

function inspectAdrWork(value, domain, label, template, expected, violations) {
  if (!requireExactKeys(value, ['classification', 'scope_ids', 'details'], `${label} ADR ${domain}_work`, violations)) return
  if (!Array.isArray(value.scope_ids)) violations.push(`${label} ADR ${domain}_work scope_ids must be an array`)
  if (template) {
    if (value.classification !== 'UNEXECUTED') violations.push(`${label} ADR ${domain}_work classification must remain UNEXECUTED`)
    if (Array.isArray(value.scope_ids) && value.scope_ids.length !== 0) violations.push(`${label} ADR ${domain}_work scope_ids must remain empty`)
    if (value.details !== 'UNEXECUTED') violations.push(`${label} ADR ${domain}_work details must remain UNEXECUTED`)
    return
  }
  if (!expected) return
  if (value.classification !== expected.classification) violations.push(`${label} ADR ${domain}_work classification must be ${expected.classification}`)
  if (JSON.stringify(value.scope_ids) !== JSON.stringify(expected.scope_ids)) violations.push(`${label} ADR ${domain}_work scope_ids must exactly match the selected outcome`)
  if (expected.classification === 'no_fallback_work') {
    if (value.details !== NO_FALLBACK_WORK) violations.push(`${label} ADR ${domain}_work details must be ${NO_FALLBACK_WORK}`)
  } else if (typeof value.details !== 'string' || !value.details.trim() || value.details === 'UNEXECUTED' || value.details === NO_FALLBACK_WORK) {
    violations.push(`${label} ADR ${domain}_work details must describe completed fallback work`)
  }
}

function inspectResults(document, label, template, violations, catalog, resultInfo = {}) {
  const contract = resultInfo.contract
  if (!template && RAW_SECRET.test(JSON.stringify(document))) violations.push(`${label} contains a raw credential or capture`)
  const topKeys = ['schema_version', 'release_track', 'qualification', 'template_status', 'notice', 'copy_results_to', 'result_status_vocabulary', 'platforms', 'redaction_policy', 'adr_contract', 'references']
  if (!requireExactKeys(document, topKeys, label, violations)) return
  const expectedSchemaVersion = contract?.schemaVersion
  if (document.schema_version !== expectedSchemaVersion) { violations.push(`${label} schema_version must be ${expectedSchemaVersion}`); return }
  if (document.release_track !== contract?.releaseTrack) violations.push(`${label} release_track is invalid`)
  if (document.qualification !== contract?.qualification) violations.push(`${label} qualification must be ${contract?.qualification}`)
  if (template && document.template_status !== 'UNEXECUTED') violations.push('device evidence template status must remain UNEXECUTED')
  if (!template && document.template_status !== 'COMPLETED') violations.push(`${label} template_status must be COMPLETED`)
  const expectedNotice = template ? 'TEMPLATE / NOT EVIDENCE — immutable source; JSON results are the sole claim-bearing artifact.' : 'COMPLETED RESULTS / CLAIM-BEARING ARTIFACT'
  if (document.notice !== expectedNotice) violations.push(`${label} notice must exactly match its contract marker`)
  if (document.copy_results_to !== contract?.copyResultsTo) violations.push(`${label} copy_results_to is invalid`)
  if (JSON.stringify(document.result_status_vocabulary) !== JSON.stringify(['UNEXECUTED', 'PASS', 'FAIL', 'BLOCKED', 'UNVERIFIED'])) violations.push(`${label} result status vocabulary is invalid`)
  if (!Array.isArray(document.platforms)) return violations.push(`${label} platforms must be an array`)
  const platformNames = Object.keys(catalog.platforms)
  exactIds(document.platforms, 'platform', platformNames, `${label} platforms`, violations)
  const usedReferences = new Set()
  const platformChecksums = new Set()
  const runCommits = new Set()
  const runVersions = new Set()
  const completedStatuses = []
  for (const platform of document.platforms) {
    const name = platform?.platform
    if (!catalog.platforms[name]) continue
    if (!requireExactKeys(platform, ['platform', 'metadata', 'attestation', 'contexts', 'platform_cases'], `${label} ${name}`, violations)) continue
    const metadataKeys = ['device_type', 'is_simulator', 'is_emulator', 'commit_or_tag', 'app_version', 'platform_build', 'device_model', 'os_version', 'tooling', 'staging_environment', 'test_date_time', 'tester_owner', 'artifact_identity_checksum']
    if (requireExactKeys(platform.metadata, metadataKeys, `${label} ${name} metadata`, violations)) {
      if (template) {
        for (const key of metadataKeys) if (platform.metadata[key] !== 'UNEXECUTED') violations.push(`${label} ${name} metadata ${key} must remain UNEXECUTED`)
      } else {
        if (platform.metadata.device_type !== catalog.platforms[name].device_type || platform.metadata.is_simulator !== false || platform.metadata.is_emulator !== false) violations.push(`${label} ${name} must record a physical device, not simulator/emulator`)
        for (const key of metadataKeys.slice(3)) if (typeof platform.metadata[key] !== 'string' || !platform.metadata[key].trim() || platform.metadata[key] === 'UNEXECUTED') violations.push(`${label} ${name} metadata ${key} is invalid`)
        runCommits.add(platform.metadata.commit_or_tag)
        runVersions.add(platform.metadata.app_version)
        if (!SEMVER.test(platform.metadata.app_version ?? '')) violations.push(`${label} ${name} metadata app_version must be semantic versioning`)
        if (/simulator|emulator/i.test(`${platform.metadata.device_model} ${platform.metadata.tooling}`)) violations.push(`${label} ${name} device metadata must not describe a simulator or emulator`)
        if (!/^sha256:[a-f0-9]{64}$/i.test(platform.metadata.artifact_identity_checksum ?? '')) violations.push(`${label} ${name} metadata artifact_identity_checksum must be sha256:<64 hex>`)
        if (platformChecksums.has(platform.metadata.artifact_identity_checksum)) violations.push(`${label} platform artifact checksums must differ`)
        platformChecksums.add(platform.metadata.artifact_identity_checksum)
        const timestamp = platform.metadata.test_date_time
        if (!isRfc3339(timestamp)) violations.push(`${label} ${name} metadata test_date_time must be component-valid RFC3339 with timezone`)
        else if (timestamp.slice(0, 10) !== resultInfo.date) violations.push(`${label} ${name} metadata test_date_time must match result path date`)
      }
    }
    const attestationKeys = ['platform', 'device_type', 'safe_reference', 'artifact_identity_checksum', 'captured_at']
    if (requireExactKeys(platform.attestation, attestationKeys, `${label} ${name} attestation`, violations)) {
      if (template) for (const key of attestationKeys) { if (platform.attestation[key] !== 'UNEXECUTED') violations.push(`${label} ${name} attestation ${key} must remain UNEXECUTED`) }
      else {
        if (platform.attestation.platform !== name || platform.attestation.device_type !== catalog.platforms[name].device_type) violations.push(`${label} ${name} attestation contradicts its platform`)
        if (platform.attestation.artifact_identity_checksum !== platform.metadata.artifact_identity_checksum) violations.push(`${label} ${name} attestation checksum must match platform artifact`)
        if (platform.attestation.captured_at !== platform.metadata.test_date_time) violations.push(`${label} ${name} attestation timestamp must match platform metadata`)
        const expectedRef = `restricted://${contract.evidenceReferenceScope}/${resultInfo.runId}/${name}/attestation`
        if (platform.attestation.safe_reference !== expectedRef) violations.push(`${label} ${name} attestation reference is invalid`)
        if (usedReferences.has(platform.attestation.safe_reference)) violations.push(`${label} ${name} attestation reference must be unique`)
        usedReferences.add(platform.attestation.safe_reference)
      }
    }
    if (!Array.isArray(platform.contexts)) { violations.push(`${label} ${name} contexts must be an array`); continue }
    const contextIds = Object.keys(catalog.contexts)
    exactIds(platform.contexts, 'context_id', contextIds, `${label} ${name} contexts`, violations)
    for (const context of platform.contexts) {
      const id = context?.context_id
      if (!catalog.contexts[id] || !requireExactKeys(context, ['context_id', 'cases', 'credential_lifecycle'], `${label} ${name} ${id}`, violations)) continue
      const options = { template, platform: name, runId: resultInfo.runId, platformChecksum: platform.metadata?.artifact_identity_checksum, usedReferences, catalog, completedStatuses, evidenceReferenceScope: contract.evidenceReferenceScope }
      if (!Array.isArray(context.cases)) { violations.push(`${label} ${name} ${id} cases must be an array`); continue }
      exactIds(context.cases, 'case_id', catalog.contexts[id].cases, `${label} ${name} ${id} cases`, violations)
      for (const caseId of catalog.contexts[id].cases) { const entry = context.cases.find((x) => x?.case_id === caseId); if (entry) inspectCase(entry, caseId, `${label} ${name} ${id} ${caseId}`, id, options, violations) }
      if (!Array.isArray(context.credential_lifecycle)) { violations.push(`${label} ${name} ${id} lifecycle must be an array`); continue }
      exactIds(context.credential_lifecycle, 'stage_id', catalog.contexts[id].credential_lifecycle, `${label} ${name} ${id} lifecycle`, violations)
      for (const stage of context.credential_lifecycle) { if (!requireExactKeys(stage, ['stage_id', 'status', 'evidence'], `${label} ${name} ${id} lifecycle stage`, violations)) continue; if (template ? stage.status !== 'UNEXECUTED' : !['PASS', 'FAIL'].includes(stage.status)) violations.push(`${label} ${name} ${id} lifecycle stage status must be PASS or FAIL for a selected ADR decision`); if (!template) completedStatuses.push(stage.status); inspectEvidence(stage.evidence, `${label} ${name} ${id} lifecycle evidence`, { ...options, context: id }, violations) }
    }
    if (!Array.isArray(platform.platform_cases)) { violations.push(`${label} ${name} platform_cases must be an array`); continue }
    const platformCase = catalog.platforms[name].platform_case
    exactIds(platform.platform_cases, 'case_id', [platformCase], `${label} ${name} platform cases`, violations)
    if (platform.platform_cases[0]) inspectCase(platform.platform_cases[0], platformCase, `${label} ${name} platform case`, 'platform', { template, platform: name, runId: resultInfo.runId, platformChecksum: platform.metadata?.artifact_identity_checksum, usedReferences, catalog, completedStatuses, evidenceReferenceScope: contract.evidenceReferenceScope }, violations)
  }
  if (!template && runCommits.size !== 1) violations.push(`${label} platforms must use the same commit_or_tag`)
  if (!template && runVersions.size !== 1) violations.push(`${label} platforms must use the same app_version`)
  if (!requireExactKeys(document.redaction_policy, ['raw_capture_policy', 'safe_reference_policy'], `${label} redaction policy`, violations) || !/never commit raw captures/i.test(document.redaction_policy.raw_capture_policy ?? '')) violations.push(`${label} must prohibit raw captures`)
  if (requireExactKeys(document.adr_contract, ADR_CONTRACT_KEYS, `${label} ADR contract`, violations)) {
    if (JSON.stringify(document.adr_contract.allowed_outcomes) !== JSON.stringify(catalog.adr.allowed_outcomes)
      || JSON.stringify(document.adr_contract.fallback_outcomes) !== JSON.stringify(catalog.adr.fallback_outcomes)
      || JSON.stringify(document.adr_contract.forbidden_fallbacks) !== JSON.stringify(catalog.adr.forbidden_fallbacks)) violations.push(`${label} ADR catalogs are invalid`)
    if (template) {
      for (const key of ['selected_outcome', 'decision_artifact_reference', ...ADR_TEXT_FIELDS]) if (document.adr_contract[key] !== 'UNEXECUTED') violations.push(`${label} ADR ${key} must remain UNEXECUTED`)
      for (const domain of ['frontend', 'backend']) inspectAdrWork(document.adr_contract[`${domain}_work`], domain, label, true, null, violations)
      if (!Array.isArray(document.adr_contract.follow_up_issue_references) || document.adr_contract.follow_up_issue_references.length !== 0) violations.push(`${label} ADR follow_up_issue_references must remain an empty array`)
    } else {
      const selectedOutcome = document.adr_contract.selected_outcome
      const selectedOutcomeIsValid = typeof selectedOutcome === 'string' && catalog.adr.allowed_outcomes.includes(selectedOutcome)
      if (!selectedOutcomeIsValid) violations.push(`${label} ADR selected_outcome must be exactly one approved scalar`)
      if (document.adr_contract.decision_artifact_reference !== `restricted://${contract.evidenceReferenceScope}/${resultInfo.runId}/decision`) violations.push(`${label} ADR decision_artifact_reference must match the result track and run`)
      for (const key of ADR_TEXT_FIELDS) if (typeof document.adr_contract[key] !== 'string' || !document.adr_contract[key].trim() || document.adr_contract[key] === 'UNEXECUTED') violations.push(`${label} ADR ${key} must be completed text`)
      const workRequirements = selectedOutcomeIsValid ? catalog.adr.work_requirements[selectedOutcome] : null
      for (const domain of ['frontend', 'backend']) inspectAdrWork(document.adr_contract[`${domain}_work`], domain, label, false, workRequirements?.[domain], violations)
      const followUps = document.adr_contract.follow_up_issue_references
      if (!Array.isArray(followUps)) {
        violations.push(`${label} ADR follow-up issue references must be an array`)
      } else {
        const expectedFlowIds = fallbackFlowIds(catalog)
        const expectedFlowIdSet = new Set(expectedFlowIds)
        const coveredFlowIds = new Set()
        const usedIssueUrls = new Set()
        for (const [index, reference] of followUps.entries()) {
          const referenceLabel = `${label} ADR follow-up issue reference ${index + 1}`
          if (!requireExactKeys(reference, ['issue_url', 'flow_ids'], referenceLabel, violations)) continue
          const match = FOLLOW_UP_ISSUE_REFERENCE.exec(reference.issue_url)
          if (!match || match[1] === '64') violations.push(`${referenceLabel} issue_url must be a canonical separate tyhuang9/dupert issue URL`)
          if (usedIssueUrls.has(reference.issue_url)) violations.push(`${label} ADR follow-up issue references must not repeat issue_url values`)
          usedIssueUrls.add(reference.issue_url)
          if (!Array.isArray(reference.flow_ids)) { violations.push(`${referenceLabel} flow_ids must be an array`); continue }
          if (reference.flow_ids.length === 0) violations.push(`${referenceLabel} flow_ids must not be empty`)
          if (new Set(reference.flow_ids).size !== reference.flow_ids.length) violations.push(`${referenceLabel} flow_ids must not repeat within an issue`)
          for (const flowId of reference.flow_ids) {
            if (typeof flowId !== 'string' || !expectedFlowIdSet.has(flowId)) violations.push(`${referenceLabel} contains an unknown flow_id`)
            else if (coveredFlowIds.has(flowId)) violations.push(`${label} ADR follow-up issue references must not duplicate flow coverage`)
            else coveredFlowIds.add(flowId)
          }
        }
        if (selectedOutcomeIsValid && catalog.adr.fallback_outcomes.includes(selectedOutcome) && followUps.length === 0) violations.push(`${label} ADR ${selectedOutcome} requires at least one follow-up issue reference`)
        if (selectedOutcomeIsValid && catalog.adr.fallback_outcomes.includes(selectedOutcome) && expectedFlowIds.some((flowId) => !coveredFlowIds.has(flowId))) violations.push(`${label} ADR ${selectedOutcome} follow-up issue references must cover every catalog member/guest case and credential-lifecycle flow exactly once`)
        if (selectedOutcomeIsValid && !catalog.adr.fallback_outcomes.includes(selectedOutcome) && followUps.length !== 0) violations.push(`${label} ADR ${selectedOutcome} follow-up issue references must be empty`)
      }
      if (selectedOutcome === 'cookie_only_proven' && completedStatuses.some((status) => status !== 'PASS')) violations.push(`${label} cookie_only_proven requires every executed check to PASS`)
      if (selectedOutcome === 'native_credential_transport' && !completedStatuses.includes('FAIL')) violations.push(`${label} native_credential_transport requires at least one executed FAIL`)
    }
  }
  const expectedReferences = contract?.references
  if (!requireExactKeys(document.references, ['catalog', 'spike', 'adr'], `${label} references`, violations) || Object.entries(expectedReferences).some(([key, value]) => document.references[key] !== value)) violations.push(`${label} references are invalid`)
}
function inspectDeviceEvidenceContract(sources, violations) {
  const catalog = parseJsonDocument(sources.authSessionEvidenceCatalog, 'auth-session-device-evidence.catalog.json', violations)
  if (!catalog || !inspectCatalog(catalog, SHARED_CROSS_PLATFORM_EVIDENCE_CONTRACT, violations)) return
  const document = parseJsonDocument(sources.authSessionEvidenceTemplate, 'auth-session-device-evidence.template.json', violations)
  if (document) inspectResults(document, 'device evidence template', true, violations, catalog, { contract: SHARED_CROSS_PLATFORM_EVIDENCE_CONTRACT })
  marker(sources.authSessionDeviceSpike, 'issue64-spike-policy', { contract_version: String(SHARED_CROSS_PLATFORM_EVIDENCE_CONTRACT.schemaVersion), release_track: SHARED_CROSS_PLATFORM_EVIDENCE_CONTRACT.releaseTrack, qualification: SHARED_CROSS_PLATFORM_EVIDENCE_CONTRACT.qualification, claim_bearing_artifact: 'results_json_only', immutable_template: 'true', raw_captures: 'external_restricted_only' }, violations)
  marker(sources.authSessionAdrTemplate, 'issue64-adr-policy', { contract_version: String(SHARED_CROSS_PLATFORM_EVIDENCE_CONTRACT.schemaVersion), release_track: SHARED_CROSS_PLATFORM_EVIDENCE_CONTRACT.releaseTrack, qualification: SHARED_CROSS_PLATFORM_EVIDENCE_CONTRACT.qualification, allowed_outcomes: 'cookie_only_proven,native_credential_transport', forbidden_fallbacks: 'endpoint_only_fallback,web_storage_refresh_or_guest_token_workaround', decision_artifact: 'results_json_only' }, violations)
  for (const [name, contents, notice] of [['auth-session-device-spike.md', sources.authSessionDeviceSpike, '> **TEMPLATE / NOT EVIDENCE** — This runbook carries no status, result, or decision.'], ['auth-session-transport-adr-template.md', sources.authSessionAdrTemplate, '> **TEMPLATE / NOT EVIDENCE** — This document is instruction-only and records no decision.']]) {
    if (contents.split(notice).length !== 2) violations.push(`${name} must contain its exact immutable notice once`)
    if (RAW_SECRET.test(contents)) violations.push(`${name} contains a raw credential`)
    if (createHash('sha256').update(contents).digest('hex') !== IMMUTABLE_DOCUMENT_HASHES[name]) violations.push(`${name} must remain the canonical instruction-only document`)
  }
  if (!sources.releaseDocument.includes('auth-session-device-evidence.template.json')) violations.push('release-readiness must reference issue #64 template')
  if ((sources.trackedFiles ?? []).length) {
    for (const source of REQUIRED_SOURCE_FILES) if (!sources.trackedFiles.includes(source)) violations.push(`immutable issue #64 source must be tracked: ${source}`)
    for (const path of sources.trackedFiles) { const match = path.match(RESULT_PATH); const shape = path.match(RESULT_SHAPE); if (shape && (!isCalendarDate(shape[1]) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(shape[2]))) violations.push(`tracked issue #64 evidence path has invalid date or run ID: ${path}`); else if (path.startsWith('docs/mobile/evidence/issue-64/') && !match) violations.push(`tracked issue #64 evidence path is unauthorized: ${path}`) }
    for (const path of sources.trackedFiles.filter((path) => RESULT_PATH.test(path))) if (!(path in (sources.resultCopies ?? {}))) violations.push(`tracked issue #64 result copy could not be safely read: ${path}`)
    for (const [path, raw] of Object.entries(sources.resultCopies ?? {}).filter(([path]) => RESULT_PATH.test(path))) { const match = path.match(RESULT_PATH); if (!match || !sources.trackedFiles.includes(path)) { violations.push(`result copy must be tracked at an authorized path: ${path}`); continue }; const result = parseJsonDocument(raw, path, violations); if (result) inspectResults(result, path, false, violations, catalog, { date: match[1], runId: match[2], contract: SHARED_CROSS_PLATFORM_EVIDENCE_CONTRACT }) }
  } else if (Object.keys(sources.resultCopies ?? {}).length) {
    for (const path of Object.keys(sources.resultCopies)) violations.push(`result copy must be tracked at an authorized path: ${path}`)
  }
}
function inspectIosBetaDeviceEvidenceContract(sources, violations) {
  const catalog = parseJsonDocument(sources.iosBetaAuthSessionEvidenceCatalog, 'ios-beta-auth-session-evidence.catalog.json', violations)
  if (!catalog || !inspectCatalog(catalog, IOS_BETA_EVIDENCE_CONTRACT, violations)) return
  const document = parseJsonDocument(sources.iosBetaAuthSessionEvidenceTemplate, 'ios-beta-auth-session-device-evidence.template.json', violations)
  if (document) inspectResults(document, 'iOS beta device evidence template', true, violations, catalog, { contract: IOS_BETA_EVIDENCE_CONTRACT })
  marker(sources.iosBetaAuthSessionDeviceSpike, 'issue64-ios-beta-spike-policy', { contract_version: String(IOS_BETA_EVIDENCE_CONTRACT.schemaVersion), release_track: IOS_BETA_EVIDENCE_CONTRACT.releaseTrack, qualification: IOS_BETA_EVIDENCE_CONTRACT.qualification, claim_bearing_artifact: 'results_json_only', immutable_template: 'true', raw_captures: 'external_restricted_only' }, violations)
  marker(sources.iosBetaAuthSessionAdrTemplate, 'issue64-ios-beta-adr-policy', { contract_version: String(IOS_BETA_EVIDENCE_CONTRACT.schemaVersion), release_track: IOS_BETA_EVIDENCE_CONTRACT.releaseTrack, qualification: IOS_BETA_EVIDENCE_CONTRACT.qualification, allowed_outcomes: 'cookie_only_proven,native_credential_transport', forbidden_fallbacks: 'endpoint_only_fallback,web_storage_refresh_or_guest_token_workaround', decision_artifact: 'results_json_only' }, violations)
  for (const [name, contents, notice] of [['ios-beta-auth-session-device-spike.md', sources.iosBetaAuthSessionDeviceSpike, '> **TEMPLATE / NOT EVIDENCE** — This runbook carries no status, result, or decision.'], ['ios-beta-auth-session-transport-adr-template.md', sources.iosBetaAuthSessionAdrTemplate, '> **TEMPLATE / NOT EVIDENCE** — This document is instruction-only and records no decision.']]) {
    if (contents.split(notice).length !== 2) violations.push(`${name} must contain its exact immutable notice once`)
    if (RAW_SECRET.test(contents)) violations.push(`${name} contains a raw credential`)
    if (createHash('sha256').update(contents).digest('hex') !== IMMUTABLE_DOCUMENT_HASHES[name]) violations.push(`${name} must remain the canonical instruction-only document`)
  }
  if (!sources.releaseDocument.includes('ios-beta-auth-session-device-evidence.template.json')) violations.push('release-readiness must reference iOS beta issue #64 template')
  if ((sources.trackedFiles ?? []).length) {
    for (const source of REQUIRED_IOS_BETA_SOURCE_FILES) if (!sources.trackedFiles.includes(source)) violations.push(`immutable iOS beta issue #64 source must be tracked: ${source}`)
    for (const path of sources.trackedFiles) { const match = path.match(IOS_BETA_RESULT_PATH); const shape = path.match(IOS_BETA_RESULT_SHAPE); if (shape && (!isCalendarDate(shape[1]) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(shape[2]))) violations.push(`tracked iOS beta issue #64 evidence path has invalid date or run ID: ${path}`); else if (path.startsWith('docs/mobile/evidence/issue-64-ios/') && !match) violations.push(`tracked iOS beta issue #64 evidence path is unauthorized: ${path}`) }
    for (const path of sources.trackedFiles.filter((path) => IOS_BETA_RESULT_PATH.test(path))) if (!(path in (sources.resultCopies ?? {}))) violations.push(`tracked iOS beta issue #64 result copy could not be safely read: ${path}`)
    for (const [path, raw] of Object.entries(sources.resultCopies ?? {}).filter(([path]) => IOS_BETA_RESULT_PATH.test(path))) { const match = path.match(IOS_BETA_RESULT_PATH); if (!match || !sources.trackedFiles.includes(path)) { violations.push(`iOS beta result copy must be tracked at an authorized path: ${path}`); continue }; const result = parseJsonDocument(raw, path, violations); if (result) inspectResults(result, path, false, violations, catalog, { date: match[1], runId: match[2], contract: IOS_BETA_EVIDENCE_CONTRACT }) }
  } else if (Object.keys(sources.resultCopies ?? {}).some((path) => IOS_BETA_RESULT_PATH.test(path))) {
    for (const path of Object.keys(sources.resultCopies).filter((path) => IOS_BETA_RESULT_PATH.test(path))) violations.push(`iOS beta result copy must be tracked at an authorized path: ${path}`)
  }
}
function parseContract(document, violations) {
  const blocks = [...document.matchAll(/<!-- mobile-release-contract\n([\s\S]*?)\n-->/g)]
  if (blocks.length !== 1) {
    violations.push('release-readiness document must contain exactly one machine-readable toolchain contract')
    return new Map()
  }

  const contract = new Map()
  for (const line of blocks[0][1].split('\n').map((entry) => entry.trim()).filter(Boolean)) {
    const separator = line.indexOf('=')
    if (separator <= 0 || separator === line.length - 1) {
      violations.push(`release contract entry is malformed: ${line}`)
      continue
    }
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    if (contract.has(key)) violations.push(`release contract repeats ${key}`)
    contract.set(key, value)
  }
  return contract
}

function parseGateRow(line) {
  return line.split('|').slice(1, -1).map((cell) => cell.trim())
}

function inspectGateTable(document, violations) {
  const blocks = [...document.matchAll(/<!-- mobile-release-gates:start -->([\s\S]*?)<!-- mobile-release-gates:end -->/g)]
  if (blocks.length !== 1) {
    violations.push('release-readiness document must contain exactly one release-gate table block')
    return []
  }

  const lines = blocks[0][1].split('\n').map((line) => line.trim()).filter((line) => line.startsWith('|'))
  if (lines.length < 3) {
    violations.push('release-gate table is incomplete')
    return []
  }

  const header = parseGateRow(lines[0])
  if (header.join('|') !== 'Gate|Status|Owner|Evidence') {
    violations.push('release-gate table must use Gate, Status, Owner, and Evidence columns')
    return []
  }

  const rows = lines.slice(2).map(parseGateRow)
  for (const row of rows) {
    if (row.length !== 4 || row.some((cell) => cell.length === 0)) {
      violations.push('every release gate must have non-empty status, owner, and evidence fields')
      continue
    }
    const [gate, status, owner, evidence] = row
    if (!ALLOWED_GATE_STATUSES.has(status)) {
      violations.push(`${gate} has unsupported status ${status}`)
    }
    if (status === 'PASS' && /unassigned|tbd/i.test(owner)) {
      violations.push(`${gate} cannot pass without an accountable owner`)
    }
    if (status === 'PASS' && /not recorded|unverified|tbd/i.test(evidence)) {
      violations.push(`${gate} cannot pass without recorded evidence`)
    }
  }

  const gateNames = new Set(rows.map(([gate]) => gate))
  if (gateNames.size !== rows.length) {
    violations.push('release-gate table must not repeat gate names')
  }
  for (const requiredGate of REQUIRED_GATES) {
    if (!gateNames.has(requiredGate)) violations.push(`release gate is missing: ${requiredGate}`)
  }
  for (const gate of gateNames) if (!REQUIRED_GATES.includes(gate)) violations.push(`release gate is unknown: ${gate}`)
  const outsideGateTable = document.replace(blocks[0][0], '')
  const protectedSubject = /Authentication and guest sessions|Device install smoke|Physical-device evidence/i
  if (outsideGateTable.split('\n').some((line) => protectedSubject.test(line) && /\b(?:PASS|APPROVED)\b/i.test(line.replace(/\bmust\s+PASS\b/ig, '')))) violations.push('release-readiness contains an issue #64 PASS or APPROVED claim outside the canonical gate table')
  return rows
}

function inspectProductionBackend(environmentFile, violations) {
  const rawUrl = capture(
    environmentFile,
    /^VITE_BACKEND_API_URL=(.+)$/m,
    'native production backend URL',
    violations,
  )
  if (!rawUrl) return

  let url
  try {
    url = new URL(rawUrl.trim())
  } catch {
    violations.push('native production backend URL is invalid')
    return
  }

  if (url.protocol !== 'https:') violations.push('native production backend URL must use HTTPS')
  if (url.username || url.password || url.search || url.hash) {
    violations.push('native production backend URL must not include credentials, query, or fragment data')
  }
  if (url.pathname !== '/' || /localhost|127\.0\.0\.1|\.test$|\.example$|invalid|placeholder|change-me/i.test(url.hostname)) {
    violations.push('native production backend URL must be a deployed non-placeholder origin')
  }
}

export function loadTrackedResultCopies(repositoryRoot, trackedFiles = []) {
  const root = realpathSync(resolve(repositoryRoot))
  const copies = {}
  const violations = []
  for (const path of trackedFiles.filter((entry) => RESULT_PATH.test(entry) || IOS_BETA_RESULT_PATH.test(entry))) {
    const candidate = resolve(root, path)
    try {
      if (!lstatSync(candidate).isFile()) throw new Error('not a regular file')
      const realPath = realpathSync(candidate)
      const relativePath = relative(root, realPath)
      if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) throw new Error('outside repository')
      copies[path] = readFileSync(realPath, 'utf8')
    } catch {
      violations.push(`tracked issue #64 result must be a readable regular non-symlink file inside the repository: ${path}`)
    }
  }
  return { copies, violations }
}

export function loadMobileReleaseSources(repositoryRoot, trackedFiles = []) {
  const root = resolve(repositoryRoot)
  const read = (path) => readFileSync(resolve(root, path), 'utf8')
  const loadedResults = loadTrackedResultCopies(root, trackedFiles)

  return {
    frontendPackage: read('frontend/package.json'),
    capacitorConfig: read('frontend/capacitor.config.ts'),
    androidVariables: read('frontend/android/variables.gradle'),
    androidBuild: read('frontend/android/build.gradle'),
    androidAppBuild: read('frontend/android/app/build.gradle'),
    androidGradleWrapper: read('frontend/android/gradle/wrapper/gradle-wrapper.properties'),
    iosProject: read('frontend/ios/App/App.xcodeproj/project.pbxproj'),
    iosPackage: read('frontend/ios/App/CapApp-SPM/Package.swift'),
    nativeProductionEnvironment: read('frontend/.env.native-production'),
    workflow: read('.github/workflows/ci.yml'),
    releaseDocument: read('docs/mobile/release-readiness.md'),
    authSessionEvidenceCatalog: read('docs/mobile/auth-session-device-evidence.catalog.json'),
    authSessionEvidenceTemplate: read('docs/mobile/auth-session-device-evidence.template.json'),
    authSessionDeviceSpike: read('docs/mobile/auth-session-device-spike.md'),
    authSessionAdrTemplate: read('docs/mobile/auth-session-transport-adr-template.md'),
    iosBetaAuthSessionEvidenceCatalog: read('docs/mobile/ios-beta-auth-session-evidence.catalog.json'),
    iosBetaAuthSessionEvidenceTemplate: read('docs/mobile/ios-beta-auth-session-device-evidence.template.json'),
    iosBetaAuthSessionDeviceSpike: read('docs/mobile/ios-beta-auth-session-device-spike.md'),
    iosBetaAuthSessionAdrTemplate: read('docs/mobile/ios-beta-auth-session-transport-adr-template.md'),
    resultCopies: loadedResults.copies,
    sourceViolations: loadedResults.violations,
    trackedFiles,
  }
}

export function inspectMobileReleaseReadiness(sources) {
  const violations = [...(sources.sourceViolations ?? [])]
  let frontendPackage
  try {
    frontendPackage = JSON.parse(sources.frontendPackage)
  } catch {
    violations.push('frontend/package.json is invalid JSON')
    return violations
  }

  const capacitorPackages = ['@capacitor/core', '@capacitor/android', '@capacitor/ios']
    .map((name) => [name, frontendPackage.dependencies?.[name]])
    .concat([['@capacitor/cli', frontendPackage.devDependencies?.['@capacitor/cli']]])
  const capacitorVersions = new Set(capacitorPackages.map(([, version]) => version).filter(Boolean))
  for (const [name, version] of capacitorPackages) {
    if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
      violations.push(`${name} must use an exact semantic version`)
    }
  }
  if (capacitorVersions.size !== 1) violations.push('Capacitor platform, core, and CLI versions must agree')
  const capacitorVersion = capacitorVersions.size === 1 ? [...capacitorVersions][0] : null

  const appId = capture(sources.capacitorConfig, /appId:\s*['"]([^'"]+)['"]/, 'Capacitor appId', violations)
  const appName = capture(sources.capacitorConfig, /appName:\s*['"]([^'"]+)['"]/, 'Capacitor appName', violations)
  const webDir = capture(sources.capacitorConfig, /webDir:\s*['"]([^'"]+)['"]/, 'Capacitor webDir', violations)
  if (webDir && webDir !== 'dist') violations.push('Capacitor webDir must remain dist')
  if (/^\s*url\s*:/m.test(sources.capacitorConfig)) {
    violations.push('Capacitor must bundle the app and must not configure server.url')
  }

  const androidNamespace = capture(sources.androidAppBuild, /namespace\s*=\s*['"]([^'"]+)['"]/, 'Android namespace', violations)
  const androidAppId = capture(sources.androidAppBuild, /applicationId\s+['"]([^'"]+)['"]/, 'Android applicationId', violations)
  const iosAppIds = uniqueCaptures(sources.iosProject, /PRODUCT_BUNDLE_IDENTIFIER\s*=\s*([^;\s]+);/g)
  if (iosAppIds.length !== 1) violations.push('iOS bundle identifier must be present and consistent across configurations')
  for (const [label, value] of [['Android namespace', androidNamespace], ['Android applicationId', androidAppId], ['iOS bundle identifier', iosAppIds[0]]]) {
    if (appId && value && value !== appId) violations.push(`${label} must match Capacitor appId`)
  }

  const androidVersionCode = capture(sources.androidAppBuild, /versionCode\s+(\d+)/, 'Android versionCode', violations)
  const androidVersionName = capture(sources.androidAppBuild, /versionName\s+['"]([^'"]+)['"]/, 'Android versionName', violations)
  const iosBuildVersions = uniqueCaptures(sources.iosProject, /CURRENT_PROJECT_VERSION\s*=\s*([^;\s]+);/g)
  const iosMarketingVersions = uniqueCaptures(sources.iosProject, /MARKETING_VERSION\s*=\s*([^;\s]+);/g)
  if (!androidVersionCode || Number(androidVersionCode) <= 0) violations.push('Android versionCode must be positive')
  if (iosBuildVersions.length !== 1 || Number(iosBuildVersions[0]) <= 0) violations.push('iOS build number must be positive and consistent')
  if (iosMarketingVersions.length !== 1) violations.push('iOS marketing version must be present and consistent')
  if (androidVersionCode && iosBuildVersions.length === 1 && androidVersionCode !== iosBuildVersions[0]) {
    violations.push('Android and iOS build numbers must agree')
  }
  if (androidVersionName && iosMarketingVersions.length === 1 && androidVersionName !== iosMarketingVersions[0]) {
    violations.push('Android and iOS marketing versions must agree')
  }

  const swiftCapacitorVersion = capture(sources.iosPackage, /capacitor-swift-pm\.git['"],\s*exact:\s*['"]([^'"]+)['"]/, 'iOS Capacitor package version', violations)
  if (capacitorVersion && swiftCapacitorVersion && capacitorVersion !== swiftCapacitorVersion) {
    violations.push('iOS generated Capacitor package must match frontend Capacitor version')
  }

  const nodeVersions = uniqueCaptures(sources.workflow, /node-version:\s*['"]([^'"]+)['"]/g)
  const javaVersions = uniqueCaptures(sources.workflow, /java-version:\s*['"]([^'"]+)['"]/g)
  if (nodeVersions.length !== 1) violations.push('CI Node version must be present and consistent across jobs')
  if (javaVersions.length !== 1) violations.push('CI Java version must be present and consistent across jobs')
  const nodeVersion = nodeVersions.length === 1 ? nodeVersions[0] : null
  const javaVersion = javaVersions.length === 1 ? javaVersions[0] : null
  const gradleVersion = capture(sources.androidGradleWrapper, /gradle-([\d.]+)-(?:all|bin)\.zip/, 'Android Gradle version', violations)
  const androidGradlePlugin = capture(sources.androidBuild, /com\.android\.tools\.build:gradle:([\d.]+)/, 'Android Gradle Plugin version', violations)
  const compileSdk = capture(sources.androidVariables, /compileSdkVersion\s*=\s*(\d+)/, 'Android compile SDK', violations)
  const targetSdk = capture(sources.androidVariables, /targetSdkVersion\s*=\s*(\d+)/, 'Android target SDK', violations)
  const minSdk = capture(sources.androidVariables, /minSdkVersion\s*=\s*(\d+)/, 'Android minimum SDK', violations)
  const iosTargets = uniqueCaptures(sources.iosProject, /IPHONEOS_DEPLOYMENT_TARGET\s*=\s*([^;\s]+);/g)
  if (iosTargets.length !== 1) violations.push('iOS deployment target must be present and consistent')

  const expectedContract = new Map([
    ['app_id', appId],
    ['app_name', appName],
    ['capacitor', capacitorVersion],
    ['node', nodeVersion],
    ['java', javaVersion],
    ['gradle', gradleVersion],
    ['android_gradle_plugin', androidGradlePlugin],
    ['android_compile_sdk', compileSdk],
    ['android_target_sdk', targetSdk],
    ['android_min_sdk', minSdk],
    ['ios_deployment_target', iosTargets.length === 1 ? iosTargets[0] : null],
  ])
  const documentedContract = parseContract(sources.releaseDocument, violations)
  for (const [key, expected] of expectedContract) {
    if (expected && documentedContract.get(key) !== expected) {
      violations.push(`documented ${key} must match repository configuration (${expected})`)
    }
  }

  inspectProductionBackend(sources.nativeProductionEnvironment, violations)
  const gateRows = inspectGateTable(sources.releaseDocument, violations)
  marker(sources.releaseDocument, 'ios-beta-release-scope', { contract_version: '1', primary_platform: 'ios', android_device_parity: 'deferred' }, violations)
  marker(sources.releaseDocument, 'issue64-release-policy', { contract_version: '2', claim_bearing_artifact: 'results_json_only' }, violations)
  for (const requiredBlockedGate of ['Authentication and guest sessions', 'Device install smoke']) {
    const row = gateRows.find(([gate]) => gate === requiredBlockedGate)
    if (row && row[1] !== 'BLOCKED') violations.push(`${requiredBlockedGate} must remain BLOCKED until physical-device evidence is reviewed`)
  }
  inspectDeviceEvidenceContract(sources, violations)
  inspectIosBetaDeviceEvidenceContract(sources, violations)

  for (const path of sources.trackedFiles ?? []) {
    if (FORBIDDEN_TRACKED_RELEASE_FILES.test(path)) {
      violations.push(`tracked release credential material is forbidden: ${path}`)
    }
  }

  return violations
}

export function assertMobileReleaseReadiness(repositoryRoot, trackedFiles) {
  if (!Array.isArray(trackedFiles) || trackedFiles.length === 0) throw new Error('Mobile release-readiness preflight failed:\n- tracked-file input must not be empty')
  const violations = inspectMobileReleaseReadiness(
    loadMobileReleaseSources(repositoryRoot, trackedFiles),
  )
  if (violations.length > 0) {
    throw new Error(`Mobile release-readiness preflight failed:\n${violations.map((item) => `- ${item}`).join('\n')}`)
  }
}

const invokedPath = process.argv[1] && resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  if (!process.argv.includes('--tracked-files-stdin')) {
    throw new Error('Pass the repository tracked-file list with --tracked-files-stdin')
  }
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const trackedFiles = readFileSync(0, 'utf8').split('\0').filter(Boolean)
  assertMobileReleaseReadiness(repositoryRoot, trackedFiles)
  console.log('PASS mobile release-readiness preflight (artifact signing and device gates remain separate)')
}
