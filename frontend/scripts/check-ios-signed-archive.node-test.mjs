import assert from 'node:assert/strict'
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inspectIosSignedArchive, parseArguments } from './check-ios-signed-archive.mjs'

const teamId = 'UK537LHYVG'
const bundleId = 'io.github.tyhuang9.dupert'
const info = `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleShortVersionString</key><string>1.0</string><key>CFBundleVersion</key><string>1</string></dict></plist>`
const entitlements = `<?xml version="1.0"?><plist><dict><key>application-identifier</key><string>${teamId}.${bundleId}</string><key>get-task-allow</key><false/></dict></plist>`
const profile = `<?xml version="1.0"?><plist><dict><key>TeamIdentifier</key><array><string>${teamId}</string></array><key>application-identifier</key><string>${teamId}.${bundleId}</string><key>get-task-allow</key><false/></dict></plist>`

async function archiveFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'dupert-signed-archive-'))
  const app = join(root, 'Products', 'Applications', 'App.app')
  await mkdir(join(app, 'public'), { recursive: true })
  await writeFile(join(app, 'Info.plist'), info)
  await writeFile(join(app, 'embedded.mobileprovision'), 'profile')
  await writeFile(join(app, 'capacitor.config.json'), JSON.stringify({
    appId: bundleId, appName: 'Dupert', webDir: 'dist',
    server: { hostname: 'localhost', iosScheme: 'capacitor', androidScheme: 'https' },
  }))
  await cp(new URL('../ios/App/App/PrivacyInfo.xcprivacy', import.meta.url), join(app, 'PrivacyInfo.xcprivacy'))
  await writeFile(join(app, 'public', 'index.html'), '<script>https://dupert.onrender.com</script>')
  t.after(() => rm(root, { force: true, recursive: true }))
  return root
}

function runner({ entitlementSource = entitlements, profileSource = profile, verifyStatus = 0 } = {}) {
  return (command, args) => {
    if (command === '/usr/bin/plutil') return { status: 0, stdout: info, stderr: '' }
    if (command === '/usr/bin/codesign' && args[0] === '--verify') return { status: verifyStatus, stdout: '', stderr: '' }
    if (command === '/usr/bin/codesign') return { status: 0, stdout: entitlementSource, stderr: '' }
    if (command === '/usr/bin/security') return { status: 0, stdout: profileSource, stderr: '' }
    throw new Error(`unexpected command ${command}`)
  }
}

function expected(archive) {
  return {
    archive,
    bundleId,
    version: '1.0',
    build: '1',
    teamId,
    productionApiOrigin: 'https://dupert.onrender.com',
  }
}

test('accepts a controlled signed archive shape without exposing signing payloads', async (t) => {
  const archive = await archiveFixture(t)
  assert.deepEqual(inspectIosSignedArchive(expected(archive), {
    runner: runner(),
    inspectBundle: () => undefined,
    inspectMachO: () => undefined,
  }), { appPath: join(archive, 'Products', 'Applications', 'App.app') })
})

test('fails closed for invalid signatures, profile identities, and unsafe packaged configuration', async (t) => {
  const archive = await archiveFixture(t)
  const dependencies = { inspectBundle: () => undefined, inspectMachO: () => undefined }
  assert.throws(() => inspectIosSignedArchive(expected(archive), { ...dependencies, runner: runner({ verifyStatus: 1 }) }), /codesign did not complete successfully/)
  assert.throws(() => inspectIosSignedArchive(expected(archive), {
    ...dependencies,
    runner: runner({ profileSource: profile.replace(teamId, 'AAAAAAAAAA') }),
  }), /provisioning profile Team/)
  await writeFile(join(archive, 'Products', 'Applications', 'App.app', 'public', 'index.html'), 'http://localhost:8000')
  assert.throws(() => inspectIosSignedArchive(expected(archive), { ...dependencies, runner: runner() }), /production API origin/)
})

test('requires complete non-secret controlled expectations', () => {
  const args = ['--archive', '/tmp/archive', '--bundle-id', bundleId, '--version', '1.0', '--build', '1', '--team-id', teamId, '--production-api-origin', 'https://dupert.onrender.com']
  assert.deepEqual(parseArguments(args), {
    archive: '/tmp/archive', bundleId, version: '1.0', build: '1', teamId, productionApiOrigin: 'https://dupert.onrender.com',
  })
  assert.throws(() => parseArguments([...args.slice(0, -1), 'http://localhost:8000']), /production-api-origin/)
})
