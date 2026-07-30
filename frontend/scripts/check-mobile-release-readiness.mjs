import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const REQUIRED_GATES = ['Repository contract', 'Artifact provenance', 'Signing and secrets', 'Identity and versioning', 'Production configuration', 'Authentication and guest sessions', 'Maps', 'Universal/App Links', 'Privacy and store metadata', 'Device install smoke', 'Backward compatibility and rollback', 'Monitoring and ownership']
const ALLOWED_GATE_STATUSES = new Set(['PASS', 'BLOCKED', 'UNVERIFIED', 'FAIL'])
const FORBIDDEN_TRACKED_RELEASE_FILES = /(?:^|\/)(?:[^/]+\.(?:jks|keystore|p12|p8|pfx|pem|key|cer|crt|mobileprovision|provisionprofile)|keystore\.properties)$/i
const RESULT_PATH = /^docs\/mobile\/evidence\/issue-64\/(\d{4}-\d{2}-\d{2})\/([a-z0-9]+(?:-[a-z0-9]+)*)\/results\.json$/
const RESULT_SHAPE = /^docs\/mobile\/evidence\/issue-64\/([^/]+)\/([^/]+)\/results\.json$/
const REQUIRED_SOURCE_FILES = ['docs/mobile/auth-session-device-evidence.catalog.json', 'docs/mobile/auth-session-device-evidence.template.json', 'docs/mobile/auth-session-device-spike.md', 'docs/mobile/auth-session-transport-adr-template.md']
const ACCOUNT_DELETION_FILES = ['frontend/public/account-deletion.html', 'frontend/vercel.json']
const ACCOUNT_DELETION_URL = 'https://dupert.vercel.app/account-deletion'
const ACCOUNT_DELETION_TITLE = 'Delete your Dupert account'
const ACCOUNT_DELETION_DESCRIPTION = 'Learn how to permanently delete your Dupert account from the authenticated account settings.'
const ACCOUNT_DELETION_CTA = 'Sign in to delete your account'
const ACCOUNT_DELETION_STEPS = ['Sign in to your Dupert account.', 'Open Trips.', 'Open Account. On small screens, open the account menu first, then choose Account.', 'Select Delete account.', 'Type the exact lowercase word delete.', 'Enter your current password.', 'Confirm Delete account.']
const ACCOUNT_DELETION_SUMMARY = ['Deletion is permanent and cannot be undone.', 'Some content in shared trips may remain, including a guest name you used before signing in.']
const ACCOUNT_DELETION_CONSEQUENCES = ['Your account is permanently removed.', 'You are signed out on this device. Dupert cancels saved sign-ins, and other devices ask you to sign in again after their current access expires.', 'Trips you own with no other Dupert members are deleted.', 'Trips you own with other Dupert members are transferred to one of them.', 'Content in retained shared trips may remain.', 'Your signed-in Dupert name is removed from retained activity history, but a guest name you used before signing in may remain.', 'Share links you created and guest access that depends on them are removed.']
const EVIDENCE_KEYS = ['safe_reference', 'observed_result', 'network_trace_reference', 'artifact_identity_checksum', 'redaction_notes']
const CASE_KEYS = ['case_id', 'preconditions', 'actions', 'expected_outcome', 'cleanup', 'status', 'evidence']
const RAW_SECRET = /(?:authorization\s*[:=]\s*(?:bearer|basic)|x[-_]api[-_]key\s*[:=]|\bbearer\s+[a-z0-9._-]{20,}|\bbasic\s+[a-z0-9+/=]{12,}|\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]+\.|(?:access|refresh|guest|reset)[_-]?token\s*[:=]|verification[-_]code\s*[:=]|api[-_]?key\s*[:=]|(?:set-)?cookie\s*[:=]|password\s*[:=]\s*[^\s"']+|https?:\/\/[^\s"']+\/(?:reset|verify|verification)[^\s"']*|[?&](?:token|secret|api[-_]?key|password|code|reset[-_]?token|verification[-_]?code)=)/i
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const IMMUTABLE_DOCUMENT_HASHES = {
  'auth-session-device-spike.md': '7df8881bb4f581926fd99dc71a01ddeec80af5ff47300ad1057242c85a381a11',
  'auth-session-transport-adr-template.md': '9d8da67a404a53fa0e23b47915c1790d635493454b3d2150789c42955f8a8d81',
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

function inspectCatalog(catalog, violations) {
  const violationCount = violations.length
  if (!requireExactKeys(catalog, ['schema_version', 'platforms', 'contexts', 'adr'], 'device evidence catalog', violations)) return false
  if (catalog.schema_version !== 2) violations.push('device evidence catalog schema_version must be 2')
  if (!requireExactKeys(catalog.platforms, ['ios', 'android'], 'device evidence catalog platforms', violations)) return false
  if (!requireExactKeys(catalog.contexts, ['member', 'guest'], 'device evidence catalog contexts', violations)) return false
  for (const [platform, deviceType, platformCase] of [['ios', 'physical_iphone', 'ios_webview_domain_configuration'], ['android', 'physical_android', 'android_third_party_cookie_behavior']]) {
    if (requireExactKeys(catalog.platforms[platform], ['device_type', 'platform_case'], `catalog ${platform}`, violations) && (catalog.platforms[platform].device_type !== deviceType || catalog.platforms[platform].platform_case !== platformCase)) violations.push(`catalog ${platform} semantics are invalid`)
  }
  for (const context of ['member', 'guest']) if (requireExactKeys(catalog.contexts[context], ['cases', 'credential_lifecycle'], `catalog ${context}`, violations)) {
    for (const key of ['cases', 'credential_lifecycle']) if (!Array.isArray(catalog.contexts[context][key]) || !catalog.contexts[context][key].length || new Set(catalog.contexts[context][key]).size !== catalog.contexts[context][key].length) violations.push(`catalog ${context} ${key} must be a nonempty unique array`)
  }
  if (!requireExactKeys(catalog.adr, ['allowed_outcomes', 'forbidden_fallbacks'], 'catalog ADR', violations)) return false
  if (JSON.stringify(catalog.adr.allowed_outcomes) !== JSON.stringify(['cookie_only_proven', 'native_credential_transport']) || JSON.stringify(catalog.adr.forbidden_fallbacks) !== JSON.stringify(['endpoint_only_fallback', 'web_storage_refresh_or_guest_token_workaround'])) violations.push('catalog ADR semantics are invalid')
  return violations.length === violationCount
}

function inspectEvidence(value, label, options, violations) {
  const { template, platform, context, runId, platformChecksum, usedReferences } = options
  if (!template && RAW_SECRET.test(JSON.stringify(value))) violations.push(`${label} contains a raw credential or capture`)
  if (!requireExactKeys(value, EVIDENCE_KEYS, label, violations)) return
  if (template) {
    for (const key of EVIDENCE_KEYS) if (value[key] !== 'UNEXECUTED') violations.push(`${label} ${key} must remain UNEXECUTED`)
    return
  }
  for (const key of EVIDENCE_KEYS) if (typeof value[key] !== 'string' || !value[key].trim() || value[key] === 'UNEXECUTED') violations.push(`${label} ${key} must be a completed redaction-safe string`)
  const referencePattern = new RegExp(`^restricted://issue-64/${runId}/${platform}/${context}/[a-z0-9][a-z0-9._-]*$`)
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
  if (options.template ? entry.status !== 'UNEXECUTED' : entry.status !== 'PASS') violations.push(`${label} status must be PASS for a selected ADR decision`)
  for (const key of ['preconditions', 'actions', 'expected_outcome', 'cleanup']) if (options.template ? entry[key] !== 'UNEXECUTED' : typeof entry[key] !== 'string' || !entry[key].trim() || entry[key] === 'UNEXECUTED') violations.push(`${label} ${key} must be completed text`)
  inspectEvidence(entry.evidence, `${label} evidence`, { ...options, context: contextId }, violations)
  if (expectedId === 'offline_loss_reconnect_each_session_boundary') {
    if (!Array.isArray(entry.session_boundaries)) return violations.push(`${label} session_boundaries must be an array`)
    const expected = options.catalog.contexts[contextId].cases.filter((id) => id !== expectedId)
    exactIds(entry.session_boundaries, 'boundary', expected, `${label} session boundaries`, violations)
    for (const boundary of entry.session_boundaries) {
      if (!requireExactKeys(boundary, ['boundary', 'status', 'evidence'], `${label} boundary`, violations)) continue
      if (options.template ? boundary.status !== 'UNEXECUTED' : boundary.status !== 'PASS') violations.push(`${label} boundary status must be PASS for a selected ADR decision`)
      inspectEvidence(boundary.evidence, `${label} boundary evidence`, { ...options, context: contextId }, violations)
    }
  }
}

function inspectResults(document, label, template, violations, catalog, resultInfo = {}) {
  if (!template && RAW_SECRET.test(JSON.stringify(document))) violations.push(`${label} contains a raw credential or capture`)
  const topKeys = ['schema_version', 'template_status', 'notice', 'copy_results_to', 'result_status_vocabulary', 'platforms', 'redaction_policy', 'adr_contract', 'references']
  if (!requireExactKeys(document, topKeys, label, violations)) return
  if (document.schema_version !== 2) { violations.push(`${label} schema_version must be 2`); return }
  if (template && document.template_status !== 'UNEXECUTED') violations.push('device evidence template status must remain UNEXECUTED')
  if (!template && document.template_status !== 'COMPLETED') violations.push(`${label} template_status must be COMPLETED`)
  const expectedNotice = template ? 'TEMPLATE / NOT EVIDENCE — immutable source; JSON results are the sole claim-bearing artifact.' : 'COMPLETED RESULTS / CLAIM-BEARING ARTIFACT'
  if (document.notice !== expectedNotice) violations.push(`${label} notice must exactly match its contract marker`)
  if (document.copy_results_to !== 'docs/mobile/evidence/issue-64/YYYY-MM-DD/<lowercase-run-id>/results.json') violations.push(`${label} copy_results_to is invalid`)
  if (JSON.stringify(document.result_status_vocabulary) !== JSON.stringify(['UNEXECUTED', 'PASS', 'FAIL', 'BLOCKED', 'UNVERIFIED'])) violations.push(`${label} result status vocabulary is invalid`)
  if (!Array.isArray(document.platforms)) return violations.push(`${label} platforms must be an array`)
  const platformNames = Object.keys(catalog.platforms)
  exactIds(document.platforms, 'platform', platformNames, `${label} platforms`, violations)
  const usedReferences = new Set()
  const platformChecksums = new Set()
  const runCommits = new Set()
  const runVersions = new Set()
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
        const expectedRef = `restricted://issue-64/${resultInfo.runId}/${name}/attestation`
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
      const options = { template, platform: name, runId: resultInfo.runId, platformChecksum: platform.metadata?.artifact_identity_checksum, usedReferences, catalog }
      if (!Array.isArray(context.cases)) { violations.push(`${label} ${name} ${id} cases must be an array`); continue }
      exactIds(context.cases, 'case_id', catalog.contexts[id].cases, `${label} ${name} ${id} cases`, violations)
      for (const caseId of catalog.contexts[id].cases) { const entry = context.cases.find((x) => x?.case_id === caseId); if (entry) inspectCase(entry, caseId, `${label} ${name} ${id} ${caseId}`, id, options, violations) }
      if (!Array.isArray(context.credential_lifecycle)) { violations.push(`${label} ${name} ${id} lifecycle must be an array`); continue }
      exactIds(context.credential_lifecycle, 'stage_id', catalog.contexts[id].credential_lifecycle, `${label} ${name} ${id} lifecycle`, violations)
      for (const stage of context.credential_lifecycle) { if (!requireExactKeys(stage, ['stage_id', 'status', 'evidence'], `${label} ${name} ${id} lifecycle stage`, violations)) continue; if (template ? stage.status !== 'UNEXECUTED' : stage.status !== 'PASS') violations.push(`${label} ${name} ${id} lifecycle stage status must be PASS for a selected ADR decision`); inspectEvidence(stage.evidence, `${label} ${name} ${id} lifecycle evidence`, { ...options, context: id }, violations) }
    }
    if (!Array.isArray(platform.platform_cases)) { violations.push(`${label} ${name} platform_cases must be an array`); continue }
    const platformCase = catalog.platforms[name].platform_case
    exactIds(platform.platform_cases, 'case_id', [platformCase], `${label} ${name} platform cases`, violations)
    if (platform.platform_cases[0]) inspectCase(platform.platform_cases[0], platformCase, `${label} ${name} platform case`, 'platform', { template, platform: name, runId: resultInfo.runId, platformChecksum: platform.metadata?.artifact_identity_checksum, usedReferences, catalog }, violations)
  }
  if (!template && runCommits.size !== 1) violations.push(`${label} platforms must use the same commit_or_tag`)
  if (!template && runVersions.size !== 1) violations.push(`${label} platforms must use the same app_version`)
  if (!requireExactKeys(document.redaction_policy, ['raw_capture_policy', 'safe_reference_policy'], `${label} redaction policy`, violations) || !/never commit raw captures/i.test(document.redaction_policy.raw_capture_policy ?? '')) violations.push(`${label} must prohibit raw captures`)
  const adrKeys = ['selected_outcome', 'decision_artifact_reference', 'allowed_outcomes', 'forbidden_fallbacks']
  if (requireExactKeys(document.adr_contract, adrKeys, `${label} ADR contract`, violations)) {
    if (JSON.stringify(document.adr_contract.allowed_outcomes) !== JSON.stringify(catalog.adr.allowed_outcomes) || JSON.stringify(document.adr_contract.forbidden_fallbacks) !== JSON.stringify(catalog.adr.forbidden_fallbacks)) violations.push(`${label} ADR catalogs are invalid`)
    if (template) {
      for (const key of ['selected_outcome', 'decision_artifact_reference']) if (document.adr_contract[key] !== 'UNEXECUTED') violations.push(`${label} ADR ${key} must remain UNEXECUTED`)
    } else {
      if (typeof document.adr_contract.selected_outcome !== 'string' || !catalog.adr.allowed_outcomes.includes(document.adr_contract.selected_outcome)) violations.push(`${label} ADR selected_outcome must be exactly one approved scalar`)
      if (document.adr_contract.decision_artifact_reference !== `restricted://issue-64/${resultInfo.runId}/decision`) violations.push(`${label} ADR decision_artifact_reference must match the result run`)
    }
  }
  if (!requireExactKeys(document.references, ['catalog', 'spike', 'adr'], `${label} references`, violations) || document.references.catalog !== 'docs/mobile/auth-session-device-evidence.catalog.json' || document.references.spike !== 'docs/mobile/auth-session-device-spike.md' || document.references.adr !== 'docs/mobile/auth-session-transport-adr-template.md') violations.push(`${label} references are invalid`)
}
function inspectDeviceEvidenceContract(sources, violations) {
  const catalog = parseJsonDocument(sources.authSessionEvidenceCatalog, 'auth-session-device-evidence.catalog.json', violations)
  if (!catalog || !inspectCatalog(catalog, violations)) return
  const document = parseJsonDocument(sources.authSessionEvidenceTemplate, 'auth-session-device-evidence.template.json', violations)
  if (document) inspectResults(document, 'device evidence template', true, violations, catalog)
  marker(sources.authSessionDeviceSpike, 'issue64-spike-policy', { contract_version: '2', claim_bearing_artifact: 'results_json_only', immutable_template: 'true', raw_captures: 'external_restricted_only' }, violations)
  marker(sources.authSessionAdrTemplate, 'issue64-adr-policy', { contract_version: '2', allowed_outcomes: 'cookie_only_proven,native_credential_transport', forbidden_fallbacks: 'endpoint_only_fallback,web_storage_refresh_or_guest_token_workaround', decision_artifact: 'results_json_only' }, violations)
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
    for (const [path, raw] of Object.entries(sources.resultCopies ?? {})) { const match = path.match(RESULT_PATH); if (!match || !sources.trackedFiles.includes(path)) { violations.push(`result copy must be tracked at an authorized path: ${path}`); continue }; const result = parseJsonDocument(raw, path, violations); if (result) inspectResults(result, path, false, violations, catalog, { date: match[1], runId: match[2] }) }
  } else if (Object.keys(sources.resultCopies ?? {}).length) {
    for (const path of Object.keys(sources.resultCopies)) violations.push(`result copy must be tracked at an authorized path: ${path}`)
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
  const protectedSubject = /Authentication and guest sessions|Privacy and store metadata|Device install smoke|Physical-device evidence/i
  const protectedInstruction = new RegExp(`^\\s*(?:[-*]\\s*)?(?:${protectedSubject.source})\\s+must\\s+PASS(?:\\s+before\\s+(?:review|release))?\\.?\\s*$`, 'i')
  const remainingOutsideText = outsideGateTable.split('\n').filter((line) => !protectedInstruction.test(line)).join(' ').replace(/\s+/g, ' ')
  if (protectedSubject.test(remainingOutsideText)) violations.push('release-readiness contains protected status prose outside the canonical gate table')
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

function normalizedText(value) { return (value ?? '').replace(/\s+/g, ' ').trim() }
function elementIsHidden(element, window) {
  for (let current = element; current; current = current.parentElement) {
    const style = window.getComputedStyle(current)
    if (current.hidden || current.getAttribute('aria-hidden')?.toLowerCase() === 'true' || style.display === 'none' || style.visibility === 'hidden' || (style.opacity !== '' && Number(style.opacity) === 0)) return true
  }
  return false
}
function visibleElementText(element, window) {
  const collect = (node) => {
    if (node.nodeType === window.Node.TEXT_NODE) return node.nodeValue
    if (node.nodeType !== window.Node.ELEMENT_NODE || elementIsHidden(node, window)) return ''
    return [...node.childNodes].map(collect).join(' ')
  }
  return normalizedText(collect(element))
}
function accessibleElementText(element, document, window) {
  if (element.hasAttribute('aria-label')) return normalizedText(element.getAttribute('aria-label'))
  if (element.hasAttribute('aria-labelledby')) return normalizedText(element.getAttribute('aria-labelledby').split(/\s+/).map((id) => { const label = document.getElementById(id); return label && !elementIsHidden(label, window) ? visibleElementText(label, window) : '' }).join(' '))
  return visibleElementText(element, window)
}
function inspectExactList(list, expected, label, window, violations) {
  if (!list) return violations.push(`account-deletion resource ${label} list is missing`)
  const items = [...list.children]
  if (items.length !== expected.length || items.some((item) => item.tagName !== 'LI')) return violations.push(`account-deletion resource ${label} list must contain exactly ${expected.length} semantic items`)
  for (const [index, text] of expected.entries()) if (visibleElementText(items[index], window) !== text) violations.push(`account-deletion resource ${label} item ${index + 1} must equal: ${text}`)
}

function inspectAccountDeletionResource(sources, violations) {
  const source = sources.accountDeletionResource ?? ''
  marker(source, 'account-deletion-resource', {
    contract_version: '1',
    canonical_url: ACCOUNT_DELETION_URL,
    entry_path: '/login',
  }, violations)

  const dom = new JSDOM(source, { contentType: 'text/html' })
  const { document } = dom.window
  if (document.documentElement.lang !== 'en') violations.push('account-deletion resource html lang must be en')
  if (document.title !== ACCOUNT_DELETION_TITLE) violations.push(`account-deletion resource title must be ${ACCOUNT_DELETION_TITLE}`)
  const descriptions = document.querySelectorAll('meta[name="description"]')
  if (descriptions.length !== 1 || descriptions[0].getAttribute('content') !== ACCOUNT_DELETION_DESCRIPTION) violations.push('account-deletion resource description metadata is invalid')
  const viewports = document.querySelectorAll('meta[name="viewport"]')
  if (viewports.length !== 1 || viewports[0].getAttribute('content') !== 'width=device-width, initial-scale=1.0') violations.push('account-deletion resource viewport metadata is invalid')
  const canonicals = document.querySelectorAll('link[rel~="canonical"]')
  if (canonicals.length !== 1 || canonicals[0].getAttribute('href') !== ACCOUNT_DELETION_URL) violations.push(`account-deletion resource canonical link must be ${ACCOUNT_DELETION_URL}`)
  if (document.querySelector('script')) violations.push('account-deletion resource must not contain scripts')
  if (document.querySelector('form')) violations.push('account-deletion resource must not contain forms')
  if (document.querySelector('base, iframe, object, embed, [src], link:not([rel~="canonical"]), meta[http-equiv="refresh"]') || /@import\s|url\s*\(/i.test(source)) violations.push('account-deletion resource must not contain an external dependency')
  if ([...document.querySelectorAll('*')].some((element) => [...element.attributes].some((attribute) => /^on/i.test(attribute.name)))) violations.push('account-deletion resource must not contain inline event handlers')
  const allowedHrefs = new Set([ACCOUNT_DELETION_URL, '/login', '/login?mode=password-reset'])
  if ([...document.querySelectorAll('[href]')].some((element) => !allowedHrefs.has(element.getAttribute('href')))) violations.push('account-deletion resource contains a non-allowlisted href')

  const mains = document.querySelectorAll('main')
  if (mains.length !== 1 || elementIsHidden(mains[0], dom.window)) violations.push('account-deletion resource must contain exactly one visible main element')
  const main = mains[0]
  const headings = document.querySelectorAll('h1')
  if (headings.length !== 1 || !main?.contains(headings[0]) || elementIsHidden(headings[0], dom.window) || visibleElementText(headings[0], dom.window) !== ACCOUNT_DELETION_TITLE || accessibleElementText(headings[0], document, dom.window) !== ACCOUNT_DELETION_TITLE) violations.push(`account-deletion resource must contain exactly one visible h1 named ${ACCOUNT_DELETION_TITLE}`)

  const ctas = document.querySelectorAll('a[href="/login"]')
  const cta = ctas[0]
  if (ctas.length !== 1 || !cta || !main?.contains(cta) || elementIsHidden(cta, dom.window) || cta.tabIndex < 0 || visibleElementText(cta, dom.window) !== ACCOUNT_DELETION_CTA || accessibleElementText(cta, document, dom.window) !== ACCOUNT_DELETION_CTA) violations.push(`account-deletion resource must include one visible, focusable /login CTA named ${ACCOUNT_DELETION_CTA}`)
  const summary = document.querySelector('.deletion-summary')
  if (!summary || !main?.contains(summary) || !summary.matches('section, aside') || elementIsHidden(summary, dom.window) || ACCOUNT_DELETION_SUMMARY.some((text) => !visibleElementText(summary, dom.window).includes(text)) || (cta && !(summary.compareDocumentPosition(cta) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING))) violations.push('account-deletion resource must show the irreversible and retained-content summary before the sign-in CTA')
  const ctaNote = cta?.nextElementSibling
  if (!ctaNote || !ctaNote.matches('p.cta-note#sign-in-note') || cta?.getAttribute('aria-describedby') !== 'sign-in-note' || elementIsHidden(ctaNote, dom.window) || visibleElementText(ctaNote, dom.window) !== 'Signing in does not delete your account. You will review and confirm deletion in Account settings.') violations.push('account-deletion resource must associate the sign-in CTA with its non-deletion explanation')
  const recoveryLinks = document.querySelectorAll('a[href="/login?mode=password-reset"]')
  const recovery = recoveryLinks[0]
  if (recoveryLinks.length !== 1 || !recovery || !main?.contains(recovery) || elementIsHidden(recovery, dom.window) || recovery.tabIndex < 0 || visibleElementText(recovery, dom.window) !== 'Reset your password' || accessibleElementText(recovery, document, dom.window) !== 'Reset your password') violations.push('account-deletion resource must include one visible, focusable Reset your password link')

  const stepSection = document.querySelector('section[aria-labelledby="deletion-steps"]')
  inspectExactList(stepSection && main?.contains(stepSection) ? stepSection.querySelector(':scope > ol') : null, ACCOUNT_DELETION_STEPS, 'ordered steps', dom.window, violations)
  const consequenceSection = document.querySelector('section[aria-labelledby="deletion-results"]')
  inspectExactList(consequenceSection && main?.contains(consequenceSection) ? consequenceSection.querySelector(':scope > ul') : null, ACCOUNT_DELETION_CONSEQUENCES, 'consequences', dom.window, violations)
  dom.window.close()

  let config
  let configParsed = true
  try { config = JSON.parse(sources.vercelConfig) } catch { configParsed = false; violations.push('frontend/vercel.json must be valid JSON') }
  if (configParsed && requireObject(config, 'frontend/vercel.json', violations)) {
    for (const key of Object.keys(config)) if (!['rewrites', 'outputDirectory'].includes(key)) violations.push(`frontend/vercel.json contains unsupported top-level key: ${key}`)
    if ('outputDirectory' in config && config.outputDirectory !== 'dist') violations.push('frontend/vercel.json outputDirectory must be dist')
    if (!Array.isArray(config.rewrites)) {
      violations.push('frontend/vercel.json rewrites must be an array')
    } else {
      for (const [index, rewrite] of config.rewrites.entries()) if (requireExactKeys(rewrite, ['source', 'destination'], `Vercel rewrite ${index + 1}`, violations) && (typeof rewrite.source !== 'string' || !rewrite.source.startsWith('/') || typeof rewrite.destination !== 'string' || !rewrite.destination.startsWith('/'))) violations.push(`Vercel rewrite ${index + 1} source and destination must be absolute paths`)
      const deletionRewrites = config.rewrites.filter((rewrite) => rewrite?.source === '/account-deletion')
      const fallbackRewrites = config.rewrites.filter((rewrite) => rewrite?.source === '/(.*)')
      if (deletionRewrites.length !== 1) violations.push('Vercel account-deletion rewrite must appear exactly once')
      if (fallbackRewrites.length !== 1) violations.push('Vercel SPA fallback rewrite must appear exactly once')
      const deletionRewrite = deletionRewrites[0]
      const fallbackRewrite = fallbackRewrites[0]
      if (deletionRewrite && (!requireExactKeys(deletionRewrite, ['source', 'destination'], 'Vercel account-deletion rewrite', violations) || deletionRewrite.destination !== '/account-deletion.html')) violations.push('Vercel account-deletion rewrite destination must be /account-deletion.html')
      if (fallbackRewrite && (!requireExactKeys(fallbackRewrite, ['source', 'destination'], 'Vercel SPA fallback rewrite', violations) || fallbackRewrite.destination !== '/index.html')) violations.push('Vercel SPA fallback rewrite destination must be /index.html')
      if (deletionRewrite && config.rewrites.indexOf(deletionRewrite) !== 0) violations.push('Vercel account-deletion rewrite must be the first rewrite')
    }
  }

  if (!sources.releaseDocument.includes(ACCOUNT_DELETION_URL)) violations.push(`release-readiness account-deletion URL must be ${ACCOUNT_DELETION_URL}`)
  if ((sources.trackedFiles ?? []).length) for (const path of ACCOUNT_DELETION_FILES) if (!sources.trackedFiles.includes(path)) violations.push(`public account-deletion resource must be tracked: ${path}`)
}

export function loadTrackedResultCopies(repositoryRoot, trackedFiles = []) {
  const root = realpathSync(resolve(repositoryRoot))
  const copies = {}
  const violations = []
  for (const path of trackedFiles.filter((entry) => RESULT_PATH.test(entry))) {
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
    accountDeletionResource: read('frontend/public/account-deletion.html'),
    vercelConfig: read('frontend/vercel.json'),
    authSessionEvidenceCatalog: read('docs/mobile/auth-session-device-evidence.catalog.json'),
    authSessionEvidenceTemplate: read('docs/mobile/auth-session-device-evidence.template.json'),
    authSessionDeviceSpike: read('docs/mobile/auth-session-device-spike.md'),
    authSessionAdrTemplate: read('docs/mobile/auth-session-transport-adr-template.md'),
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
  marker(sources.releaseDocument, 'issue64-release-policy', { contract_version: '2', claim_bearing_artifact: 'results_json_only' }, violations)
  for (const requiredBlockedGate of ['Authentication and guest sessions', 'Device install smoke']) {
    const row = gateRows.find(([gate]) => gate === requiredBlockedGate)
    if (row && row[1] !== 'BLOCKED') violations.push(`${requiredBlockedGate} must remain BLOCKED until physical-device evidence is reviewed`)
  }
  const privacyGate = gateRows.find(([gate]) => gate === 'Privacy and store metadata')
  if (privacyGate && privacyGate[1] !== 'BLOCKED') violations.push('Privacy and store metadata must remain BLOCKED until deployed and store-review evidence is recorded')
  inspectAccountDeletionResource(sources, violations)
  inspectDeviceEvidenceContract(sources, violations)

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
