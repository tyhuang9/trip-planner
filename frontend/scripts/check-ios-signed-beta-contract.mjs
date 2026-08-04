import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const TEMPLATE_PATH = 'docs/mobile/ios-signed-beta-evidence.template.json'
const RUNBOOK_PATH = 'docs/mobile/ios-signed-beta-runbook.md'
const INSPECTOR_PATH = 'frontend/scripts/check-ios-signed-archive.mjs'

function marker(source, name, expected, violations) {
  const matches = [...source.matchAll(new RegExp(`<!-- ${name}\\n([\\s\\S]*?)\\n-->`, 'g'))]
  if (matches.length !== 1) return violations.push(`${name} marker must appear exactly once`)
  const entries = new Map()
  for (const line of matches[0][1].split('\n').filter(Boolean)) {
    const separator = line.indexOf('=')
    if (separator <= 0 || entries.has(line.slice(0, separator))) return violations.push(`${name} marker is malformed`)
    entries.set(line.slice(0, separator), line.slice(separator + 1))
  }
  if (entries.size !== Object.keys(expected).length || [...entries].some(([key, value]) => value !== expected[key])) violations.push(`${name} marker is invalid`)
}

function unexecuted(value, label, violations) {
  if (value !== 'UNEXECUTED') violations.push(`${label} must remain UNEXECUTED in the source template`)
}

export function inspectIosSignedBetaContract(sources) {
  const violations = []
  let template
  try { template = JSON.parse(sources.template) } catch { violations.push('iOS signed beta template must be valid JSON'); return violations }
  const expectedTop = ['schema_version', 'template_status', 'notice', 'copy_results_to', 'artifact', 'archive_inspection', 'device_smoke', 'redaction_policy', 'references']
  const actualTop = Object.keys(template).sort()
  if (actualTop.length !== expectedTop.length || actualTop.some((key, index) => key !== expectedTop.sort()[index])) violations.push('iOS signed beta template has unexpected fields')
  if (template.schema_version !== 1) violations.push('iOS signed beta template schema_version must be 1')
  if (template.notice !== 'TEMPLATE / NOT EVIDENCE — immutable source; JSON results are the sole claim-bearing artifact.') violations.push('iOS signed beta template notice is invalid')
  if (template.copy_results_to !== 'docs/mobile/evidence/ios-signed-beta/YYYY-MM-DD/<lowercase-run-id>/results.json') violations.push('iOS signed beta template result path is invalid')
  unexecuted(template.template_status, 'iOS signed beta template_status', violations)
  for (const [section, keys] of Object.entries({
    artifact: ['commit_or_tag', 'version', 'build', 'xcode_version', 'macos_version', 'archive_sha256', 'ipa_sha256', 'certificate_fingerprint', 'signing_channel', 'restricted_evidence_reference'],
    archive_inspection: ['status', 'bundle_identity', 'entitlements', 'production_api_origin', 'privacy_manifest', 'native_dependencies', 'development_endpoint_scan', 'browser_value_scan', 'restricted_evidence_reference'],
    device_smoke: ['member', 'guest', 'restricted_evidence_reference'],
  })) {
    const value = template[section]
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
      violations.push(`iOS signed beta ${section} fields are invalid`)
      continue
    }
    for (const key of keys) unexecuted(value[key], `iOS signed beta ${section}.${key}`, violations)
  }
  unexecuted(template.redaction_policy, 'iOS signed beta redaction_policy', violations)
  if (!template.references || template.references.runbook !== RUNBOOK_PATH || Object.keys(template.references).length !== 1) violations.push('iOS signed beta references are invalid')
  marker(sources.runbook, 'ios-signed-beta-policy', { contract_version: '1', claim_bearing_artifact: 'results_json_only', secrets: 'external_controlled_keychain_only' }, violations)
  if (!sources.runbook.includes('> **TEMPLATE / NOT EVIDENCE**')) violations.push('iOS signed beta runbook must be instruction-only')
  if (/^\s*xcodebuild\b.*-allowProvisioningUpdates/m.test(sources.runbook)) violations.push('iOS signed beta runbook must prohibit automatic provisioning updates without invoking them')
  if (!sources.inspector.includes('inspectIosArchiveMachO') || !sources.inspector.includes('assertPackagedNativeBundlePolicy')) violations.push('signed archive inspector must reuse existing native archive and bundle policies')
  if (!sources.release.includes('ios-signed-beta-evidence.template.json')) violations.push('release readiness must reference the iOS signed beta template')
  if (!sources.packageJson.includes('check:ios-signed-beta-contract')) violations.push('frontend package must expose the iOS signed beta contract check')
  for (const path of sources.trackedFiles ?? []) {
    if (/(?:^|\/)[^/]+\.(?:p12|p8|pem|key|cer|crt|mobileprovision|provisionprofile|ipa)$/i.test(path) || /\.xcarchive(?:\/|$)/i.test(path)) violations.push('tracked signing input or artifact is forbidden')
  }
  return violations
}

export function assertIosSignedBetaContract(sources) {
  const violations = inspectIosSignedBetaContract(sources)
  if (violations.length > 0) throw new Error(`iOS signed beta contract failed:\n${violations.join('\n')}`)
}

function loadSources() {
  const read = (path) => readFileSync(resolve(ROOT, path), 'utf8')
  const trackedFiles = process.argv.includes('--tracked-files-stdin') ? readFileSync(0, 'utf8').split('\0').filter(Boolean) : []
  return {
    template: read(TEMPLATE_PATH),
    runbook: read(RUNBOOK_PATH),
    inspector: read(INSPECTOR_PATH),
    release: read('docs/mobile/release-readiness.md'),
    packageJson: read('frontend/package.json'),
    trackedFiles,
  }
}

const invokedPath = process.argv[1] && resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  assertIosSignedBetaContract(loadSources())
  console.log('PASS iOS signed beta source contract (controlled signing and device evidence remain blocked)')
}
