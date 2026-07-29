import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REQUIRED_GATES = [
  'Repository contract',
  'Artifact provenance',
  'Signing and secrets',
  'Identity and versioning',
  'Production configuration',
  'Authentication and guest sessions',
  'Maps',
  'Universal/App Links',
  'Privacy and store metadata',
  'Device install smoke',
  'Backward compatibility and rollback',
  'Monitoring and ownership',
]

const ALLOWED_GATE_STATUSES = new Set(['PASS', 'BLOCKED', 'UNVERIFIED', 'FAIL'])
const FORBIDDEN_TRACKED_RELEASE_FILES = /(?:^|\/)(?:[^/]+\.(?:jks|keystore|p12|p8|pfx|pem|key|cer|crt|mobileprovision|provisionprofile)|keystore\.properties)$/i
const REQUIRED_DEVICE_PLATFORMS = new Map([
  ['ios', ['commit_or_tag', 'app_version_build', 'device_model', 'os_version', 'ios_xcode_macos_tooling', 'staging_environment', 'test_date_time', 'tester_owner', 'artifact_identity_checksum']],
  ['android', ['commit_or_tag', 'app_version_build', 'device_model', 'os_version', 'android_adb_tooling', 'staging_environment', 'test_date_time', 'tester_owner', 'artifact_identity_checksum']],
])
const SHARED_DEVICE_CASE_IDS = [
  'member_login',
  'access_token_expiry_refresh_rotation',
  'background_resume',
  'force_kill_relaunch',
  'logout',
  'account_deletion',
  'email_verification_return',
  'password_reset_return',
  'guest_acceptance',
  'trip_rest_read',
  'trip_write',
  'sse_streaming_genuine_without_global_native_http_patch',
  'guest_relaunch',
  'guest_claim',
  'guest_expiry',
  'guest_revocation',
  'offline_loss_reconnect_each_session_boundary',
]
const PLATFORM_ONLY_CASE_IDS = new Map([
  ['ios', ['ios_webview_domain_configuration']],
  ['android', ['android_third_party_cookie_behavior']],
])
const REQUIRED_OFFLINE_SESSION_BOUNDARIES = [
  'member_login',
  'access_token_expiry_refresh_rotation',
  'background_resume',
  'force_kill_relaunch',
  'logout',
  'account_deletion',
  'email_verification_return',
  'password_reset_return',
  'guest_acceptance',
  'trip_rest_read',
  'trip_write',
  'sse_streaming',
  'guest_relaunch',
  'guest_claim',
  'guest_expiry',
  'guest_revocation',
]
const REQUIRED_CREDENTIAL_LIFECYCLE_STAGES = ['issued', 'stored', 'attached', 'rotated', 'claimed', 'revoked']
const REQUIRED_EVIDENCE_FIELDS = ['safe_reference', 'observed_result', 'network_trace_reference', 'artifact_identity_checksum', 'redaction_notes']
const REQUIRED_ADR_OPTIONS = ['cookie_only_proven', 'native_credential_transport']
const REQUIRED_ADR_FORBIDDEN_FALLBACKS = ['endpoint_only_fallback', 'web_storage_refresh_or_guest_token_workaround']

function capture(text, pattern, label, violations) {
  const match = text.match(pattern)
  if (!match) {
    violations.push(`${label} is missing`)
    return null
  }
  return match[1]
}

function uniqueCaptures(text, pattern) {
  return [...new Set([...text.matchAll(pattern)].map((match) => match[1]))]
}

function parseJsonDocument(raw, label, violations) {
  try {
    return JSON.parse(raw)
  } catch {
    violations.push(`${label} must be valid JSON`)
    return null
  }
}

function requireUnexecuted(value, label, violations) {
  if (value !== 'UNEXECUTED') violations.push(`${label} must remain UNEXECUTED`)
}

function requireObject(value, label, violations) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    violations.push(`${label} must be an object`)
    return false
  }
  return true
}

