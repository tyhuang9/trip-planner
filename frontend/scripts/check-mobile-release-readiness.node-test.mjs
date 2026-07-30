import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { assertMobileReleaseReadiness, inspectMobileReleaseReadiness, loadMobileReleaseSources, loadTrackedResultCopies } from './check-mobile-release-readiness.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const sources = () => loadMobileReleaseSources(root)
const messages = (candidate) => inspectMobileReleaseReadiness(candidate).join('\n')
const sourceFiles = ['docs/mobile/auth-session-device-evidence.catalog.json', 'docs/mobile/auth-session-device-evidence.template.json', 'docs/mobile/auth-session-device-spike.md', 'docs/mobile/auth-session-transport-adr-template.md', 'frontend/public/account-deletion.html', 'frontend/vercel.json']
const resultPath = 'docs/mobile/evidence/issue-64/2026-07-29/safe-run-1/results.json'

function contractCatalog() {
  return JSON.parse(sources().authSessionEvidenceCatalog)
}
function expectedFallbackFlowIds() {
  return Object.entries(contractCatalog().contexts).flatMap(([contextId, context]) => [
    ...context.cases.map((caseId) => `${contextId}.case.${caseId}`),
    ...context.credential_lifecycle.map((stageId) => `${contextId}.credential_lifecycle.${stageId}`),
  ])
}
function outcomeWork(outcome, domain) {
  const requirement = contractCatalog().adr.work_requirements[outcome][domain]
  return {
    classification: requirement.classification,
    scope_ids: [...requirement.scope_ids],
    details: requirement.classification === 'no_fallback_work'
      ? 'NO_FALLBACK_WORK'
      : `Completed explicit native credential transport work for the catalog-owned ${domain} scopes.`,
  }
}
function fallbackFollowUps() {
  const flowIds = expectedFallbackFlowIds()
  const splitAt = Math.ceil(flowIds.length / 2)
  return [
    { issue_url: 'https://github.com/tyhuang9/dupert/issues/65', flow_ids: flowIds.slice(0, splitAt) },
    { issue_url: 'https://github.com/tyhuang9/dupert/issues/66', flow_ids: flowIds.slice(splitAt) },
  ]
}

function replaceAccountText(candidate, text, replacement = 'Removed text.') {
  const pattern = text.trim().split(/\s+/).map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
  const updated = candidate.accountDeletionResource.replace(new RegExp(pattern), replacement)
  assert.notEqual(updated, candidate.accountDeletionResource, `test fixture text not found: ${text}`)
  candidate.accountDeletionResource = updated
}
function updateVercel(candidate, mutate) {
  const config = JSON.parse(candidate.vercelConfig)
  mutate(config.rewrites, config)
  candidate.vercelConfig = JSON.stringify(config)
}
function addAccountStyles(candidate, css) {
  const updated = candidate.accountDeletionResource.replace('</style>', `${css}\n    </style>`)
  assert.notEqual(updated, candidate.accountDeletionResource, 'account-deletion stylesheet fixture was not found')
  candidate.accountDeletionResource = updated
}

function completed() {
  const value = JSON.parse(sources().authSessionEvidenceTemplate)
  value.template_status = 'COMPLETED'
  value.notice = 'COMPLETED RESULTS / CLAIM-BEARING ARTIFACT'
  const fill = (item, key = '') => item === 'UNEXECUTED' ? (key === 'status' ? 'PASS' : key === 'artifact_identity_checksum' ? 'sha256:' + 'a'.repeat(64) : key === 'test_date_time' ? '2026-07-29T12:00:00Z' : 'restricted://issue-64/run-1') : Array.isArray(item) ? (key === 'result_status_vocabulary' ? item : item.map((x) => fill(x))) : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).map(([k, x]) => [k, fill(x, k)])) : item
  const result = fill(value)
  result.adr_contract.selected_outcome = 'cookie_only_proven'
  result.adr_contract.decision_artifact_reference = 'restricted://issue-64/safe-run-1/decision'
  result.adr_contract.security_properties = 'Preserves HttpOnly credentials, rotation, revocation, and least-privilege boundaries.'
  result.adr_contract.frontend_work = outcomeWork('cookie_only_proven', 'frontend')
  result.adr_contract.backend_work = outcomeWork('cookie_only_proven', 'backend')
  result.adr_contract.migration_compatibility = 'Existing web sessions remain compatible without a credential migration.'
  result.adr_contract.revised_estimate = 'One engineering day for release verification and evidence review.'
  result.adr_contract.follow_up_issue_references = []
  let referenceId = 0
  for (const [platformIndex, platform] of result.platforms.entries()) {
    const checksum = 'sha256:' + (platformIndex === 0 ? 'a' : 'b').repeat(64)
    platform.metadata.device_type = platform.platform === 'ios' ? 'physical_iphone' : 'physical_android'
    platform.metadata.is_simulator = false
    platform.metadata.is_emulator = false
    platform.metadata.app_version = '1.2.3'
    platform.metadata.platform_build = platform.platform === 'ios' ? 'ios-101' : 'android-202'
    platform.metadata.artifact_identity_checksum = checksum
    platform.attestation = { platform: platform.platform, device_type: platform.metadata.device_type, safe_reference: `restricted://issue-64/safe-run-1/${platform.platform}/attestation`, artifact_identity_checksum: checksum, captured_at: platform.metadata.test_date_time }
    const setEvidence = (evidence, context) => { evidence.safe_reference = `restricted://issue-64/safe-run-1/${platform.platform}/${context}/artifact-${referenceId++}`; evidence.network_trace_reference = `restricted://issue-64/safe-run-1/${platform.platform}/${context}/trace-${referenceId++}`; evidence.artifact_identity_checksum = checksum }
    for (const context of platform.contexts) {
      for (const caseEntry of context.cases) { setEvidence(caseEntry.evidence, context.context_id); for (const boundary of caseEntry.session_boundaries ?? []) setEvidence(boundary.evidence, context.context_id) }
      for (const stage of context.credential_lifecycle) setEvidence(stage.evidence, context.context_id)
    }
    for (const caseEntry of platform.platform_cases) setEvidence(caseEntry.evidence, 'platform')
  }
  return result
}
function withAdrAcceptance(result, {
  outcome = 'cookie_only_proven',
  followUps = [],
} = {}) {
  Object.assign(result.adr_contract, {
    selected_outcome: outcome,
    security_properties: 'Preserves HttpOnly credentials, rotation, revocation, and least-privilege boundaries.',
    frontend_work: outcomeWork(outcome, 'frontend'),
    backend_work: outcomeWork(outcome, 'backend'),
    migration_compatibility: 'Existing web sessions remain compatible without a credential migration.',
    revised_estimate: 'One engineering day for release verification and evidence review.',
    follow_up_issue_references: followUps,
  })
  return result
}
function tracked(result = completed()) {
  const candidate = sources()
  candidate.trackedFiles = [...sourceFiles, resultPath]
  candidate.resultCopies = { [resultPath]: JSON.stringify(result) }
  return candidate
}
function trackedAt(runId, result = completed(), date = '2026-07-29') {
  const path = `docs/mobile/evidence/issue-64/${date}/${runId}/results.json`
  const candidate = sources()
  candidate.trackedFiles = [...sourceFiles, path]
  candidate.resultCopies = { [path]: JSON.stringify(result).replaceAll('safe-run-1', runId) }
  return candidate
}

