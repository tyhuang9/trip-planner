import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertExpectedBadging, checkAndroidUnsignedArtifact } from './check-android-unsigned-artifact.mjs'
import { alignedLoad, packagedEntries, validBadging } from './fixtures/android-unsigned-artifact.mjs'

const tools = { aapt: 'aapt', apksigner: 'apksigner', zipalign: 'zipalign', objdump: 'llvm-objdump' }
const emptyZip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex')

async function fixtureApk(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dupert-android-apk-test-'))
  const apk = join(directory, 'app-release-unsigned.apk')
  await writeFile(apk, emptyZip)
  t.after(() => rm(directory, { force: true, recursive: true }))
  return apk
}

function fixtureRunner({ entries = packagedEntries, badging = validBadging, signature = 'DOES NOT VERIFY\nERROR: APK is not signed', signatureStatus = 1, load = alignedLoad, calls } = {}) {
  return (executable, args) => {
    calls?.push([executable, args])
    if (executable === 'aapt') return { status: 0, stdout: badging }
    if (executable === 'apksigner') return { status: signatureStatus, stderr: signature }
    if (executable === 'zipalign') return { status: 0 }
    if (executable === 'llvm-objdump') return { status: 0, stdout: load }
    if (executable !== 'unzip') throw new Error(`unexpected tool: ${executable}`)
    if (args[0] === '-Z1') return { status: 0, stdout: `${entries.join('\n')}\n` }
    if (args[0] === '-qq' && args.includes('assets/public/*')) {
      const directory = args[args.indexOf('-d') + 1]
      mkdirSync(join(directory, 'assets', 'public', '.vite'), { recursive: true })
      writeFileSync(join(directory, 'assets', 'public', 'index.html'), '<main>native</main>')
      writeFileSync(join(directory, 'assets', 'public', '.vite', 'manifest.json'), '{}')
      return { status: 0 }
    }
    return { status: 0 }
  }
}

test('accepts an unsigned APK fixture with no packaged native libraries', async (t) => {
  const apk = await fixtureApk(t)
  const calls = []
  const result = checkAndroidUnsignedArtifact(apk, { tools, runner: fixtureRunner({ calls }), environment: {} })
  assert.deepEqual(result, { elfChecked: false, libraryCount: 0 })
  assert.deepEqual(calls.find(([tool]) => tool === 'zipalign'), ['zipalign', ['-c', '-P', '16', '-v', '4', apk]])
})

test('requires exact Android package metadata', () => {
  assert.throws(() => assertExpectedBadging(validBadging.replace("targetSdkVersion:'36'", "targetSdkVersion:'35'")), /targetSdk must be 36/)
})

test('rejects signed APKs and missing packaged public files', async (t) => {
  const apk = await fixtureApk(t)
  assert.throws(() => checkAndroidUnsignedArtifact(apk, {
    tools,
    runner: fixtureRunner({ signature: 'Verified using v2 scheme', signatureStatus: 0 }),
    environment: {},
  }), /must be unsigned/)
  assert.throws(() => checkAndroidUnsignedArtifact(apk, {
    tools,
    runner: fixtureRunner({ entries: ['assets/public/index.html'] }),
    environment: {},
  }), /manifest\.json/)
})

test('checks every packaged native library for 16 KB LOAD alignment', async (t) => {
  const apk = await fixtureApk(t)
  const entries = [...packagedEntries, 'lib/arm64-v8a/libdupert.so']
  assert.throws(() => checkAndroidUnsignedArtifact(apk, {
    tools,
    runner: fixtureRunner({ entries, load: '  LOAD off 0x0 vaddr 0x0 align 2**12' }),
    environment: {},
  }), /below 16 KB/)
})

test('uses llvm-objdump for every packaged native library', async (t) => {
  const apk = await fixtureApk(t)
  const calls = []
  const entries = [...packagedEntries, 'lib/arm64-v8a/libone.so', 'lib/x86_64/libtwo.so']
  const result = checkAndroidUnsignedArtifact(apk, {
    tools,
    runner: fixtureRunner({ entries, calls }),
    environment: {},
  })
  assert.deepEqual(result, { elfChecked: true, libraryCount: 2 })
  assert.equal(calls.filter(([tool]) => tool === 'llvm-objdump').length, 2)
})
