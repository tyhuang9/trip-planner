import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const TEMPLATE_PATH = 'docs/mobile/ios-beta-release-readiness.template.json'
const RUNBOOK_PATH = 'docs/mobile/ios-beta-release-readiness-runbook.md'
const RESULT_PATH = /^docs\/mobile\/evidence\/ios-beta-release-readiness\/(\d{4}-\d{2}-\d{2})\/([a-z0-9]+(?:-[a-z0-9]+)*)\/results\.json$/
const CHECK_IDS = [
  'auth_device_matrix_and_adr',
  'map_renderer_and_restricted_key',
  'universal_links_hosted_signed_and_device',
  'signed_archive_provenance_and_install',
  'privacy_support_deletion_and_store_metadata',
  'previous_build_current_staging_smoke',
  'rollback_monitoring_and_escalation',
]
const RAW_OR_ARTIFACT = /(?:authorization\s*[:=]|\bbearer\s+[a-z0-9._-]{12,}|\beyJ[a-z0-9_-]{10,}\.|(?:password|cookie|token|api[_-]?key)\s*[:=]|https?:\/\/[^\s"']+\/(?:reset|verify)[^\s"']*|\.xcarchive\b|\.ipa\b|\.(?:png|jpe?g|mov|mp4)\b)/i

function parse(source, label, violations) {
  try { return JSON.parse(source) } catch { violations.push(`${label} must be valid JSON`); return null }
}

function exactKeys(value, expected, label, violations) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { violations.push(`${label} must be an object`); return false }
  const actual = Object.keys(value).sort()
  const target = [...expected].sort()
  if (actual.length !== target.length || actual.some((key, index) => key !== target[index])) { violations.push(`${label} must contain exactly: ${target.join(', ')}`); return false }
  return true
}

function date(value) {
  const parsed = new Date(`${value}T00:00:00Z`)
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value)
}

function marker(source, violations) {
  const matches = [...source.matchAll(/<!-- ios-beta-readiness-policy\n([\s\S]*?)\n-->/g)]
  if (matches.length !== 1) return violations.push('ios-beta-readiness-policy marker must appear exactly once')
  const expected = new Map([['contract_version', '1'], ['claim_bearing_artifact', 'results_json_only'], ['platform', 'ios_only']])
  const actual = new Map(matches[0][1].split('\n').filter(Boolean).map((line) => {
    const separator = line.indexOf('=')
    return [line.slice(0, separator), line.slice(separator + 1)]
  }))
  if (actual.size !== expected.size || [...expected].some(([key, value]) => actual.get(key) !== value)) violations.push('ios-beta-readiness-policy marker is invalid')
}

function restrictedReference(value, runId, label, violations) {
  if (typeof value !== 'string' || !new RegExp(`^restricted://ios-beta-release-readiness/${runId}/[a-z0-9][a-z0-9._/-]*$`).test(value)) violations.push(`${label} must be a scoped restricted evidence reference`)
}