test('accepts source contract and safe completed result', () => {
  assert.deepEqual(inspectMobileReleaseReadiness(sources()), [])
  assert.deepEqual(inspectMobileReleaseReadiness(tracked()), [])
})

test('enforces the public account-deletion resource contract', async (t) => {
  assert.deepEqual(inspectMobileReleaseReadiness(sources()), [])
  const cases = [
    ['missing marker', /account-deletion-resource marker must appear exactly once/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace(/<!-- account-deletion-resource[\s\S]*?-->\n/, '') }],
    ['invalid marker', /account-deletion-resource marker contract_version/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('contract_version=1', 'contract_version=2') }],
    ['invalid Vercel config', /frontend\/vercel\.json must be valid JSON/, (candidate) => { candidate.vercelConfig = '{' }],
    ['missing Vercel config', /frontend\/vercel\.json must be valid JSON/, (candidate) => { candidate.vercelConfig = '' }],
    ['missing Vercel rewrites', /frontend\/vercel\.json rewrites must be an array/, (candidate) => { candidate.vercelConfig = '{}' }],
    ['unsupported redirects', /unsupported top-level key: redirects/, (candidate) => { updateVercel(candidate, (_, config) => { config.redirects = [] }) }],
    ['unsupported routes', /unsupported top-level key: routes/, (candidate) => { updateVercel(candidate, (_, config) => { config.routes = [] }) }],
    ['unsupported cleanUrls', /unsupported top-level key: cleanUrls/, (candidate) => { updateVercel(candidate, (_, config) => { config.cleanUrls = true }) }],
    ['unsupported trailingSlash', /unsupported top-level key: trailingSlash/, (candidate) => { updateVercel(candidate, (_, config) => { config.trailingSlash = false }) }],
    ['wrong outputDirectory', /outputDirectory must be dist/, (candidate) => { updateVercel(candidate, (_, config) => { config.outputDirectory = 'build' }) }],
    ['absent rewrite', /account-deletion rewrite must appear exactly once/, (candidate) => { updateVercel(candidate, (rewrites) => rewrites.splice(rewrites.findIndex((rewrite) => rewrite.source === '/account-deletion'), 1)) }],
    ['duplicate rewrite', /account-deletion rewrite must appear exactly once/, (candidate) => { updateVercel(candidate, (rewrites) => rewrites.unshift(structuredClone(rewrites.find((rewrite) => rewrite.source === '/account-deletion')))) }],
    ['wrong rewrite destination', /account-deletion rewrite destination/, (candidate) => { updateVercel(candidate, (rewrites) => { rewrites.find((rewrite) => rewrite.source === '/account-deletion').destination = '/index.html' }) }],
    ['unexpected account rewrite key', /account-deletion rewrite must contain exactly/, (candidate) => { updateVercel(candidate, (rewrites) => { rewrites.find((rewrite) => rewrite.source === '/account-deletion').extra = true }) }],
    ['higher-priority dynamic rewrite', /account-deletion rewrite must be the first rewrite/, (candidate) => { updateVercel(candidate, (rewrites) => rewrites.unshift({ source: '/account-:path*', destination: '/index.html' })) }],
    ['late rewrite', /account-deletion rewrite must be the first rewrite/, (candidate) => { updateVercel(candidate, (rewrites) => { const index = rewrites.findIndex((rewrite) => rewrite.source === '/account-deletion'); rewrites.push(...rewrites.splice(index, 1)) }) }],
    ['missing SPA fallback', /SPA fallback rewrite must appear exactly once/, (candidate) => { updateVercel(candidate, (rewrites) => rewrites.splice(rewrites.findIndex((rewrite) => rewrite.source === '/(.*)'), 1)) }],
    ['duplicate SPA fallback', /SPA fallback rewrite must appear exactly once/, (candidate) => { updateVercel(candidate, (rewrites) => rewrites.push(structuredClone(rewrites.find((rewrite) => rewrite.source === '/(.*)')))) }],
    ['wrong SPA fallback destination', /SPA fallback rewrite destination/, (candidate) => { updateVercel(candidate, (rewrites) => { rewrites.find((rewrite) => rewrite.source === '/(.*)').destination = '/other.html' }) }],
    ['unexpected SPA fallback key', /SPA fallback rewrite must contain exactly/, (candidate) => { updateVercel(candidate, (rewrites) => { rewrites.find((rewrite) => rewrite.source === '/(.*)').extra = true }) }],
    ['missing html language', /html lang must be en/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('<html lang="en">', '<html>') }],
    ['missing main', /exactly one visible main/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('<main>', '<div>').replace('</main>', '</div>') }],
    ['duplicate main', /exactly one visible main/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('</body>', '<main></main></body>') }],
    ['hidden main', /exactly one visible main/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('<main>', '<main hidden>') }],
    ['wrong h1 name', /exactly one visible h1 named/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('<h1 id="page-title">Delete your Dupert account</h1>', '<h1 id="page-title">Account settings</h1>') }],
    ['wrong h1 accessible name', /exactly one visible h1 named/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('<h1 id="page-title"', '<h1 aria-label="Account settings" id="page-title"') }],
    ['missing h1 semantics', /exactly one visible h1 named/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('<h1 id="page-title">', '<div id="page-title">').replace('</h1>', '</div>') }],
    ['duplicate h1', /exactly one visible h1 named/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('</h1>', '</h1><h1>Delete your Dupert account</h1>') }],
    ['wrong title', /resource title must be/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('<title>Delete your Dupert account</title>', '<title>Account settings</title>') }],
    ['missing description', /description metadata is invalid/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace(/\s*<meta\s+name="description"[\s\S]*?\/>/, '') }],
    ['wrong viewport', /viewport metadata is invalid/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('width=device-width, initial-scale=1.0', 'width=1024') }],
    ['missing canonical link', /account-deletion resource canonical link/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace(/\s*<link rel="canonical"[^>]+>/, '') }],
    ['missing sign-in CTA', /visible, focusable \/login CTA/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('href="/login"', 'href="/"') }],
    ['wrong CTA text', /visible, focusable \/login CTA/, (candidate) => { replaceAccountText(candidate, 'Sign in to delete your account', 'Sign in') }],
    ['wrong CTA accessible name', /visible, focusable \/login CTA/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('<a class="cta"', '<a aria-label="Sign in" class="cta"') }],
    ['hidden CTA', /visible, focusable \/login CTA/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('<a class="cta"', '<a hidden class="cta"') }],
    ['aria-hidden CTA', /visible, focusable \/login CTA/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('<a class="cta"', '<a aria-hidden="true" class="cta"') }],
    ['tabindex CTA', /visible, focusable \/login CTA/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('<a class="cta"', '<a tabindex="-1" class="cta"') }],
    ['display-none CTA', /visible, focusable \/login CTA/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('<a class="cta"', '<a style="display: none" class="cta"') }],
    ['visibility-hidden CTA', /visible, focusable \/login CTA/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('<a class="cta"', '<a style="visibility: hidden" class="cta"') }],
    ['transparent CTA', /visible, focusable \/login CTA/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('<a class="cta"', '<a style="opacity: 0" class="cta"') }],
    ['duplicate CTA', /one visible, focusable \/login CTA/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('</header>', '<a href="/login">Sign in to delete your account</a></header>') }],
    ['hidden deletion summary', /irreversible and retained-content summary/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('<section class="deletion-summary"', '<section hidden class="deletion-summary"') }],
    ['non-semantic deletion summary', /irreversible and retained-content summary/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('<section class="deletion-summary"', '<div class="deletion-summary"').replace('</section>', '</div>') }],
    ['missing CTA microcopy', /associate the sign-in CTA/, (candidate) => { replaceAccountText(candidate, 'Signing in does not delete your account. You will review and confirm deletion in Account settings.') }],
    ['missing CTA description association', /associate the sign-in CTA/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace(' aria-describedby="sign-in-note"', '') }],
    ['missing recovery link', /Reset your password link/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('/login?mode=password-reset', '/login') }],
    ['wrong recovery purpose', /Reset your password link/, (candidate) => { replaceAccountText(candidate, 'Reset your password', 'Recover access') }],
    ['forbidden script', /must not contain scripts/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('</body>', '<script>globalThis.executed = true</script></body>') }],
    ['forbidden form', /must not contain forms/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('</body>', '<form></form></body>') }],
    ['forbidden external dependency', /must not contain an external dependency/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('</body>', '<img src="https://example.invalid/pixel.png" alt="" /></body>') }],
    ['forbidden inline event handler', /must not contain inline event handlers/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('<main>', '<main onpointerover="globalThis.executed = true">') }],
    ['javascript href', /non-allowlisted href/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('href="/login?mode=password-reset"', 'href="javascript:alert(1)"') }],
    ['additional href', /non-allowlisted href/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('</body>', '<a href="/privacy">Privacy</a></body>') }],
    ['non-semantic steps list', /ordered steps list is missing/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('<ol>', '<ul>').replace('</ol>', '</ul>') }],
    ['non-semantic consequence list', /consequences list is missing/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('<ul>', '<ol>').replace('</ul>', '</ol>') }],
    ['hidden steps list', /ordered steps item/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('<ol>', '<ol hidden>') }],
    ['hidden consequences list', /consequences item/, (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('<ul>', '<ul hidden>') }],
    ['documentation URL drift', /release-readiness account-deletion URL/, (candidate) => { candidate.releaseDocument = candidate.releaseDocument.replaceAll('https://dupert.vercel.app/account-deletion', 'https://example.invalid/delete') }],
    ['untracked resource', /public account-deletion resource must be tracked: frontend\/public\/account-deletion\.html/, (candidate) => { candidate.trackedFiles = sourceFiles.filter((path) => path !== 'frontend/public/account-deletion.html') }],
    ['untracked Vercel config', /public account-deletion resource must be tracked: frontend\/vercel\.json/, (candidate) => { candidate.trackedFiles = sourceFiles.filter((path) => path !== 'frontend/vercel.json') }],
    ['privacy gate changed', /Privacy and store metadata must remain BLOCKED/, (candidate) => { candidate.releaseDocument = candidate.releaseDocument.replace('| Privacy and store metadata | BLOCKED |', '| Privacy and store metadata | PASS |') }],
  ]
  for (const [name, value] of [['null', 'null'], ['false', 'false'], ['zero', '0'], ['empty string', '""'], ['array', '[]']]) cases.push([`${name} Vercel config`, /frontend\/vercel\.json must be an object/, (candidate) => { candidate.vercelConfig = value }])
  for (const phrase of [
    'Sign in to your Dupert account.',
    'Open Trips.',
    'Open Account. On small screens, open the account menu first, then choose Account.',
    'Select Delete account.',
    'Type the exact lowercase word delete.',
    'Enter your current password.',
    'Confirm Delete account.',
  ]) cases.push([`missing step: ${phrase}`, /account-deletion resource ordered steps item/, (candidate) => { replaceAccountText(candidate, phrase) }])
  for (const phrase of [
    'Your account is permanently removed.',
    'You are signed out on this device. Dupert cancels saved sign-ins, and other devices ask you to sign in again after their current access expires.',
    'Trips you own with no other Dupert members are deleted.',
    'Trips you own with other Dupert members are transferred to one of them.',
    'Content in retained shared trips may remain.',
    'Your signed-in Dupert name is removed from retained activity history, but a guest name you used before signing in may remain.',
    'Share links you created and guest access that depends on them are removed.',
  ]) cases.push([`missing consequence: ${phrase}`, /account-deletion resource consequences item/, (candidate) => { replaceAccountText(candidate, phrase) }])
  cases.push(['hidden required step text', /account-deletion resource ordered steps item/, (candidate) => { replaceAccountText(candidate, 'Open Trips.', '<span hidden>Open Trips.</span>') }])
  cases.push(['hidden required consequence text', /account-deletion resource consequences item/, (candidate) => { replaceAccountText(candidate, 'Content in retained shared trips may remain.', '<span aria-hidden="true">Content in retained shared trips may remain.</span>') }])

  await t.test('allows a benign rewrite between deletion and SPA fallback', () => {
    const benign = sources()
    updateVercel(benign, (rewrites) => rewrites.splice(rewrites.findIndex((rewrite) => rewrite.source === '/(.*)'), 0, { source: '/privacy', destination: '/privacy.html' }))
    assert.deepEqual(inspectMobileReleaseReadiness(benign), [])
  })
  await t.test('allows outputDirectory dist', () => {
    const candidate = sources()
    updateVercel(candidate, (_, config) => { config.outputDirectory = 'dist' })
    assert.deepEqual(inspectMobileReleaseReadiness(candidate), [])
  })

  for (const [name, expected, mutate] of cases) await t.test(name, () => {
    const candidate = sources()
    mutate(candidate)
    assert.match(messages(candidate), expected)
  })
})

