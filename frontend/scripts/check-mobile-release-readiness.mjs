import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REQUIRED_GATES = ['Repository contract', 'Artifact provenance', 'Signing and secrets', 'Identity and versioning', 'Production configuration', 'Authentication and guest sessions', 'Maps', 'Universal/App Links', 'Privacy and store metadata', 'Device install smoke', 'Backward compatibility and rollback', 'Monitoring and ownership']
const ALLOWED_GATE_STATUSES = new Set(['PASS', 'BLOCKED', 'UNVERIFIED', 'FAIL'])
const FORBIDDEN_TRACKED_RELEASE_FILES = /(?:^|\/)(?:[^/]+\.(?:jks|keystore|p12|p8|pfx|pem|key|cer|crt|mobileprovision|provisionprofile)|keystore\.properties)$/i
const RESULT_PATH = /^docs\/mobile\/evidence\/issue-64\/(\d{4}-\d{2}-\d{2})\/([a-z0-9]+(?:-[a-z0-9]+)*)\/results\.json$/
const RESULT_SHAPE = /^docs\/mobile\/evidence\/issue-64\/([^/]+)\/([^/]+)\/results\.json$/
const REQUIRED_SOURCE_FILES = ['docs/mobile/auth-session-device-evidence.template.json', 'docs/mobile/auth-session-device-spike.md', 'docs/mobile/auth-session-transport-adr-template.md']
const EVIDENCE_KEYS = ['safe_reference', 'observed_result', 'network_trace_reference', 'artifact_identity_checksum', 'redaction_notes']
const CASE_KEYS = ['case_id', 'preconditions', 'actions', 'expected_outcome', 'cleanup', 'status', 'evidence']
// Version-2 source of truth: each physical platform must independently execute these member and guest sets.
const CONTEXT_CASES = {
  member: ['member_login', 'access_token_expiry_refresh_rotation', 'background_resume', 'force_kill_relaunch', 'logout', 'account_deletion', 'email_verification_return', 'password_reset_return', 'trip_rest_read', 'trip_write', 'sse_streaming_genuine_without_global_native_http_patch', 'offline_loss_reconnect_each_session_boundary'],
  guest: ['guest_acceptance', 'background_resume', 'force_kill_relaunch', 'guest_relaunch', 'trip_rest_read', 'trip_write', 'sse_streaming_genuine_without_global_native_http_patch', 'guest_claim', 'guest_expiry', 'guest_revocation', 'offline_loss_reconnect_each_session_boundary'],
}
const CONTEXT_STAGES = { member: ['issued', 'stored', 'attached', 'rotated', 'revoked'], guest: ['issued', 'stored', 'attached', 'claimed', 'revoked'] }
const PLATFORM_CASE = { ios: 'ios_webview_domain_configuration', android: 'android_third_party_cookie_behavior' }
const RAW_SECRET = /(?:authorization\s*[:=]\s*bearer|\bbearer\s+[a-z0-9._-]{20,}|\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]+\.|(?:access|refresh|guest)[_-]?token\s*[:=]|(?:set-)?cookie\s*[:=]|[?&](?:token|secret|api[_-]?key|password)=)/i
const SAFE_ARTIFACT_REFERENCE = /^restricted:\/\/issue-64\/[a-z0-9][a-z0-9._-]*$/

