import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const TEMPLATE_PATH = 'docs/mobile/ios-map-device-evidence.template.json'
const RUNBOOK_PATH = 'docs/mobile/ios-map-device-spike.md'
const ADR_PATH = 'docs/mobile/ios-map-renderer-adr-template.md'
const RELEASE_PATH = 'docs/mobile/release-readiness.md'
const RESULT_PATH = /^docs\/mobile\/evidence\/issue-66-ios\/(\d{4}-\d{2}-\d{2})\/([a-z0-9]+(?:-[a-z0-9]+)*)\/results\.json$/
const GATE_IDS = [
  'native_renderer_and_restricted_key',
  'create_destroy_navigation',
  'background_resume_force_relaunch_orientation',
  'camera_markers_polylines_and_place_selection',
  'tabs_sheets_overlays_scrolling_and_gestures',
  'voiceover_and_failure_state_accessibility',
  'memory_and_map_ready_timing',
  'missing_rejected_key_and_network_failures',
]
const RESULT_VOCABULARY = ['UNEXECUTED', 'PASS', 'FAIL', 'BLOCKED', 'UNVERIFIED']
const ALLOWED_RENDERERS = ['native_google_maps_ios_qualified', 'native_google_maps_ios_rejected']
const RAW_CAPTURE = /AIza[a-zA-Z0-9_-]{20,}|data:image\/|\.(?:png|jpe?g|mov|mp4)\b|["']?(?:api|maps)[_-]?key["']?\s*:\s*["'][^"']+/i

function parseJson(source, label, violations) {
  try {
    return JSON.parse(source)
  } catch {
    violations.push(`${label} must be valid JSON`)
    return null
  }
}

function exactKeys(value, expected, label, violations) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    violations.push(`${label} must be an object`)
    return false
  }
  const actual = Object.keys(value).sort()
  const sortedExpected = [...expected].sort()
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    violations.push(`${label} must contain exactly: ${sortedExpected.join(', ')}`)
    return false
  }
  return true
}

function calendarDate(value) {
  const date = new Date(`${value}T00:00:00Z`)
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function rfc3339(value) {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value ?? '')
  return Boolean(match && calendarDate(match[1]) && Number(match[2]) <= 23 && Number(match[3]) <= 59 && Number(match[4]) <= 59 && (!match[5] || (Number(match[5]) <= 23 && Number(match[6]) <= 59)))
}

function marker(source, name, expected, violations) {
  const matches = [...source.matchAll(new RegExp(`<!-- ${name}\\n([\\s\\S]*?)\\n-->`, 'g'))]
  if (matches.length !== 1) return violations.push(`${name} marker must appear exactly once`)
  const entries = new Map()
  let malformed = false
  for (const line of matches[0][1].split('\n').filter(Boolean)) {
    const separator = line.indexOf('=')
    const key = line.slice(0, separator)
    if (separator <= 0 || !key || entries.has(key)) malformed = true
    else entries.set(key, line.slice(separator + 1))
  }
  if (malformed || entries.size !== Object.keys(expected).length || [...entries].some(([key, value]) => value !== expected[key])) {
    violations.push(`${name} marker is invalid`)
  }
}

function assertTemplateValue(value, label, violations) {
  if (value !== 'UNEXECUTED') violations.push(`${label} must remain UNEXECUTED in the source template`)
}

function safeReference(value, runId, label, violations) {
  if (typeof value !== 'string' || !new RegExp(`^restricted://issue-66-ios/${runId}/[a-z0-9][a-z0-9._/-]*$`).test(value)) {
    violations.push(`${label} must be a scoped restricted evidence reference`)
  }
}

function validateGates(gates, template, runId, violations) {
  if (!Array.isArray(gates) || gates.length !== GATE_IDS.length) return violations.push('map evidence gates must contain the complete ordered matrix')
  for (const [index, gate] of gates.entries()) {
    if (!exactKeys(gate, ['gate_id', 'status', 'evidence'], `map evidence gate ${index}`, violations)) continue
    if (gate.gate_id !== GATE_IDS[index]) violations.push(`map evidence gate ${index} must be ${GATE_IDS[index]}`)
    if (template) {
      assertTemplateValue(gate.status, `map evidence gate ${gate.gate_id} status`, violations)
      assertTemplateValue(gate.evidence, `map evidence gate ${gate.gate_id} evidence`, violations)
    } else {
      if (!['PASS', 'FAIL'].includes(gate.status)) violations.push(`map evidence gate ${gate.gate_id} must be PASS or FAIL after execution`)
      safeReference(gate.evidence, runId, `map evidence gate ${gate.gate_id} evidence`, violations)
    }
  }
}