test('rejects required account-deletion controls hidden by inline or stylesheet CSS', () => {
  const cases = [
    ['inline declaration', (candidate) => { candidate.accountDeletionResource = candidate.accountDeletionResource.replace('<a class="cta"', '<a class="cta" style="display: none"') }],
    ['stylesheet rule', (candidate) => { addAccountStyles(candidate, '.cta { display: none; }') }],
    ['conditional media rule', (candidate) => { addAccountStyles(candidate, '@media (max-width: 36rem) { .cta { visibility: hidden; } }') }],
    ['conditional complex selector', (candidate) => { addAccountStyles(candidate, '@media (max-width: 36rem) { body > main > article > header a.cta[aria-describedby="sign-in-note"] { opacity: 0; } }') }],
  ]

  for (const [name, mutate] of cases) {
    const candidate = sources()
    mutate(candidate)
    assert.match(messages(candidate), /visible, focusable \/login CTA/, name)
  }
})

test('allows a stylesheet hiding rule that does not match a required control', () => {
  const candidate = sources()
  addAccountStyles(candidate, '.unrelated-control { display: none; }')

  assert.deepEqual(inspectMobileReleaseReadiness(candidate), [])
})

test('rejects native identifier and version drift', () => {
  const candidate = sources()
  candidate.androidAppBuild = candidate.androidAppBuild.replace('applicationId "io.github.tyhuang9.dupert"', 'applicationId "io.github.tyhuang9.other"').replace('versionName "1.0"', 'versionName "1.1"')
  const output = messages(candidate)
  assert.match(output, /Android applicationId must match Capacitor appId/)
  assert.match(output, /Android and iOS marketing versions must agree/)
})

