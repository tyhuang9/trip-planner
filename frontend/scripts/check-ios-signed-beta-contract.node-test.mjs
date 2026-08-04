import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { inspectIosSignedBetaContract } from './check-ios-signed-beta-contract.mjs'

const root = resolve(import.meta.dirname, '../..')
const read = (path) => readFile(resolve(root, path), 'utf8')

async function contract() {
  return {
    template: await read('docs/mobile/ios-signed-beta-evidence.template.json'),
    runbook: await read('docs/mobile/ios-signed-beta-runbook.md'),
    inspector: await read('frontend/scripts/check-ios-signed-archive.mjs'),
    release: await read('docs/mobile/release-readiness.md'),
    packageJson: await read('frontend/package.json'),
    trackedFiles: [],
  }
}

test('accepts the unexecuted signed beta source contract', async () => {
  assert.deepEqual(inspectIosSignedBetaContract(await contract()), [])
})

test('rejects evidence claims, unsafe provisioning commands, missing policy reuse, and tracked artifacts', async () => {
  const candidate = await contract()
  candidate.template = candidate.template.replace('"template_status": "UNEXECUTED"', '"template_status": "PASS"')
  candidate.runbook = candidate.runbook.replace('CODE_SIGN_STYLE=Manual archive', 'CODE_SIGN_STYLE=Manual -allowProvisioningUpdates archive')
  candidate.inspector = candidate.inspector.replaceAll('inspectIosArchiveMachO', 'inspectArchive')
  candidate.trackedFiles = ['release/App.ipa', 'ios/profile.mobileprovision']
  const output = inspectIosSignedBetaContract(candidate).join('\n')
  assert.match(output, /template_status/)
  assert.match(output, /automatic provisioning updates/)
  assert.match(output, /reuse existing native archive/)
  assert.match(output, /tracked signing input or artifact/)
})