function validatePlatform(platform, template, date, violations) {
  const keys = ['name', 'device_type', 'is_simulator', 'commit_or_tag', 'app_version', 'platform_build', 'device_model', 'os_version', 'tooling', 'staging_environment', 'tester_owner', 'tested_at', 'artifact_identity_checksum']
  if (!exactKeys(platform, keys, 'iOS map platform metadata', violations)) return
  if (platform.name !== 'ios') violations.push('iOS map platform metadata must name ios')
  if (template) {
    for (const key of keys.filter((key) => key !== 'name')) assertTemplateValue(platform[key], `iOS map platform ${key}`, violations)
    return
  }
  if (platform.device_type !== 'physical_iphone' || platform.is_simulator !== false) violations.push('iOS map results require a physical iPhone, not a simulator')
  for (const key of keys.filter((key) => !['name', 'is_simulator'].includes(key))) {
    if (typeof platform[key] !== 'string' || !platform[key].trim() || platform[key] === 'UNEXECUTED') violations.push(`iOS map platform ${key} must be completed`)
  }
  if (!rfc3339(platform.tested_at)) violations.push('iOS map platform tested_at must be RFC3339 with timezone')
  else if (platform.tested_at.slice(0, 10) !== date) violations.push('iOS map platform tested_at must match the result path date')
  if (!/^sha256:[a-f0-9]{64}$/i.test(platform.artifact_identity_checksum ?? '')) violations.push('iOS map platform artifact_identity_checksum must be sha256:<64 hex>')
}

function validateRestriction(restriction, template, runId, violations) {
  if (!exactKeys(restriction, ['status', 'restriction', 'safe_reference', 'redaction_notes'], 'iOS Maps external credential restriction', violations)) return
  if (template) {
    for (const key of Object.keys(restriction)) assertTemplateValue(restriction[key], `iOS Maps external credential ${key}`, violations)
    return
  }
  if (!['PASS', 'FAIL'].includes(restriction.status)) violations.push('iOS Maps external credential restriction must be PASS or FAIL after execution')
  for (const key of ['restriction', 'redaction_notes']) if (typeof restriction[key] !== 'string' || !restriction[key].trim() || restriction[key] === 'UNEXECUTED') violations.push(`iOS Maps external credential ${key} must be completed`)
  safeReference(restriction.safe_reference, runId, 'iOS Maps external credential safe_reference', violations)
}

function validateAdr(adr, gates, template, runId, violations) {
  if (!exactKeys(adr, ['selected_renderer', 'follow_up_scope', 'decision_artifact_reference', 'allowed_renderers'], 'iOS map ADR contract', violations)) return
  if (JSON.stringify(adr.allowed_renderers) !== JSON.stringify(ALLOWED_RENDERERS)) violations.push('iOS map ADR allowed renderers are invalid')
  if (template) {
    assertTemplateValue(adr.selected_renderer, 'iOS map ADR selected_renderer', violations)
    assertTemplateValue(adr.follow_up_scope, 'iOS map ADR follow_up_scope', violations)
    assertTemplateValue(adr.decision_artifact_reference, 'iOS map ADR decision_artifact_reference', violations)
    return
  }
  if (!ALLOWED_RENDERERS.includes(adr.selected_renderer)) violations.push('iOS map ADR must select exactly one allowed renderer')
  safeReference(adr.decision_artifact_reference, runId, 'iOS map ADR decision_artifact_reference', violations)
  const allPass = Array.isArray(gates) && gates.every((gate) => gate?.status === 'PASS')
  const hasFailure = Array.isArray(gates) && gates.some((gate) => gate?.status === 'FAIL')
  if (adr.selected_renderer === 'native_google_maps_ios_qualified' && !allPass) violations.push('qualified iOS native Maps requires every gate to PASS')
  if (adr.selected_renderer === 'native_google_maps_ios_rejected' && !hasFailure) violations.push('rejected iOS native Maps requires at least one failed gate')
  if (adr.selected_renderer === 'native_google_maps_ios_rejected' && (typeof adr.follow_up_scope !== 'string' || !adr.follow_up_scope.trim() || adr.follow_up_scope === 'UNEXECUTED')) violations.push('rejected iOS native Maps requires a bounded follow-up scope')
  if (adr.selected_renderer === 'native_google_maps_ios_qualified' && adr.follow_up_scope !== 'none') violations.push('qualified iOS native Maps must use follow_up_scope none')
}