test('rejects unsafe production backend origin', () => {
  const candidate = sources()
  candidate.nativeProductionEnvironment = 'VITE_BACKEND_API_URL=http://localhost:8000?token=unsafe\n'
  const output = messages(candidate)
  assert.match(output, /must use HTTPS/)
  assert.match(output, /must not include credentials, query, or fragment data/)
})

test('rejects tracked signing and provisioning material', () => {
  const candidate = sources()
  candidate.trackedFiles = ['frontend/android/app/release.keystore', 'frontend/ios/App/App.mobileprovision']
  assert.match(messages(candidate), /release\.keystore/)
})

test('rejects missing and duplicate release gates', () => {
  const candidate = sources()
  candidate.releaseDocument = candidate.releaseDocument.replace(/^\| Monitoring and ownership \|.*\n/m, '').replace('| Artifact provenance | BLOCKED |', '| Repository contract | BLOCKED | Unassigned | duplicate |\n| Artifact provenance | BLOCKED |')
  const output = messages(candidate)
  assert.match(output, /release gate is missing: Monitoring and ownership/)
  assert.match(output, /must not repeat gate names/)
})

test('rejects CI pin drift', () => {
  const candidate = sources()
  candidate.workflow = candidate.workflow.replace("node-version: '22'", "node-version: '24'")
  assert.match(messages(candidate), /CI Node version must be present and consistent/)
})

test('keeps both issue 64 release gates blocked', () => {
  for (const gate of ['Authentication and guest sessions', 'Device install smoke']) {
    const candidate = sources()
    candidate.releaseDocument = candidate.releaseDocument.replace(`| ${gate} | BLOCKED |`, `| ${gate} | PASS |`)
    assert.match(messages(candidate), new RegExp(`${gate} must remain BLOCKED`))
  }
})

test('rejects missing iOS and Android platform entries', () => {
  for (const name of ['ios', 'android']) { const candidate = sources(); const document = JSON.parse(candidate.authSessionEvidenceTemplate); document.platforms = document.platforms.filter((x) => x.platform !== name); candidate.authSessionEvidenceTemplate = JSON.stringify(document); assert.match(messages(candidate), /platforms must contain exactly/) }
})

test('rejects missing platform metadata and context cases', () => {
  const candidate = sources(); const document = JSON.parse(candidate.authSessionEvidenceTemplate); delete document.platforms[0].metadata.device_model; document.platforms[1].contexts[1].cases.pop(); candidate.authSessionEvidenceTemplate = JSON.stringify(document); const output = messages(candidate); assert.match(output, /metadata must contain exactly/); assert.match(output, /guest cases must contain exactly/)
})

test('requires distinct platform and context structures', () => {
  const candidate = sources(); const document = JSON.parse(candidate.authSessionEvidenceTemplate); document.platforms[0].contexts[1].cases = document.platforms[0].contexts[0].cases; candidate.authSessionEvidenceTemplate = JSON.stringify(document); assert.match(messages(candidate), /ios guest cases must contain exactly/)
})

test('rejects dated-copy workflow drift', () => {
  const candidate = sources(); const document = JSON.parse(candidate.authSessionEvidenceTemplate); document.copy_results_to = 'docs/mobile/evidence/results.json'; candidate.authSessionEvidenceTemplate = JSON.stringify(document); assert.match(messages(candidate), /copy_results_to is invalid/)
})

test('rejects missing boundary, lifecycle stage, and evidence field', () => {
  const candidate = sources(); const document = JSON.parse(candidate.authSessionEvidenceTemplate); const member = document.platforms[0].contexts[0]; member.credential_lifecycle.pop(); member.cases.find((x) => x.case_id === 'offline_loss_reconnect_each_session_boundary').session_boundaries.pop(); delete member.cases[0].evidence.safe_reference; candidate.authSessionEvidenceTemplate = JSON.stringify(document); const output = messages(candidate); assert.match(output, /lifecycle must contain exactly/); assert.match(output, /session boundaries must contain exactly/); assert.match(output, /evidence must contain exactly/)
})

test('rejects source template claims and redaction or ADR drift', () => {
  const candidate = sources(); const document = JSON.parse(candidate.authSessionEvidenceTemplate); document.platforms[0].contexts[0].cases[0].status = 'PASS'; delete document.redaction_policy.raw_capture_policy; document.adr_contract.allowed_outcomes.push('endpoint_only_fallback'); candidate.authSessionEvidenceTemplate = JSON.stringify(document); const output = messages(candidate); assert.match(output, /status must be PASS/); assert.match(output, /redaction policy must contain exactly/); assert.match(output, /ADR catalogs are invalid/)
})

test('rejects falsely completed source template status and evidence', () => {
  const candidate = sources(); const document = JSON.parse(candidate.authSessionEvidenceTemplate); document.template_status = 'PASS'; document.platforms[0].contexts[0].cases[0].evidence.safe_reference = 'restricted://issue-64/run-1'; candidate.authSessionEvidenceTemplate = JSON.stringify(document); const output = messages(candidate); assert.match(output, /template status must remain UNEXECUTED/); assert.match(output, /safe_reference must remain UNEXECUTED/)
})

test('rejects removal of raw-secret redaction policy', () => {
  const candidate = sources(); const document = JSON.parse(candidate.authSessionEvidenceTemplate); delete document.redaction_policy.raw_capture_policy; candidate.authSessionEvidenceTemplate = JSON.stringify(document); assert.match(messages(candidate), /redaction policy must contain exactly/)
})

test('rejects ADR option drift', () => {
  const candidate = sources(); const document = JSON.parse(candidate.authSessionEvidenceTemplate); document.adr_contract.allowed_outcomes.push('endpoint_only_fallback'); candidate.authSessionEvidenceTemplate = JSON.stringify(document); assert.match(messages(candidate), /ADR catalogs are invalid/)
})

test('rejects session collapse, raw evidence, invalid device and unknown keys', () => {
  const result = completed()
  const ios = result.platforms[0]
  ios.contexts[1].cases = ios.contexts[0].cases
  ios.metadata.is_simulator = true
  ios.contexts[0].cases[0].evidence.safe_reference = 'Authorization: Bearer secret'
  ios.contexts[0].cases[0].evidence.extra = 'hidden'
  const output = messages(tracked(result))
  assert.match(output, /guest cases must contain exactly/)
  assert.match(output, /must record a physical device/)
  assert.match(output, /contains a raw credential/)
  assert.match(output, /must contain exactly/)
})

