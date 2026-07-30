import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertExpectedBadging, checkAndroidUnsignedArtifact } from './check-android-unsigned-artifact.mjs'
import { alignedLoad, emptyZip, packagedEntries, signingBlockZip, validBadging } from './fixtures/android-unsigned-artifact.mjs'

const tools = { aapt: 'aapt', apksigner: 'apksigner', zipalign: 'zipalign', objdump: 'llvm-objdump' }

async function fixtureApk(t, contents = emptyZip) {
  const directory = await mkdtemp(join(tmpdir(), 'dupert-android-apk-test-'))
  const apk = join(directory, 'app-release-unsigned.apk')
  await writeFile(apk, contents)
  t.after(() => rm(directory, { force: true, recursive: true }))
  return apk
}

function fixtureRunner({ entries = packagedEntries, extractedFiles = { 'index.html': '<main>native</main>' }, badging = validBadging, signature = 'DOES NOT VERIFY\nERROR: No JAR signatures', signatureStatus = 1, signatureStdout = '', signatureSignal = null, apksignerResult, load = alignedLoad, calls, apksignerError } = {}) {
  return (executable, args) => {
    calls?.push([executable, args])
    if (executable === 'aapt') return { status: 0, stdout: badging }
    if (executable === 'apksigner') {
      if (apksignerError) throw apksignerError
      return apksignerResult ?? { status: signatureStatus, stdout: signatureStdout, stderr: signature, signal: signatureSignal }
    }
    if (executable === 'zipalign') return { status: 0 }
    if (executable === 'llvm-objdump') return { status: 0, stdout: load }
    if (executable !== 'unzip') throw new Error(`unexpected tool: ${executable}`)
    if (args[0] === '-Z1') return { status: 0, stdout: `${entries.join('\n')}\n` }
    if (args[0] === '-qq' && args.includes('assets/public/*')) {
      const publicDirectory = join(args[args.indexOf('-d') + 1], 'assets', 'public')
      mkdirSync(publicDirectory, { recursive: true })
      for (const [name, contents] of Object.entries(extractedFiles)) {
        writeFileSync(join(publicDirectory, name), contents)
      }
      return { status: 0 }
    }
    return { status: 0 }
  }
}

function assertUnsignedRejected(apk, options) {
  let caught
  assert.throws(() => checkAndroidUnsignedArtifact(apk, {
    tools,
    runner: fixtureRunner(options),
    environment: {},
  }), (error) => {
    caught = error
    return /did not report an accepted unsigned result/.test(error.message)
  })
  return caught
}

test('accepts only canonical unsigned apksigner outcomes with line-ending normalization', async (t) => {
  for (const [signature, signatureStdout] of [
    ['DOES NOT VERIFY\nERROR: No JAR signatures', ''],
    ['DOES NOT VERIFY\nERROR: Missing META-INF/MANIFEST.MF', ''],
    ['DOES NOT VERIFY\r\nERROR: No JAR signatures\r\n', '\r\n'],
    ['DOES NOT VERIFY\r\nERROR: Missing META-INF/MANIFEST.MF\r\n', ''],
  ]) {
    const apk = await fixtureApk(t)
    const calls = []
    const result = checkAndroidUnsignedArtifact(apk, {
      tools: { ...tools, objdump: null },
      runner: fixtureRunner({ calls, signature, signatureStdout }),
      environment: {},
    })
    assert.deepEqual(result, { elfChecked: false, libraryCount: 0 })
    assert.deepEqual(calls.find(([tool]) => tool === 'zipalign'), ['zipalign', ['-c', '-P', '16', '-v', '4', apk]])
  }
})

test('requires exact Android package metadata', () => {
  assert.throws(() => assertExpectedBadging(validBadging.replace("targetSdkVersion:'36'", "targetSdkVersion:'35'")), /targetSdk must be 36/)
})