function requireExactKeys(value, keys, label, violations) {
  if (!requireObject(value, label, violations)) return false
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    violations.push(`${label} must contain exactly: ${expected.join(', ')}`)
    return false
  }
  return true
}

function inspectEvidence(evidence, label, violations) {
  if (!requireExactKeys(evidence, REQUIRED_EVIDENCE_FIELDS, label, violations)) return
  for (const field of REQUIRED_EVIDENCE_FIELDS) {
    requireUnexecuted(evidence[field], `${label} ${field}`, violations)
  }
}

function requireExactIds(entries, actualIds, expectedIds, label, violations) {
  if (new Set(actualIds).size !== entries.length) violations.push(`${label} must not repeat IDs`)
  if (actualIds.length !== expectedIds.length || actualIds.some((id) => !expectedIds.includes(id))) {
    violations.push(`${label} must contain exactly: ${expectedIds.join(', ')}`)
  }
}

function inspectDeviceEvidenceContract(sources, violations) {
  const document = parseJsonDocument(
    sources.authSessionEvidenceTemplate,
    'auth-session-device-evidence.template.json',
    violations,
  )
  if (!document) return

  requireUnexecuted(document.template_status, 'device evidence template status', violations)
  requireExactKeys(document, ['template_status', 'notice', 'copy_results_to', 'result_status_vocabulary', 'platforms', 'redaction_policy', 'adr_contract', 'references'], 'device evidence template', violations)
  const expectedResultStatuses = ['UNEXECUTED', 'PASS', 'FAIL', 'BLOCKED', 'UNVERIFIED']
  if (!Array.isArray(document.result_status_vocabulary) || document.result_status_vocabulary.length !== expectedResultStatuses.length || document.result_status_vocabulary.some((status, index) => status !== expectedResultStatuses[index])) {
    violations.push('device evidence result status vocabulary must be UNEXECUTED, PASS, FAIL, BLOCKED, UNVERIFIED')
  }
  if (document.copy_results_to !== 'docs/mobile/evidence/issue-64/YYYY-MM-DD/<run-id>/results.json') {
    violations.push('device evidence template must require the dated issue #64 results.json copy path')
  }
  if (!/never edit, rename.*tracked `.template\.json`.*edit only that dated copy/is.test(sources.authSessionDeviceSpike)) {
    violations.push('auth-session-device-spike.md must require the immutable template and dated-copy-only workflow')
  }
  if (!/TEMPLATE\s*\/\s*NOT EVIDENCE/i.test(document.notice ?? '')) {
    violations.push('device evidence template must be prominently labeled TEMPLATE / NOT EVIDENCE')
  }

  if (!Array.isArray(document.platforms)) {
    violations.push('device evidence platforms must be an array')
  } else {
    const platforms = new Map(document.platforms.map((entry) => [entry?.platform, entry]))
    requireExactIds(document.platforms, document.platforms.map((entry) => entry?.platform), [...REQUIRED_DEVICE_PLATFORMS.keys()], 'device evidence platforms', violations)
    for (const [platform, requiredFields] of REQUIRED_DEVICE_PLATFORMS) {
      const entry = platforms.get(platform)
      if (!entry) {
        violations.push(`device evidence platform is missing: ${platform}`)
        continue
      }
      if (!requireExactKeys(entry, ['platform', 'device_requirement', 'metadata', 'cases', 'credential_lifecycle'], `${platform} device evidence platform`, violations)) continue
      const devicePattern = platform === 'ios' ? /physical\s+iphone/i : /physical\s+android/i
      if (!devicePattern.test(entry.device_requirement ?? '')) {
        violations.push(`${platform} device evidence must require a physical device`)
      }
      if (requireExactKeys(entry.metadata, requiredFields, `${platform} device metadata`, violations)) {
        for (const field of requiredFields) requireUnexecuted(entry.metadata[field], `${platform} device metadata ${field}`, violations)
      }
      if (!Array.isArray(entry.cases)) {
        violations.push(`${platform} device evidence cases must be an array`)
      } else {
        const cases = new Map(entry.cases.map((caseEntry) => [caseEntry?.case_id, caseEntry]))
        const expectedCaseIds = [...SHARED_DEVICE_CASE_IDS, ...(PLATFORM_ONLY_CASE_IDS.get(platform) ?? [])]
        requireExactIds(entry.cases, entry.cases.map((caseEntry) => caseEntry?.case_id), expectedCaseIds, `${platform} device evidence cases`, violations)
        for (const caseId of expectedCaseIds) {
          const caseEntry = cases.get(caseId)
          if (!caseEntry) {
            violations.push(`${platform} device evidence case is missing: ${caseId}`)
            continue
          }
          const caseKeys = caseId === 'offline_loss_reconnect_each_session_boundary'
            ? ['case_id', 'status', 'steps', 'evidence', 'session_boundaries']
            : ['case_id', 'status', 'steps', 'evidence']
          if (!requireExactKeys(caseEntry, caseKeys, `${platform} device evidence case ${caseId}`, violations)) continue
          requireUnexecuted(caseEntry.status, `${platform} device evidence case ${caseId} status`, violations)
          requireUnexecuted(caseEntry.steps, `${platform} device evidence case ${caseId} steps`, violations)
          inspectEvidence(caseEntry.evidence, `${platform} device evidence case ${caseId} evidence`, violations)
          if (caseId === 'offline_loss_reconnect_each_session_boundary') {
            if (!Array.isArray(caseEntry.session_boundaries)) {
              violations.push(`${platform} offline session-boundary evidence must be an array`)
            } else {
              const boundaries = new Map(caseEntry.session_boundaries.map((boundary) => [boundary?.boundary, boundary]))
              requireExactIds(caseEntry.session_boundaries, caseEntry.session_boundaries.map((boundary) => boundary?.boundary), REQUIRED_OFFLINE_SESSION_BOUNDARIES, `${platform} offline session-boundary evidence`, violations)
              for (const boundaryId of REQUIRED_OFFLINE_SESSION_BOUNDARIES) {
                const boundary = boundaries.get(boundaryId)
                if (!boundary) {
                  violations.push(`${platform} offline session-boundary evidence is missing: ${boundaryId}`)
                  continue
                }
                if (!requireExactKeys(boundary, ['boundary', 'status', 'evidence'], `${platform} offline session boundary ${boundaryId}`, violations)) continue
                requireUnexecuted(boundary.status, `${platform} offline session boundary ${boundaryId} status`, violations)
                requireUnexecuted(boundary.evidence, `${platform} offline session boundary ${boundaryId} evidence`, violations)
              }
            }
          }
        }
      }
      if (!Array.isArray(entry.credential_lifecycle)) {
        violations.push(`${platform} credential lifecycle evidence must be an array`)
      } else {
        const stages = new Map(entry.credential_lifecycle.map((stage) => [stage?.stage_id, stage]))
        requireExactIds(entry.credential_lifecycle, entry.credential_lifecycle.map((stage) => stage?.stage_id), REQUIRED_CREDENTIAL_LIFECYCLE_STAGES, `${platform} credential lifecycle evidence`, violations)
        for (const stageId of REQUIRED_CREDENTIAL_LIFECYCLE_STAGES) {
          const stage = stages.get(stageId)
          if (!stage) {
            violations.push(`${platform} credential lifecycle stage is missing: ${stageId}`)
            continue
          }
          if (!requireExactKeys(stage, ['stage_id', 'status', 'evidence'], `${platform} credential lifecycle ${stageId}`, violations)) continue
          requireUnexecuted(stage.status, `${platform} credential lifecycle ${stageId} status`, violations)
          requireUnexecuted(stage.evidence, `${platform} credential lifecycle ${stageId} evidence`, violations)
        }
      }
    }
  }

  if (requireObject(document.redaction_policy, 'credential redaction policy', violations)) {
    const policy = document.redaction_policy
    requireExactKeys(policy, ['status', 'raw_secret_policy', 'safe_reference_policy', 'forbidden_values', 'evidence_placeholder'], 'credential redaction policy', violations)
    requireUnexecuted(policy.status, 'credential redaction policy status', violations)
    requireUnexecuted(policy.evidence_placeholder, 'credential redaction policy placeholder', violations)
    if (!/never\s+commit/i.test(policy.raw_secret_policy ?? '') || !/raw|secret|token|credential/i.test(policy.raw_secret_policy ?? '')) {
      violations.push('credential redaction policy must prohibit committing raw secrets')
    }
    if (!/redact|redacted/i.test(policy.safe_reference_policy ?? '') || !/token|cookie|credential/i.test(policy.safe_reference_policy ?? '')) {
      violations.push('credential redaction policy must define safe redacted references')
    }
    for (const forbidden of ['raw cookies', 'access tokens', 'refresh tokens', 'guest tokens', 'credentials', 'email reset links', 'email verification links', 'signing material', 'API keys', 'secrets']) {
      if (!Array.isArray(policy.forbidden_values) || !policy.forbidden_values.includes(forbidden)) {
        violations.push(`credential redaction policy is missing forbidden value: ${forbidden}`)
      }
    }
  }

  if (requireObject(document.adr_contract, 'auth-session transport ADR contract', violations)) {
    const adr = document.adr_contract
    requireExactKeys(adr, ['status', 'allowed_outcomes', 'forbidden_fallbacks', 'decision', 'security_properties', 'frontend_backend_work', 'migration_backward_compatibility', 'rollback', 'revised_estimate', 'follow_up_issues'], 'auth-session transport ADR contract', violations)
    requireUnexecuted(adr.status, 'auth-session transport ADR status', violations)
    for (const field of ['decision', 'security_properties', 'frontend_backend_work', 'migration_backward_compatibility', 'rollback', 'revised_estimate', 'follow_up_issues']) {
      requireUnexecuted(adr[field], `auth-session transport ADR ${field}`, violations)
    }
    const options = Array.isArray(adr.allowed_outcomes) ? adr.allowed_outcomes : []
    const optionIds = options.map((option) => option?.option_id)
    if (options.length !== REQUIRED_ADR_OPTIONS.length || optionIds.some((id, index) => id !== REQUIRED_ADR_OPTIONS[index])) {
      violations.push('auth-session transport ADR must allow exactly the two approved outcomes')
    }
    for (const option of options) {
      if (!/entire\s+member\s+and\s+guest\s+lifecycle/i.test(option?.scope ?? '')) {
        violations.push(`auth-session transport ADR outcome ${option?.option_id ?? 'unknown'} must cover the entire member and guest lifecycle`)
      }
    }
    const fallbacks = Array.isArray(adr.forbidden_fallbacks) ? adr.forbidden_fallbacks : []
    if (fallbacks.length !== REQUIRED_ADR_FORBIDDEN_FALLBACKS.length || REQUIRED_ADR_FORBIDDEN_FALLBACKS.some((item) => !fallbacks.includes(item))) {
      violations.push('auth-session transport ADR must forbid endpoint-only and web-storage token fallbacks')
    }
  }

  const requiredTemplateDocs = [
    ['auth-session-device-spike.md', sources.authSessionDeviceSpike],
    ['auth-session-transport-adr-template.md', sources.authSessionAdrTemplate],
  ]
  for (const [name, contents] of requiredTemplateDocs) {
    if (!/TEMPLATE\s*\/\s*NOT EVIDENCE/i.test(contents)) violations.push(`${name} must be labeled TEMPLATE / NOT EVIDENCE`)
  }
  if (!sources.releaseDocument.includes('auth-session-device-spike.md') ||
      !sources.releaseDocument.includes('auth-session-device-evidence.template.json') ||
      !sources.releaseDocument.includes('auth-session-transport-adr-template.md')) {
    violations.push('release-readiness must reference all issue #64 evidence templates')
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