test('rejects completed-result status, metadata, references, and procedural secrets independently', () => {
  const cases = [
    ['MAYBE', /status must be PASS/, (r) => { r.platforms[0].contexts[0].cases[0].status = 'MAYBE' }],
    ['bad reference', /safe_reference must be scoped/, (r) => { r.platforms[0].contexts[0].cases[0].evidence.safe_reference = 'https://x/?token=no' }],
    ['bad metadata', /test_date_time must be component-valid RFC3339/, (r) => { r.platforms[0].metadata.test_date_time = 'tomorrow' }],
    ['bad checksum', /metadata artifact_identity_checksum must be sha256/, (r) => { r.platforms[0].metadata.artifact_identity_checksum = 'bad' }],
    ['procedural Bearer', /contains a raw credential/, (r) => { r.platforms[0].contexts[0].cases[0].actions = 'Bearer abcdefghijklmnopqrstuvwxyz' }],
  ]
  for (const [, expected, mutate] of cases) { const result = completed(); mutate(result); assert.match(messages(tracked(result)), expected) }
})

test('rejects missing result copy and completed template notice drift', () => {
  const candidate = sources()
  candidate.trackedFiles = [...sourceFiles, resultPath]
  candidate.resultCopies = {}
  assert.match(messages(candidate), /could not be safely read/)
  const result = completed()
  result.notice = 'TEMPLATE / NOT EVIDENCE'
  assert.match(messages(tracked(result)), /notice must exactly match/)
})