test('rejects signed APKs and a missing packaged entrypoint', async (t) => {
  const apk = await fixtureApk(t)
  assert.throws(() => checkAndroidUnsignedArtifact(apk, {
    tools,
    runner: fixtureRunner({ signature: 'Verified using v2 scheme', signatureStatus: 0 }),
    environment: {},
  }), /did not report an accepted unsigned result/)
  assert.throws(() => checkAndroidUnsignedArtifact(apk, {
    tools,
    runner: fixtureRunner({ entries: ['assets/public/app.js'] }),
    environment: {},
  }), /assets\/public\/index\.html/)
})

test('scans manifest-free packaged content for browser-only code', async (t) => {
  const apk = await fixtureApk(t)
  assert.throws(() => checkAndroidUnsignedArtifact(apk, {
    tools,
    runner: fixtureRunner({
      extractedFiles: {
        'index.html': '<main>native</main>',
        'app.js': 'navigator.serviceWorker.register("/sw.js")',
      },
    }),
    environment: {},
  }), /service-worker registration/)
})

test('rejects an extraction that omits the packaged entrypoint', async (t) => {
  const apk = await fixtureApk(t)
  assert.throws(() => checkAndroidUnsignedArtifact(apk, {
    tools,
    runner: fixtureRunner({ extractedFiles: {} }),
    environment: {},
  }), /packaged native entrypoint/)
})

test('rejects case-insensitive v1 signing material', async (t) => {
  const apk = await fixtureApk(t)
  assert.throws(() => checkAndroidUnsignedArtifact(apk, {
    tools,
    runner: fixtureRunner({ entries: [...packagedEntries, 'META-INF/release.Ec'] }),
    environment: {},
  }), /v1 signing material/)
})

test('rejects valid and malformed APK Signing Blocks', async (t) => {
  const signedApk = await fixtureApk(t, signingBlockZip())
  assert.throws(() => checkAndroidUnsignedArtifact(signedApk, {
    tools,
    runner: fixtureRunner(),
    environment: {},
  }), /contains an APK Signing Block/)

  const malformedApk = await fixtureApk(t, signingBlockZip({ headerSize: 23n }))
  assert.throws(() => checkAndroidUnsignedArtifact(malformedApk, {
    tools,
    runner: fixtureRunner(),
    environment: {},
  }), /malformed APK Signing Block/)
})

test('rejects generic, tampered, whitespace-modified, and extra-line signature output', async (t) => {
  const apk = await fixtureApk(t)
  for (const signature of [
    'DOES NOT VERIFY',
    'DOES NOT VERIFY\nERROR: signature did not verify for app-release-unsigned.apk',
    'DOES NOT VERIFY\nERROR: No JAR signatures ',
    'DOES NOT VERIFY\n\nERROR: No JAR signatures',
    'DOES NOT VERIFY\nERROR: No JAR signatures\nERROR: unexpected output',
    'DOES NOT VERIFY\nERROR: No JAR signatures\nWARNING: unexpected output',
  ]) {
    assert.throws(() => checkAndroidUnsignedArtifact(apk, {
      tools,
      runner: fixtureRunner({ signature }),
      environment: {},
    }), /did not report an accepted unsigned result/)
  }
})

test('fails closed when apksigner cannot run', async (t) => {
  const apk = await fixtureApk(t)
  let error
  assert.throws(() => checkAndroidUnsignedArtifact(apk, {
    tools,
    runner: fixtureRunner({ apksignerError: new Error('runtime unavailable') }),
    environment: {},
  }), (caught) => {
    error = caught
    return /apksigner failed to run/.test(caught.message)
  })
  assert.match(error.cause.message, /runtime unavailable/)
})

test('requires apksigner status exactly one', async (t) => {
  const apk = await fixtureApk(t)
  for (const signatureStatus of [0, 2, null]) {
    const error = assertUnsignedRejected(apk, { signatureStatus })
    assert.match(error.message, new RegExp(`"status":${JSON.stringify(signatureStatus)}`))
  }
})