function capture(text, pattern, label, violations) { const match = text.match(pattern); if (!match) { violations.push(`${label} is missing`); return null }; return match[1] }
function uniqueCaptures(text, pattern) { return [...new Set([...text.matchAll(pattern)].map((match) => match[1]))] }
function parseJsonDocument(raw, label, violations) { try { return JSON.parse(raw) } catch { violations.push(`${label} must be valid JSON`); return null } }
function requireObject(value, label, violations) { if (!value || typeof value !== 'object' || Array.isArray(value)) { violations.push(`${label} must be an object`); return false }; return true }
function requireExactKeys(value, keys, label, violations) { if (!requireObject(value, label, violations)) return false; const actual = Object.keys(value).sort(); const expected = [...keys].sort(); if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) { violations.push(`${label} must contain exactly: ${expected.join(', ')}`); return false }; return true }
function exactIds(entries, key, expected, label, violations) { const ids = entries.map((x) => x?.[key]); if (new Set(ids).size !== ids.length) violations.push(`${label} must not repeat ${key}s`); if (ids.length !== expected.length || ids.some((id) => !expected.includes(id))) violations.push(`${label} must contain exactly: ${expected.join(', ')}`) }
function marker(document, name, expected, violations) { const block = document.match(new RegExp(`<!-- ${name}\\n([\\s\\S]*?)\\n-->`)); if (!block) return violations.push(`${name} marker is missing`); const pairs = new Map(); for (const line of block[1].split('\n').filter(Boolean)) { const [key, ...values] = line.split('='); if (!key || !values.length || pairs.has(key)) violations.push(`${name} marker is malformed`); else pairs.set(key, values.join('=')) }; for (const [key, value] of Object.entries(expected)) if (pairs.get(key) !== value) violations.push(`${name} marker ${key} must equal ${value}`); if (pairs.size !== Object.keys(expected).length) violations.push(`${name} marker must not contain unknown fields`) }
function isCalendarDate(value) { const d = new Date(`${value}T00:00:00Z`); return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(d) && d.toISOString().slice(0, 10) === value }