test('rejects untracked templates, invalid paths, marker drift, extra gates, and malformed headers', () => {
  const candidate = tracked()
  candidate.trackedFiles = [resultPath, 'docs/mobile/evidence/issue-64/2026-02-30/Bad/results.json', 'docs/mobile/evidence/issue-64/raw.json']
  candidate.authSessionDeviceSpike = candidate.authSessionDeviceSpike.replace('results_json_only', 'markdown')
  candidate.authSessionAdrTemplate = candidate.authSessionAdrTemplate.replace('cookie_only_proven,native_credential_transport', 'anything')
  candidate.releaseDocument = candidate.releaseDocument.replace('| Gate | Status | Owner | Evidence |', '| bad |').replace('<!-- mobile-release-gates:end -->', '| Extra | BLOCKED | Unassigned | none |\n<!-- mobile-release-gates:end -->')
  const output = messages(candidate)
  assert.match(output, /immutable issue #64 source must be tracked/)
  assert.match(output, /unauthorized/)
  assert.match(output, /unauthorized/)
  assert.match(output, /issue64-spike-policy marker/)
  assert.match(output, /issue64-adr-policy marker/)
  assert.match(output, /release-gate table must use/)
})

test('rejects schema v4 in the source template', () => {
  const candidate = sources(); const document = JSON.parse(candidate.authSessionEvidenceTemplate); document.schema_version = 4; candidate.authSessionEvidenceTemplate = JSON.stringify(document); assert.match(messages(candidate), /schema_version must be 3/)
})

test('rejects schema v4 in a completed result', () => {
  const result = completed(); result.schema_version = 4; assert.match(messages(tracked(result)), /schema_version must be 3/)
})

test('uses explicit context for offline boundaries regardless of member and guest path text', () => {
  assert.deepEqual(inspectMobileReleaseReadiness(trackedAt('member-guest-run')), [])
  const result = completed(); const ios = result.platforms[0]; const memberBoundaries = ios.contexts[0].cases.find((x) => x.case_id === 'offline_loss_reconnect_each_session_boundary').session_boundaries; ios.contexts[1].cases.find((x) => x.case_id === 'offline_loss_reconnect_each_session_boundary').session_boundaries = memberBoundaries; assert.match(messages(trackedAt('member-run', result)), /guest offline_loss.*session boundaries must contain exactly/)
})

test('rejects missing, multiple, invalid, or forbidden ADR selections', () => {
  for (const mutate of [(r) => { delete r.adr_contract.selected_outcome }, (r) => { r.adr_contract.selected_outcome = ['cookie_only_proven', 'native_credential_transport'] }, (r) => { r.adr_contract.selected_outcome = 'anything' }, (r) => { r.adr_contract.selected_outcome = 'endpoint_only_fallback' }]) { const result = completed(); mutate(result); assert.match(messages(tracked(result)), /ADR/) }
})

test('rejects missing, mismatched, or unsafe ADR decision references', () => {
  for (const mutate of [(r) => { delete r.adr_contract.decision_artifact_reference }, (r) => { r.adr_contract.decision_artifact_reference = 'restricted://issue-64/other-run/decision' }, (r) => { r.adr_contract.decision_artifact_reference = 'https://example.test/decision?code=raw' }]) { const result = completed(); mutate(result); assert.match(messages(tracked(result)), /ADR|raw credential/) }
})

test('accepts complete ADR acceptance evidence for both approved outcomes', () => {
  assert.deepEqual(inspectMobileReleaseReadiness(tracked(withAdrAcceptance(completed()))), [])
  const fallback = withAdrAcceptance(completed(), {
    outcome: 'native_credential_transport',
    followUps: fallbackFollowUps(),
  })
  assert.deepEqual(inspectMobileReleaseReadiness(tracked(fallback)), [])
})

test('requires every ADR acceptance field', () => {
  for (const field of ['security_properties', 'frontend_work', 'backend_work', 'migration_compatibility', 'revised_estimate', 'follow_up_issue_references']) {
    const result = withAdrAcceptance(completed())
    delete result.adr_contract[field]
    assert.match(messages(tracked(result)), new RegExp(`ADR contract.*${field}`))
  }
})

test('requires fallback follow-up issues and forbids them for cookie-only evidence', () => {
  const missing = withAdrAcceptance(completed(), { outcome: 'native_credential_transport' })
  assert.match(messages(tracked(missing)), /native_credential_transport.*at least one follow-up issue reference/)

  const unexpected = withAdrAcceptance(completed(), {
    followUps: [{ issue_url: 'https://github.com/tyhuang9/dupert/issues/65', flow_ids: [expectedFallbackFlowIds()[0]] }],
  })
  assert.match(messages(tracked(unexpected)), /cookie_only_proven.*follow-up issue references must be empty/)
})

test('rejects malformed ADR acceptance narratives', () => {
  for (const field of ['security_properties', 'migration_compatibility', 'revised_estimate']) {
    for (const value of [null, [], '   ', 'UNEXECUTED']) {
      const result = withAdrAcceptance(completed())
      result.adr_contract[field] = value
      assert.match(messages(tracked(result)), new RegExp(`ADR ${field} must be completed text`))
    }
  }
})

test('rejects outcome work that contradicts the catalog-owned classification or scope', () => {
  const cookieClassification = withAdrAcceptance(completed())
  cookieClassification.adr_contract.frontend_work.classification = 'explicit_native_transport_work'
  assert.match(messages(tracked(cookieClassification)), /frontend_work classification must be no_fallback_work/)

  const cookieScopes = withAdrAcceptance(completed())
  cookieScopes.adr_contract.backend_work.scope_ids = ['rest_and_sse_authentication']
  assert.match(messages(tracked(cookieScopes)), /backend_work scope_ids must exactly match the selected outcome/)

  const cookieDetails = withAdrAcceptance(completed())
  cookieDetails.adr_contract.frontend_work.details = 'Fallback work was completed.'
  assert.match(messages(tracked(cookieDetails)), /frontend_work details must be NO_FALLBACK_WORK/)

  const nativeClassification = withAdrAcceptance(completed(), { outcome: 'native_credential_transport', followUps: fallbackFollowUps() })
  nativeClassification.adr_contract.backend_work.classification = 'no_fallback_work'
  assert.match(messages(tracked(nativeClassification)), /backend_work classification must be explicit_native_transport_work/)

  const nativeScopes = withAdrAcceptance(completed(), { outcome: 'native_credential_transport', followUps: fallbackFollowUps() })
  nativeScopes.adr_contract.frontend_work.scope_ids.pop()
  assert.match(messages(tracked(nativeScopes)), /frontend_work scope_ids must exactly match the selected outcome/)

  const nativeDetails = withAdrAcceptance(completed(), { outcome: 'native_credential_transport', followUps: fallbackFollowUps() })
  nativeDetails.adr_contract.backend_work.details = 'NO_FALLBACK_WORK'
  assert.match(messages(tracked(nativeDetails)), /backend_work details must describe completed fallback work/)
})

test('rejects malformed fallback work objects', () => {
  for (const mutate of [
    () => null,
    (work) => ({ ...work, extra: true }),
    (work) => ({ ...work, scope_ids: 'rest_and_sse_transport' }),
    (work) => ({ ...work, details: 'UNEXECUTED' }),
  ]) {
    const result = withAdrAcceptance(completed(), { outcome: 'native_credential_transport', followUps: fallbackFollowUps() })
    result.adr_contract.frontend_work = mutate(result.adr_contract.frontend_work)
    assert.match(messages(tracked(result)), /ADR frontend_work/)
  }
})

test('rejects malformed, duplicate, partial, or self-referential fallback issue coverage', () => {
  const flowIds = expectedFallbackFlowIds()
  const valid = fallbackFollowUps()
  const cases = [
    ['non-array references', 'https://github.com/tyhuang9/dupert/issues/65', /follow-up issue references must be an array/],
    ['non-object reference', ['#65'], /follow-up issue reference 1 must be an object/],
    ['unexpected reference key', [{ ...valid[0], extra: true }, valid[1]], /follow-up issue reference 1 must contain exactly/],
    ['pull request URL', [{ issue_url: 'https://github.com/tyhuang9/dupert/pull/65', flow_ids: flowIds }], /canonical separate tyhuang9\/dupert issue URL/],
    ['issue 64 self-reference', [{ issue_url: 'https://github.com/tyhuang9/dupert/issues/64', flow_ids: flowIds }], /canonical separate tyhuang9\/dupert issue URL/],
    ['duplicate issue URL', [{ issue_url: valid[0].issue_url, flow_ids: valid[0].flow_ids }, { issue_url: valid[0].issue_url, flow_ids: valid[1].flow_ids }], /must not repeat issue_url values/],
    ['empty flow IDs', [{ issue_url: valid[0].issue_url, flow_ids: [] }], /flow_ids must not be empty/],
    ['non-array flow IDs', [{ issue_url: valid[0].issue_url, flow_ids: flowIds[0] }], /flow_ids must be an array/],
    ['unknown flow ID', [{ issue_url: valid[0].issue_url, flow_ids: [...flowIds, 'member.case.unknown'] }], /contains an unknown flow_id/],
    ['duplicate within issue', [{ issue_url: valid[0].issue_url, flow_ids: [...flowIds, flowIds[0]] }], /flow_ids must not repeat within an issue/],
    ['duplicate across issues', [{ issue_url: valid[0].issue_url, flow_ids: flowIds }, { issue_url: valid[1].issue_url, flow_ids: [flowIds[0]] }], /must not duplicate flow coverage/],
    ['partial catalog coverage', [{ issue_url: valid[0].issue_url, flow_ids: flowIds.slice(0, -1) }], /must cover every catalog member\/guest case and credential-lifecycle flow exactly once/],
  ]
  for (const [name, followUps, expected] of cases) {
    const result = withAdrAcceptance(completed(), { outcome: 'native_credential_transport', followUps })
    assert.match(messages(tracked(result)), expected, name)
  }
})

test('rejects raw credentials in ADR acceptance evidence', () => {
  const result = withAdrAcceptance(completed())
  result.adr_contract.security_properties = 'Authorization: Bearer raw-secret-value-that-must-not-ship'
  assert.match(messages(tracked(result)), /raw credential/)
})

test('requires issue 64 JSON evidence contract schema v3', () => {
  const candidate = sources()
  const catalog = JSON.parse(candidate.authSessionEvidenceCatalog)
  const template = JSON.parse(candidate.authSessionEvidenceTemplate)
  catalog.schema_version = 2
  template.schema_version = 2
  candidate.authSessionEvidenceCatalog = JSON.stringify(catalog)
  candidate.authSessionEvidenceTemplate = JSON.stringify(template)
  assert.match(messages(candidate), /schema_version must be 3/)
})

test('keeps issue 64 v3 markers, catalog semantics, and source template aligned', () => {
  const catalogCandidate = sources()
  const catalog = JSON.parse(catalogCandidate.authSessionEvidenceCatalog)
  catalog.adr.work_requirements.native_credential_transport.frontend.scope_ids.pop()
  catalogCandidate.authSessionEvidenceCatalog = JSON.stringify(catalog)
  assert.match(messages(catalogCandidate), /catalog ADR semantics are invalid/)

  const templateCandidate = sources()
  const template = JSON.parse(templateCandidate.authSessionEvidenceTemplate)
  template.adr_contract.fallback_outcomes = []
  template.adr_contract.follow_up_issue_references = [{ issue_url: 'https://github.com/tyhuang9/dupert/issues/65', flow_ids: ['member.case.member_login'] }]
  templateCandidate.authSessionEvidenceTemplate = JSON.stringify(template)
  const templateOutput = messages(templateCandidate)
  assert.match(templateOutput, /ADR catalogs are invalid/)
  assert.match(templateOutput, /follow_up_issue_references must remain an empty array/)

  const markerCandidate = sources()
  markerCandidate.authSessionDeviceSpike = markerCandidate.authSessionDeviceSpike.replace('contract_version=3', 'contract_version=2')
  markerCandidate.authSessionAdrTemplate = markerCandidate.authSessionAdrTemplate.replace('contract_version=3', 'contract_version=2')
  const markerOutput = messages(markerCandidate)
  assert.match(markerOutput, /issue64-spike-policy marker contract_version must equal 3/)
  assert.match(markerOutput, /issue64-adr-policy marker contract_version must equal 3/)
})

test('rejects Authorization Basic in completed procedural fields', () => {
  const result = completed(); result.platforms[0].contexts[0].cases[0].actions = 'Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ=='; assert.match(messages(tracked(result)), /raw credential/)
})

test('rejects raw password values in completed procedural fields', () => {
  const result = completed(); result.platforms[0].contexts[0].cases[0].preconditions = 'password=hunter2'; assert.match(messages(tracked(result)), /raw credential/)
})

test('rejects reset and verification URLs in completed procedural fields', () => {
  for (const url of ['https://example.test/reset/abc', 'https://example.test/verification/abc']) { const result = completed(); result.platforms[0].contexts[0].cases[0].actions = url; assert.match(messages(tracked(result)), /raw credential/) }
})

test('rejects query code secrets in completed procedural fields', () => {
  const result = completed(); result.platforms[0].contexts[0].cases[0].actions = 'https://example.test/callback?code=raw-code'; assert.match(messages(tracked(result)), /raw credential/)
})

test('rejects appended Markdown claims and raw credentials', () => {
  for (const appended of ['\nPASS\n', '\nAPPROVED\n', '\nDecision: endpoint_only_fallback\n', '\npassword=raw-secret\n']) { const candidate = sources(); candidate.authSessionAdrTemplate += appended; assert.match(messages(candidate), /canonical instruction-only document|raw credential/) }
})

test('rejects duplicate or conflicting policy markers', () => {
  const candidate = sources(); candidate.authSessionDeviceSpike += '\n<!-- issue64-spike-policy\ncontract_version=3\n-->\n'; candidate.releaseDocument += '\n<!-- issue64-release-policy\ncontract_version=3\n-->\n'; const output = messages(candidate); assert.match(output, /issue64-spike-policy marker must appear exactly once/); assert.match(output, /issue64-release-policy marker must appear exactly once/)
})

test('rejects nonexistent, timezone-free, and path-mismatched result timestamps', () => {
  for (const [timestamp, date, expected] of [['2026-02-30T12:00:00Z', '2026-02-28', /RFC3339|result path date/], ['2026-07-29T12:00:00', '2026-07-29', /RFC3339/], ['2026-07-28T12:00:00Z', '2026-07-29', /result path date/]]) { const result = completed(); for (const platform of result.platforms) { platform.metadata.test_date_time = timestamp; platform.attestation.captured_at = timestamp }; assert.match(messages(trackedAt('timestamp-run', result, date)), expected) }
})

test('rejects empty tracked input and untracked or unauthorized result copies', () => {
  assert.throws(() => assertMobileReleaseReadiness(root, []), /tracked-file input must not be empty/)
  const candidate = sources(); candidate.resultCopies = { [resultPath]: JSON.stringify(completed()), 'docs/mobile/evidence/issue-64/raw.json': '{}' }; const output = messages(candidate); assert.match(output, /result copy must be tracked/)
})

test('rejects missing and contradictory physical-device attestations', () => {
  for (const mutate of [(r) => { delete r.platforms[0].attestation }, (r) => { r.platforms[0].attestation.platform = 'android' }, (r) => { r.platforms[0].attestation.device_type = 'physical_android' }]) { const result = completed(); mutate(result); assert.match(messages(tracked(result)), /attestation/) }
})

test('rejects simulator or emulator wording in completed device metadata', () => {
  const result = completed(); result.platforms[0].metadata.device_model = 'iPhone Simulator'; result.platforms[1].metadata.tooling = 'Android Emulator'; assert.match(messages(tracked(result)), /must not describe a simulator or emulator/)
})

test('rejects reused references and cloned cross-platform evidence', () => {
  const reused = completed(); reused.platforms[0].contexts[1].cases[0].evidence.safe_reference = reused.platforms[0].contexts[0].cases[0].evidence.safe_reference; assert.match(messages(tracked(reused)), /must not reuse|must be scoped/)
  const cloned = completed(); cloned.platforms[1].contexts[0].cases[0].evidence = structuredClone(cloned.platforms[0].contexts[0].cases[0].evidence); assert.match(messages(tracked(cloned)), /must be scoped|checksum must match/)
})

test('unrelated release violations do not suppress device-contract violations', () => {
  const candidate = sources(); candidate.workflow = candidate.workflow.replace("node-version: '22'", "node-version: '24'"); const document = JSON.parse(candidate.authSessionEvidenceTemplate); document.schema_version = 4; candidate.authSessionEvidenceTemplate = JSON.stringify(document); const output = messages(candidate); assert.match(output, /CI Node version/); assert.match(output, /schema_version must be 3/)
})

test('rejects an all-FAIL completed result with cookie-only selected', () => {
  const result = completed(); const fail = (value) => { if (Array.isArray(value)) value.forEach(fail); else if (value && typeof value === 'object') { for (const [key, child] of Object.entries(value)) { if (key === 'status') value[key] = 'FAIL'; else fail(child) } } }; fail(result.platforms); assert.match(messages(tracked(result)), /must be PASS for a selected ADR decision/)
})

test('rejects a non-PASS required case', () => {
  const result = completed(); result.platforms[0].contexts[0].cases[0].status = 'BLOCKED'; assert.match(messages(tracked(result)), /status must be PASS/)
})

test('rejects a non-PASS offline boundary', () => {
  const result = completed(); result.platforms[0].contexts[0].cases.find((x) => x.session_boundaries).session_boundaries[0].status = 'UNVERIFIED'; assert.match(messages(tracked(result)), /boundary status must be PASS/)
})

test('rejects a non-PASS credential lifecycle stage', () => {
  const result = completed(); result.platforms[1].contexts[1].credential_lifecycle[0].status = 'FAIL'; assert.match(messages(tracked(result)), /lifecycle stage status must be PASS/)
})

test('rejects a non-PASS platform case while accepting the all-PASS control', () => {
  assert.deepEqual(inspectMobileReleaseReadiness(tracked()), []); const result = completed(); result.platforms[1].platform_cases[0].status = 'BLOCKED'; assert.match(messages(tracked(result)), /platform case status must be PASS/)
})

test('rejects reset_token keyed values', () => {
  const result = completed(); result.platforms[0].contexts[0].cases[0].actions = 'reset_token=raw'; assert.match(messages(tracked(result)), /raw credential/)
})

test('rejects verification-code keyed values', () => {
  const result = completed(); result.platforms[0].contexts[0].cases[0].actions = 'verification-code: raw'; assert.match(messages(tracked(result)), /raw credential/)
})

test('rejects reset-token URL query values', () => {
  const result = completed(); result.platforms[0].contexts[0].cases[0].actions = 'https://example.test/callback?reset_token=raw'; assert.match(messages(tracked(result)), /raw credential/)
})

test('rejects X-API-Key headers without flagging safe policy prose', () => {
  assert.deepEqual(inspectMobileReleaseReadiness(sources()), []); const result = completed(); result.platforms[0].contexts[0].cases[0].actions = 'X-API-Key: raw-secret'; assert.match(messages(tracked(result)), /raw credential/)
})

test('rejects protected approval claims outside the release gate table', async (t) => {
  const claims = [
    ['colon', 'Authentication and guest sessions: PASS'],
    ['em dash', 'Authentication and guest sessions — PASS'],
    ['copula', 'Device install smoke is APPROVED'],
    ['Markdown row', '| Physical-device evidence | PASS |'],
    ['privacy gate', 'Privacy and store metadata: PASS'],
    ['security PoC', 'Privacy and store metadata has passed review and is ready for release.'],
    ['soft-break PoC', 'Privacy and store\nmetadata has passed review and is ready for release.'],
    ['must-PASS bypass', 'Privacy and store metadata must PASS and has passed review.'],
    ['three-line PoC', 'Authentication and guest sessions — PASS\nDevice install smoke is APPROVED\nPhysical-device evidence: PASS'],
  ]
  for (const [name, claim] of claims) await t.test(name, () => { const candidate = sources(); candidate.releaseDocument += `\n${claim}\n`; assert.match(messages(candidate), /outside the canonical gate table/) })
})

test('allows instructional must-PASS prose outside the release gate table', () => {
  const candidate = sources(); candidate.releaseDocument += '\nAuthentication and guest sessions must PASS before review.\nPrivacy and store metadata must PASS before release.\n'; assert.doesNotMatch(messages(candidate), /outside the canonical gate table/)
})

test('rejects duplicate toolchain and release-gate blocks', () => {
  const contract = sources().releaseDocument.match(/<!-- mobile-release-contract[\s\S]*?-->/)[0]; const gates = sources().releaseDocument.match(/<!-- mobile-release-gates:start -->[\s\S]*?<!-- mobile-release-gates:end -->/)[0]; const candidate = sources(); candidate.releaseDocument += `\n${contract}\n${gates}\n`; const output = messages(candidate); assert.match(output, /exactly one machine-readable toolchain contract/); assert.match(output, /exactly one release-gate table block/)
})

test('rejects RFC3339 24:00 rollover and accepts a valid timezone offset', () => {
  const invalid = completed(); for (const platform of invalid.platforms) { platform.metadata.test_date_time = '2026-07-29T24:00:00Z'; platform.attestation.captured_at = platform.metadata.test_date_time }; assert.match(messages(tracked(invalid)), /component-valid RFC3339/); const valid = completed(); for (const platform of valid.platforms) { platform.metadata.test_date_time = '2026-07-29T12:30:45-05:00'; platform.attestation.captured_at = platform.metadata.test_date_time }; assert.deepEqual(inspectMobileReleaseReadiness(tracked(valid)), [])
})

test('requires identical commit and semantic app version across platforms', () => {
  const commitMismatch = completed(); commitMismatch.platforms[1].metadata.commit_or_tag = 'different'; assert.match(messages(tracked(commitMismatch)), /same commit_or_tag/); const versionMismatch = completed(); versionMismatch.platforms[1].metadata.app_version = '1.2.4'; assert.match(messages(tracked(versionMismatch)), /same app_version/); const invalidVersion = completed(); for (const platform of invalidVersion.platforms) platform.metadata.app_version = 'release'; assert.match(messages(tracked(invalidVersion)), /semantic versioning/)
})

test('enforces strict SemVer identifiers and accepts valid controls', () => {
  for (const version of ['01.2.3', '1.2.3-a..b', '1.2.3-01']) { const result = completed(); for (const platform of result.platforms) platform.metadata.app_version = version; assert.match(messages(tracked(result)), /semantic versioning/) }
  for (const version of ['1.2.3-alpha.1+build.5', '0.0.0']) { const result = completed(); for (const platform of result.platforms) platform.metadata.app_version = version; assert.deepEqual(inspectMobileReleaseReadiness(tracked(result)), []) }
})

test('reports incomplete procedural fields as completed-text violations', () => {
  const result = completed(); result.platforms[0].contexts[0].cases[0].actions = ''; const output = messages(tracked(result)); assert.match(output, /actions must be completed text/); assert.doesNotMatch(output, /actions must be PASS/)
})

test('rejects simulator wording independently from emulator wording', () => {
  const simulator = completed(); simulator.platforms[0].metadata.device_model = 'iPhone Simulator'; assert.match(messages(tracked(simulator)), /must not describe a simulator/); const emulator = completed(); emulator.platforms[1].metadata.tooling = 'Android Emulator'; assert.match(messages(tracked(emulator)), /must not describe a simulator/)
})

test('rejects untracked and outside-path result copies independently', () => {
  const untracked = sources(); untracked.trackedFiles = sourceFiles; untracked.resultCopies = { [resultPath]: JSON.stringify(completed()) }; assert.match(messages(untracked), /result copy must be tracked/); const outside = sources(); outside.resultCopies = { 'docs/mobile/evidence/issue-64/raw.json': '{}' }; assert.match(messages(outside), /result copy must be tracked/)
})

test('rejects duplicate ADR markers independently', () => {
  const candidate = sources(); const block = candidate.authSessionAdrTemplate.match(/<!-- issue64-adr-policy[\s\S]*?-->/)[0]; candidate.authSessionAdrTemplate += `\n${block}\n`; assert.match(messages(candidate), /issue64-adr-policy marker must appear exactly once/)
})

test('rejects network-reference reuse independently', () => {
  const result = completed(); result.platforms[0].contexts[0].cases[1].evidence.network_trace_reference = result.platforms[0].contexts[0].cases[0].evidence.network_trace_reference; assert.match(messages(tracked(result)), /must not reuse an evidence reference/)
})

test('tracked result loader accepts regular in-repository files and rejects outside symlinks', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'issue64-result-loader-'))
  const outsideRoot = mkdtempSync(join(tmpdir(), 'issue64-result-outside-'))
  try {
    const regularPath = 'docs/mobile/evidence/issue-64/2026-07-29/regular-run/results.json'
    const symlinkPath = 'docs/mobile/evidence/issue-64/2026-07-29/symlink-run/results.json'
    const directoryPath = 'docs/mobile/evidence/issue-64/2026-07-29/directory-run/results.json'
    const escapePath = 'docs/mobile/evidence/issue-64/2026-07-29/escape-run/results.json'
    mkdirSync(dirname(join(temporaryRoot, regularPath)), { recursive: true })
    mkdirSync(dirname(join(temporaryRoot, symlinkPath)), { recursive: true })
    writeFileSync(join(temporaryRoot, regularPath), '{"safe":true}\n')
    const outsideFile = join(outsideRoot, 'results.json')
    writeFileSync(outsideFile, '{"outside":true}\n')
    symlinkSync(outsideFile, join(temporaryRoot, symlinkPath))
    mkdirSync(join(temporaryRoot, directoryPath), { recursive: true })
    symlinkSync(outsideRoot, dirname(join(temporaryRoot, escapePath)), 'dir')

    const loaded = loadTrackedResultCopies(temporaryRoot, [regularPath, symlinkPath, directoryPath, escapePath])
    assert.equal(loaded.copies[regularPath], '{"safe":true}\n')
    assert.equal(loaded.copies[symlinkPath], undefined)
    assert.equal(loaded.copies[directoryPath], undefined)
    assert.equal(loaded.copies[escapePath], undefined)
    assert.equal(loaded.violations.length, 3)
    assert.match(loaded.violations.join('\n'), /regular non-symlink file inside the repository/)
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
    rmSync(outsideRoot, { recursive: true, force: true })
  }
})