test('rejects a signaled or invalid apksigner result', async (t) => {
  const apk = await fixtureApk(t)
  for (const options of [
    { signatureSignal: 'SIGTERM' },
    { apksignerResult: { status: 1, stdout: '', stderr: 'DOES NOT VERIFY\nERROR: No JAR signatures' } },
    { apksignerResult: false },
    { apksignerResult: [] },
  ]) {
    const error = assertUnsignedRejected(apk, options)
    assert.match(error.message, /"status":/)
    assert.match(error.message, /"signal":/)
    assert.match(error.message, /"stdout":/)
    assert.match(error.message, /"stderr":/)
  }
})

test('rejects apksigner stdout and bounds its diagnostics', async (t) => {
  const apk = await fixtureApk(t)
  const error = assertUnsignedRejected(apk, { signatureStdout: 'x'.repeat(3000) })
  assert.match(error.message, /…\[truncated\]/)
  assert.ok(error.message.length < 2300)
})

test('rejects the production signal result shape without status coercion', async (t) => {
  const apk = await fixtureApk(t)
  const error = assertUnsignedRejected(apk, {
    apksignerResult: {
      status: null,
      signal: 'SIGTERM',
      stdout: '',
      stderr: 'DOES NOT VERIFY\nERROR: No JAR signatures',
    },
  })
  assert.match(error.message, /"status":null,"signal":\{"type":"string","byteLength":7,"truncated":false,"preview":"SIGTERM"\}/)
})

test('summarizes large non-string diagnostics without serializing their contents', async (t) => {
  const apk = await fixtureApk(t)
  const largeObject = { payload: '\n'.repeat(5000) }
  const error = assertUnsignedRejected(apk, {
    apksignerResult: {
      status: largeObject,
      signal: Buffer.alloc(10000),
      stdout: Buffer.alloc(10000),
      stderr: largeObject,
    },
  })
  assert.match(error.message, /"status":\{"type":"object"\}/)
  assert.match(error.message, /"signal":\{"type":"Buffer","byteLength":10000\}/)
  assert.match(error.message, /"stdout":\{"type":"Buffer","byteLength":10000\}/)
  assert.match(error.message, /"stderr":\{"type":"object"\}/)
  assert.ok(Buffer.byteLength(error.message) < 4096)
})

test('bounds emoji and escape-heavy string diagnostics after JSON escaping', async (t) => {
  const apk = await fixtureApk(t)
  const error = assertUnsignedRejected(apk, {
    signatureStdout: `${'😀'.repeat(500)}${'\n"\\'.repeat(500)}`,
    signature: `${'\n"\\'.repeat(500)}${'😀'.repeat(500)}`,
  })
  assert.equal(error.message.match(/…\[truncated\]/g)?.length, 2)
  assert.ok(Buffer.byteLength(error.message) < 4096)
  assert.ok(!error.message.includes('\n'))
})

test('redacts the inspected APK path from diagnostics', async (t) => {
  const apk = await fixtureApk(t)
  const error = assertUnsignedRejected(apk, {
    signature: `DOES NOT VERIFY\nERROR: No JAR signatures\n${apk}`,
  })
  assert.ok(!error.message.includes(apk))
  assert.match(error.message, /<APK_PATH>/)
})

test('rejects non-string apksigner streams', async (t) => {
  const apk = await fixtureApk(t)
  assertUnsignedRejected(apk, { signatureStdout: null })
  assertUnsignedRejected(apk, { apksignerResult: { status: 1, stdout: '', stderr: null } })
})

test('rejects more than one terminal newline', async (t) => {
  const apk = await fixtureApk(t)
  assertUnsignedRejected(apk, { signature: 'DOES NOT VERIFY\nERROR: No JAR signatures\n\n' })
  assertUnsignedRejected(apk, { signatureStdout: '\n\n' })
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