function validate(document, { template, runId }, violations) {
  const top = ['schema_version', 'template_status', 'notice', 'copy_results_to', 'platform', 'release_roles', 'checks', 'go_no_go', 'redaction_policy', 'references']
  if (!template && RAW_OR_ARTIFACT.test(JSON.stringify(document))) violations.push('iOS beta result contains a raw secret, capture, or artifact')
  if (!exactKeys(document, top, template ? 'iOS beta template' : 'iOS beta result', violations)) return
  if (document.schema_version !== 1 || document.platform !== 'ios') violations.push('iOS beta document schema or platform is invalid')
  if (document.copy_results_to !== 'docs/mobile/evidence/ios-beta-release-readiness/YYYY-MM-DD/<lowercase-run-id>/results.json') violations.push('iOS beta result path declaration is invalid')
  if (template) {
    if (document.template_status !== 'UNEXECUTED' || document.go_no_go !== 'UNEXECUTED' || document.redaction_policy !== 'UNEXECUTED') violations.push('iOS beta template must remain unexecuted')
    if (document.notice !== 'TEMPLATE / NOT EVIDENCE — immutable source; JSON results are the sole claim-bearing artifact.') violations.push('iOS beta template notice is invalid')
  } else {
    if (document.template_status !== 'COMPLETED') violations.push('iOS beta result must be marked COMPLETED')
    if (document.notice !== 'COMPLETED RESULTS / CLAIM-BEARING ARTIFACT') violations.push('iOS beta result notice is invalid')
    if (!['GO', 'NO_GO'].includes(document.go_no_go)) violations.push('iOS beta result must select GO or NO_GO')
    if (typeof document.redaction_policy !== 'string' || !/restricted/i.test(document.redaction_policy)) violations.push('iOS beta result must state a restricted redaction policy')
  }
  const roles = ['release_owner', 'go_no_go_approver', 'support_owner', 'monitoring_owner']
  if (exactKeys(document.release_roles, roles, 'iOS beta release roles', violations)) for (const role of roles) {
    const value = document.release_roles[role]
    if (template ? value !== 'UNEXECUTED' : typeof value !== 'string' || !value.trim() || value === 'UNEXECUTED') violations.push(`iOS beta release role ${role} is invalid`)
  }
  if (!Array.isArray(document.checks) || document.checks.length !== CHECK_IDS.length) violations.push('iOS beta checks must contain the complete ordered checklist')
  else for (const [index, check] of document.checks.entries()) {
    if (!exactKeys(check, ['check_id', 'status', 'restricted_evidence_reference', 'summary'], `iOS beta check ${index}`, violations)) continue
    if (check.check_id !== CHECK_IDS[index]) violations.push(`iOS beta check ${index} is incorrect`)
    if (template) {
      for (const key of ['status', 'restricted_evidence_reference', 'summary']) if (check[key] !== 'UNEXECUTED') violations.push(`iOS beta check ${check.check_id} must remain unexecuted`)
    } else {
      if (!['PASS', 'FAIL', 'BLOCKED', 'UNVERIFIED'].includes(check.status)) violations.push(`iOS beta check ${check.check_id} has invalid completed status`)
      restrictedReference(check.restricted_evidence_reference, runId, `iOS beta check ${check.check_id}`, violations)
      if (typeof check.summary !== 'string' || !check.summary.trim() || check.summary === 'UNEXECUTED') violations.push(`iOS beta check ${check.check_id} requires a summary`)
    }
  }
  if (!exactKeys(document.references, ['runbook'], 'iOS beta references', violations) || document.references.runbook !== RUNBOOK_PATH) violations.push('iOS beta references are invalid')
  if (!template && document.go_no_go === 'GO' && document.checks.some((check) => check?.status !== 'PASS')) violations.push('iOS beta GO requires every check to PASS')
}

export function inspectIosBetaReleaseReadiness(sources) {
  const violations = []
  const template = parse(sources.template, TEMPLATE_PATH, violations)
  if (template) validate(template, { template: true }, violations)
  marker(sources.runbook, violations)
  if (!sources.runbook.includes('> **TEMPLATE / NOT EVIDENCE**')) violations.push('iOS beta runbook must be instruction-only')
  for (const [path, source] of Object.entries(sources.resultCopies ?? {})) {
    const match = path.match(RESULT_PATH)
    if (!match || !sources.trackedFiles?.includes(path) || !date(match[1])) { violations.push(`iOS beta result is not at an authorized dated path: ${path}`); continue }
    const result = parse(source, path, violations)
    if (result) validate(result, { template: false, runId: match[2] }, violations)
  }
  for (const path of sources.trackedFiles ?? []) if (path.startsWith('docs/mobile/evidence/ios-beta-release-readiness/') && !RESULT_PATH.test(path)) violations.push(`iOS beta evidence path is unauthorized: ${path}`)
  return violations
}

export function assertIosBetaReleaseReadiness(sources) {
  const violations = inspectIosBetaReleaseReadiness(sources)
  if (violations.length > 0) throw new Error(`iOS beta release-readiness contract failed:\n${violations.join('\n')}`)
}

function loadSources() {
  const read = (path) => readFileSync(resolve(ROOT, path), 'utf8')
  const trackedFiles = process.argv.includes('--tracked-files-stdin') ? readFileSync(0, 'utf8').split('\0').filter(Boolean) : []
  return { template: read(TEMPLATE_PATH), runbook: read(RUNBOOK_PATH), trackedFiles, resultCopies: Object.fromEntries(trackedFiles.filter((path) => RESULT_PATH.test(path)).map((path) => [path, read(path)])) }
}

const invokedPath = process.argv[1] && resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  assertIosBetaReleaseReadiness(loadSources())
  console.log('PASS iOS beta release-readiness source contract (external release gate remains blocked)')
}