function validateDocument(document, { template, date, runId }, violations) {
  const topKeys = ['schema_version', 'template_status', 'notice', 'copy_results_to', 'result_status_vocabulary', 'platform', 'external_key_restriction', 'gates', 'adr_contract', 'redaction_policy', 'references']
  if (!template && RAW_CAPTURE.test(JSON.stringify(document))) violations.push('iOS map evidence result contains a raw Maps credential or capture')
  if (!exactKeys(document, topKeys, template ? 'iOS map evidence template' : 'iOS map evidence result', violations)) return
  if (document.schema_version !== 1) violations.push('iOS map evidence schema_version must be 1')
  if (document.copy_results_to !== 'docs/mobile/evidence/issue-66-ios/YYYY-MM-DD/<lowercase-run-id>/results.json') violations.push('iOS map evidence copy_results_to is invalid')
  if (JSON.stringify(document.result_status_vocabulary) !== JSON.stringify(RESULT_VOCABULARY)) violations.push('iOS map evidence result status vocabulary is invalid')
  if (template) {
    if (document.template_status !== 'UNEXECUTED') violations.push('iOS map evidence template_status must remain UNEXECUTED')
    if (document.notice !== 'TEMPLATE / NOT EVIDENCE — immutable source; JSON results are the sole claim-bearing artifact.') violations.push('iOS map evidence template notice is invalid')
  } else {
    if (document.template_status !== 'COMPLETED') violations.push('iOS map evidence result template_status must be COMPLETED')
    if (document.notice !== 'COMPLETED RESULTS / CLAIM-BEARING ARTIFACT') violations.push('iOS map evidence result notice is invalid')
  }
  validatePlatform(document.platform, template, date, violations)
  validateRestriction(document.external_key_restriction, template, runId, violations)
  validateGates(document.gates, template, runId, violations)
  validateAdr(document.adr_contract, document.gates, template, runId, violations)
  if (template) assertTemplateValue(document.redaction_policy, 'iOS map evidence redaction_policy', violations)
  else if (typeof document.redaction_policy !== 'string' || !/restricted external/i.test(document.redaction_policy)) violations.push('iOS map evidence results must record the restricted-external redaction policy')
  if (!exactKeys(document.references, ['runbook', 'adr'], 'iOS map evidence references', violations)
    || document.references.runbook !== RUNBOOK_PATH
    || document.references.adr !== ADR_PATH) violations.push('iOS map evidence references are invalid')
}

export function inspectIosMapDeviceEvidence(sources) {
  const violations = []
  const template = parseJson(sources.template, TEMPLATE_PATH, violations)
  if (template) validateDocument(template, { template: true }, violations)
  marker(sources.runbook, 'issue66-ios-spike-policy', { contract_version: '1', claim_bearing_artifact: 'results_json_only', raw_captures: 'external_restricted_only', platform: 'ios_only' }, violations)
  marker(sources.adr, 'issue66-ios-adr-policy', { contract_version: '1', allowed_renderers: ALLOWED_RENDERERS.join(','), decision_artifact: 'results_json_only' }, violations)
  if (!sources.runbook.includes('> **TEMPLATE / NOT EVIDENCE**')) violations.push('iOS map spike runbook must be instruction-only')
  if (!sources.adr.includes('> **TEMPLATE / NOT EVIDENCE**')) violations.push('iOS map ADR template must be instruction-only')
  if (!sources.release.includes('ios-map-device-evidence.template.json')) violations.push('release readiness must reference the iOS map template')
  for (const [path, raw] of Object.entries(sources.resultCopies ?? {})) {
    const match = path.match(RESULT_PATH)
    if (!match || !sources.trackedFiles?.includes(path)) {
      violations.push(`iOS map result must be tracked at an authorized path: ${path}`)
      continue
    }
    if (!calendarDate(match[1])) {
      violations.push(`iOS map result path has an invalid date: ${path}`)
      continue
    }
    const result = parseJson(raw, path, violations)
    if (result) validateDocument(result, { template: false, date: match[1], runId: match[2] }, violations)
  }
  for (const path of sources.trackedFiles ?? []) {
    if (path.startsWith('docs/mobile/evidence/issue-66-ios/') && !RESULT_PATH.test(path)) violations.push(`iOS map evidence path is unauthorized: ${path}`)
  }
  return violations
}

export function assertIosMapDeviceEvidence(sources) {
  const violations = inspectIosMapDeviceEvidence(sources)
  if (violations.length > 0) throw new Error(`iOS map evidence contract failed:\n${violations.join('\n')}`)
}

function loadTrackedFiles() {
  return process.argv.includes('--tracked-files-stdin')
    ? readFileSync(0, 'utf8').split('\0').filter(Boolean)
    : []
}

function loadSources() {
  const read = (path) => readFileSync(resolve(ROOT, path), 'utf8')
  const trackedFiles = loadTrackedFiles()
  const resultCopies = Object.fromEntries(trackedFiles.filter((path) => RESULT_PATH.test(path)).map((path) => [path, read(path)]))
  return {
    template: read(TEMPLATE_PATH),
    runbook: read(RUNBOOK_PATH),
    adr: read(ADR_PATH),
    release: read(RELEASE_PATH),
    trackedFiles,
    resultCopies,
  }
}

const invokedPath = process.argv[1] && resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  assertIosMapDeviceEvidence(loadSources())
  console.log('PASS iOS map evidence source contract (renderer and device qualification remain blocked)')
}