function inspectEvidence(value, label, template, violations) {
  if (!template && RAW_SECRET.test(JSON.stringify(value))) violations.push(`${label} contains a raw credential or capture`)
  if (!requireExactKeys(value, EVIDENCE_KEYS, label, violations)) return
  if (template) {
    for (const key of EVIDENCE_KEYS) if (value[key] !== 'UNEXECUTED') violations.push(`${label} ${key} must remain UNEXECUTED`)
  } else {
    for (const key of EVIDENCE_KEYS) if (typeof value[key] !== 'string' || !value[key].trim() || value[key] === 'UNEXECUTED') violations.push(`${label} ${key} must be a completed redaction-safe string`)
    for (const key of ['safe_reference', 'network_trace_reference']) if (!SAFE_ARTIFACT_REFERENCE.test(value[key] ?? '')) violations.push(`${label} ${key} must be a restricted issue-64 artifact identifier`)
    if (!/^sha256:[a-f0-9]{64}$/i.test(value.artifact_identity_checksum)) violations.push(`${label} artifact_identity_checksum must be sha256:<64 hex>`)
  }
}
function inspectCase(entry, expectedId, label, template, violations) {
  const keys = expectedId === 'offline_loss_reconnect_each_session_boundary' ? [...CASE_KEYS, 'session_boundaries'] : CASE_KEYS
  if (!requireExactKeys(entry, keys, label, violations)) return
  if (entry.case_id !== expectedId) violations.push(`${label} case_id must be ${expectedId}`)
  for (const key of ['preconditions', 'actions', 'expected_outcome', 'cleanup', 'status']) {
    if (key === 'status' ? (template ? entry[key] !== 'UNEXECUTED' : !ALLOWED_GATE_STATUSES.has(entry[key])) : (template ? entry[key] !== 'UNEXECUTED' : typeof entry[key] !== 'string' || !entry[key].trim() || entry[key] === 'UNEXECUTED')) violations.push(`${label} ${key} is invalid`)
  }
  inspectEvidence(entry.evidence, `${label} evidence`, template, violations)
  if (expectedId === 'offline_loss_reconnect_each_session_boundary') {
    if (!Array.isArray(entry.session_boundaries)) return violations.push(`${label} session_boundaries must be an array`)
    const expected = label.includes('member') ? CONTEXT_CASES.member.filter((id) => id !== expectedId) : CONTEXT_CASES.guest.filter((id) => id !== expectedId)
    exactIds(entry.session_boundaries, 'boundary', expected, `${label} session boundaries`, violations)
    for (const boundary of entry.session_boundaries) { if (!requireExactKeys(boundary, ['boundary', 'status', 'evidence'], `${label} boundary`, violations)) continue; if (template ? boundary.status !== 'UNEXECUTED' : !ALLOWED_GATE_STATUSES.has(boundary.status)) violations.push(`${label} boundary status is invalid`); inspectEvidence(boundary.evidence, `${label} boundary evidence`, template, violations) }
  }
}
function inspectResults(document, label, template, violations) {
  if (!template && RAW_SECRET.test(JSON.stringify(document))) violations.push(`${label} contains a raw credential or capture`)
  const topKeys = ['schema_version', 'template_status', 'notice', 'copy_results_to', 'result_status_vocabulary', 'platforms', 'redaction_policy', 'adr_contract', 'references']
  if (!requireExactKeys(document, topKeys, label, violations) || document.schema_version !== 2) return
  if (template && document.template_status !== 'UNEXECUTED') violations.push('device evidence template status must remain UNEXECUTED')
  if (!template && document.template_status !== 'COMPLETED') violations.push(`${label} template_status must be COMPLETED`)
  if (!template && document.notice !== 'COMPLETED RESULTS / CLAIM-BEARING ARTIFACT') violations.push(`${label} notice must be the completed-results marker`)
  if (!template && /TEMPLATE\s*\/\s*NOT EVIDENCE/i.test(document.notice ?? '')) violations.push(`${label} notice must not claim TEMPLATE / NOT EVIDENCE`)
  if (!/TEMPLATE \/ NOT EVIDENCE/.test(document.notice ?? '') && template) violations.push('device evidence template must be prominently labeled TEMPLATE / NOT EVIDENCE')
  if (document.copy_results_to !== 'docs/mobile/evidence/issue-64/YYYY-MM-DD/<lowercase-run-id>/results.json') violations.push(`${label} copy_results_to is invalid`)
  if (JSON.stringify(document.result_status_vocabulary) !== JSON.stringify(['UNEXECUTED', 'PASS', 'FAIL', 'BLOCKED', 'UNVERIFIED'])) violations.push(`${label} result status vocabulary is invalid`)
  if (!Array.isArray(document.platforms)) return violations.push(`${label} platforms must be an array`)
  exactIds(document.platforms, 'platform', ['ios', 'android'], `${label} platforms`, violations)
  for (const platform of document.platforms) {
    const name = platform?.platform; if (!['ios', 'android'].includes(name)) continue
    if (!requireExactKeys(platform, ['platform', 'metadata', 'contexts', 'platform_cases'], `${label} ${name}`, violations)) continue
    const metadataKeys = ['device_type', 'is_simulator', 'is_emulator', 'commit_or_tag', 'app_version_build', 'device_model', 'os_version', 'tooling', 'staging_environment', 'test_date_time', 'tester_owner', 'artifact_identity_checksum']
    if (requireExactKeys(platform.metadata, metadataKeys, `${label} ${name} metadata`, violations)) {
      if (template) {
        for (const key of metadataKeys) if (platform.metadata[key] !== 'UNEXECUTED') violations.push(`${label} ${name} metadata ${key} must remain UNEXECUTED`)
      } else { if (platform.metadata.device_type !== (name === 'ios' ? 'physical_iphone' : 'physical_android') || platform.metadata.is_simulator !== false || platform.metadata.is_emulator !== false) violations.push(`${label} ${name} must record a physical device, not simulator/emulator`); for (const key of metadataKeys.slice(3)) if (typeof platform.metadata[key] !== 'string' || !platform.metadata[key].trim() || platform.metadata[key] === 'UNEXECUTED') violations.push(`${label} ${name} metadata ${key} is invalid`); if (!/^sha256:[a-f0-9]{64}$/i.test(platform.metadata.artifact_identity_checksum ?? '')) violations.push(`${label} ${name} metadata artifact_identity_checksum must be sha256:<64 hex>`); if (Number.isNaN(Date.parse(platform.metadata.test_date_time ?? '')) || !/^\d{4}-\d{2}-\d{2}T/.test(platform.metadata.test_date_time ?? '')) violations.push(`${label} ${name} metadata test_date_time must be an ISO timestamp`) }
    }
    if (!Array.isArray(platform.contexts)) { violations.push(`${label} ${name} contexts must be an array`); continue }
    exactIds(platform.contexts, 'context_id', ['member', 'guest'], `${label} ${name} contexts`, violations)
    for (const context of platform.contexts) { const id = context?.context_id; if (!CONTEXT_CASES[id] || !requireExactKeys(context, ['context_id', 'cases', 'credential_lifecycle'], `${label} ${name} ${id}`, violations)) continue; if (!Array.isArray(context.cases)) { violations.push(`${label} ${name} ${id} cases must be an array`); continue }; exactIds(context.cases, 'case_id', CONTEXT_CASES[id], `${label} ${name} ${id} cases`, violations); for (const caseId of CONTEXT_CASES[id]) { const entry = context.cases.find((x) => x?.case_id === caseId); if (entry) inspectCase(entry, caseId, `${label} ${name} ${id} ${caseId}`, template, violations) }; if (!Array.isArray(context.credential_lifecycle)) { violations.push(`${label} ${name} ${id} lifecycle must be an array`); continue }; exactIds(context.credential_lifecycle, 'stage_id', CONTEXT_STAGES[id], `${label} ${name} ${id} lifecycle`, violations); for (const stage of context.credential_lifecycle) { if (!requireExactKeys(stage, ['stage_id', 'status', 'evidence'], `${label} ${name} ${id} lifecycle stage`, violations)) continue; if (template ? stage.status !== 'UNEXECUTED' : !ALLOWED_GATE_STATUSES.has(stage.status)) violations.push(`${label} ${name} ${id} lifecycle stage status is invalid`); inspectEvidence(stage.evidence, `${label} ${name} ${id} lifecycle evidence`, template, violations) } }
    if (!Array.isArray(platform.platform_cases)) { violations.push(`${label} ${name} platform_cases must be an array`); continue }; exactIds(platform.platform_cases, 'case_id', [PLATFORM_CASE[name]], `${label} ${name} platform cases`, violations); if (platform.platform_cases[0]) inspectCase(platform.platform_cases[0], PLATFORM_CASE[name], `${label} ${name} platform case`, template, violations)
  }
  if (!requireExactKeys(document.redaction_policy, ['raw_capture_policy', 'safe_reference_policy'], `${label} redaction policy`, violations) || !/never commit raw captures/i.test(document.redaction_policy.raw_capture_policy ?? '')) violations.push(`${label} must prohibit raw captures`)
  if (!requireExactKeys(document.adr_contract, ['allowed_outcomes', 'forbidden_fallbacks'], `${label} ADR contract`, violations) || JSON.stringify(document.adr_contract.allowed_outcomes) !== JSON.stringify(['cookie_only_proven', 'native_credential_transport']) || JSON.stringify(document.adr_contract.forbidden_fallbacks) !== JSON.stringify(['endpoint_only_fallback', 'web_storage_refresh_or_guest_token_workaround'])) violations.push(`${label} ADR contract is invalid`)
  if (!requireExactKeys(document.references, ['spike', 'adr'], `${label} references`, violations) || document.references.spike !== 'docs/mobile/auth-session-device-spike.md' || document.references.adr !== 'docs/mobile/auth-session-transport-adr-template.md') violations.push(`${label} references are invalid`)
}
function inspectDeviceEvidenceContract(sources, violations) {
  const document = parseJsonDocument(sources.authSessionEvidenceTemplate, 'auth-session-device-evidence.template.json', violations)
  if (document) inspectResults(document, 'device evidence template', true, violations)
  marker(sources.authSessionDeviceSpike, 'issue64-spike-policy', { contract_version: '2', claim_bearing_artifact: 'results_json_only', immutable_template: 'true', raw_captures: 'external_restricted_only' }, violations)
  marker(sources.authSessionAdrTemplate, 'issue64-adr-policy', { contract_version: '2', allowed_outcomes: 'cookie_only_proven,native_credential_transport', forbidden_fallbacks: 'endpoint_only_fallback,web_storage_refresh_or_guest_token_workaround', decision_artifact: 'results_json_only' }, violations)
  if (!sources.releaseDocument.includes('auth-session-device-evidence.template.json')) violations.push('release-readiness must reference issue #64 template')
  if ((sources.trackedFiles ?? []).length) {
    for (const source of REQUIRED_SOURCE_FILES) if (!sources.trackedFiles.includes(source)) violations.push(`immutable issue #64 source must be tracked: ${source}`)
    for (const path of sources.trackedFiles) { const match = path.match(RESULT_PATH); const shape = path.match(RESULT_SHAPE); if (shape && (!isCalendarDate(shape[1]) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(shape[2]))) violations.push(`tracked issue #64 evidence path has invalid date or run ID: ${path}`); else if (path.startsWith('docs/mobile/evidence/issue-64/') && !match) violations.push(`tracked issue #64 evidence path is unauthorized: ${path}`) }
    for (const path of sources.trackedFiles.filter((path) => RESULT_PATH.test(path))) if (!(path in (sources.resultCopies ?? {}))) violations.push(`tracked issue #64 result copy could not be safely read: ${path}`)
    for (const [path, raw] of Object.entries(sources.resultCopies ?? {})) { const result = parseJsonDocument(raw, path, violations); if (result) inspectResults(result, path, false, violations) }
  }
}
function parseContract(document, violations) {
  const block = document.match(/<!-- mobile-release-contract\n([\s\S]*?)\n-->/)
  if (!block) {
    violations.push('release-readiness document is missing the machine-readable toolchain contract')
    return new Map()
  }

  const contract = new Map()
  for (const line of block[1].split('\n').map((entry) => entry.trim()).filter(Boolean)) {
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
  const block = document.match(
    /<!-- mobile-release-gates:start -->([\s\S]*?)<!-- mobile-release-gates:end -->/,
  )
  if (!block) {
    violations.push('release-readiness document is missing the release-gate table markers')
    return []
  }

  const lines = block[1].split('\n').map((line) => line.trim()).filter((line) => line.startsWith('|'))
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

export function loadMobileReleaseSources(repositoryRoot, trackedFiles = []) {
  const root = resolve(repositoryRoot)
  const read = (path) => readFileSync(resolve(root, path), 'utf8')

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
    authSessionEvidenceTemplate: read('docs/mobile/auth-session-device-evidence.template.json'),
    authSessionDeviceSpike: read('docs/mobile/auth-session-device-spike.md'),
    authSessionAdrTemplate: read('docs/mobile/auth-session-transport-adr-template.md'),
    resultCopies: Object.fromEntries(trackedFiles.filter((path) => RESULT_PATH.test(path)).map((path) => [path, read(path)])),
    trackedFiles,
  }
}

export function inspectMobileReleaseReadiness(sources) {
  const violations = []
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
  inspectDeviceEvidenceContract(sources, violations)

  for (const path of sources.trackedFiles ?? []) {
    if (FORBIDDEN_TRACKED_RELEASE_FILES.test(path)) {
      violations.push(`tracked release credential material is forbidden: ${path}`)
    }
  }

  return violations
}

export function assertMobileReleaseReadiness(repositoryRoot, trackedFiles) {
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
