import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { assertUnsignedJarsignerResult, checkAndroidUnsignedBundle } from './check-android-unsigned-bundle.mjs'
import {
  archiveDetails,
  bundletoolValidation,
  emptyZip,
  expectedManifest,
  requiredEntries,
  unsignedJarsigner,
} from './fixtures/android-unsigned-bundle.mjs'

async function fixturePaths(t, contents = emptyZip) {
  const directory = await mkdtemp(join(tmpdir(), 'dupert-android-aab-test-'))
  const bundle = join(directory, 'app-release.aab')
  const bundletoolJar = join(directory, 'bundletool-all-1.18.3.jar')
  await Promise.all([writeFile(bundle, contents), writeFile(bundletoolJar, 'fixture')])
  t.after(() => rm(directory, { force: true, recursive: true }))
  return { bundle, bundletoolJar }
}

function success(stdout = '') {
  return { status: 0, signal: null, stdout, stderr: '' }
}

function fixtureRunner({
  entries = requiredEntries,
  details = archiveDetails(entries),
  extractedFiles = { 'index.html': '<main>native</main>' },
  validationResult,
  manifestResults = {},
  jarsignerResult = unsignedJarsigner,
  jarsignerError,
  javaError,
  unzipResult,
  calls,
} = {}) {
  return (executable, args) => {
    calls?.push([executable, args])
    if (executable === 'java') {
      if (javaError) throw javaError
      if (args[2] === 'validate') return validationResult === undefined ? success(bundletoolValidation()) : validationResult
      const xpath = args.find((arg) => arg.startsWith('--xpath='))?.slice('--xpath='.length)
      return Object.hasOwn(manifestResults, xpath) ? manifestResults[xpath] : success(`${expectedManifest.get(xpath)}\n`)
    }
    if (executable === 'jarsigner') {
      if (jarsignerError) throw jarsignerError
      return jarsignerResult
    }
    if (executable !== 'unzip') throw new Error(`unexpected tool: ${executable}`)
    if (unzipResult) return unzipResult
    if (args[0] === '-Z1') return success(`${entries.join('\n')}\n`)
    if (args[0] === '-Z' && args[1] === '-l') return success(details)
    if (args[0] === '-qq') {
      const publicDirectory = join(args[args.indexOf('-d') + 1], 'base', 'assets', 'public')
      mkdirSync(publicDirectory, { recursive: true })
      for (const [name, contents] of Object.entries(extractedFiles)) {
        const path = join(publicDirectory, name)
        mkdirSync(dirname(path), { recursive: true })
        writeFileSync(path, contents)
      }
    }
    return success()
  }
}

function options(bundletoolJar, runner) {
  return { environment: { BUNDLETOOL_JAR_PATH: bundletoolJar }, runner }
}

test('accepts a validated unsigned AAB and invokes pinned tools with exact argument arrays', async (t) => {
  const { bundle, bundletoolJar } = await fixturePaths(t)
  const calls = []
  const result = checkAndroidUnsignedBundle(bundle, options(bundletoolJar, fixtureRunner({ calls })))

  assert.deepEqual(result, { entryCount: requiredEntries.length })
  assert.deepEqual(calls.slice(0, 6), [
    ['java', ['-jar', bundletoolJar, 'validate', `--bundle=${bundle}`]],
    ...[...expectedManifest.keys()].map((xpath) => [
      'java',
      ['-jar', bundletoolJar, 'dump', 'manifest', `--bundle=${bundle}`, `--xpath=${xpath}`],
    ]),
  ])
  assert.deepEqual(calls[6], ['jarsigner', ['-verify', bundle]])
  assert.deepEqual(calls.slice(7).map(([, args]) => args), [
    ['-tqq', bundle],
    ['-Z1', bundle],
    ['-Z', '-l', bundle],
    ['-qq', bundle, 'base/assets/public/*', '-d', calls[10][1][4]],
  ])
})

test('accepts only the two canonical Java 21 unsigned outputs with CRLF normalization', () => {
  for (const stdout of [
    '\njar is unsigned.\n',
    '\nno manifest.\n\njar is unsigned.\n',
    '\r\njar is unsigned.\r\n',
    '\r\nno manifest.\r\n\r\njar is unsigned.\r\n',
  ]) {
    assert.doesNotThrow(() => assertUnsignedJarsignerResult({ ...unsignedJarsigner, stdout }))
  }
})

test('rejects signed, modified, signaled, failed, and malformed jarsigner evidence', () => {
  for (const result of [
    { ...unsignedJarsigner, stdout: 'jar verified.\n' },
    { ...unsignedJarsigner, stdout: '\njar is unsigned.\nextra\n' },
    { ...unsignedJarsigner, stdout: '\njar is unsigned.\n', stderr: 'warning' },
    { ...unsignedJarsigner, status: 1 },
    { ...unsignedJarsigner, status: null },
    { ...unsignedJarsigner, signal: 'SIGTERM' },
    { status: 0, signal: null, stdout: '\njar is unsigned.\n' },
    null,
    [],
  ]) {
    assert.throws(() => assertUnsignedJarsignerResult(result), /unexpected result|accepted unsigned result/)
  }
})

test('fails closed when jarsigner cannot spawn', async (t) => {
  const { bundle, bundletoolJar } = await fixturePaths(t)
  let error
  assert.throws(() => checkAndroidUnsignedBundle(bundle, options(bundletoolJar, fixtureRunner({
    jarsignerError: new Error('runtime unavailable'),
  }))), (caught) => {
    error = caught
    return /jarsigner failed to run/.test(caught.message)
  })
  assert.match(error.cause.message, /runtime unavailable/)
})

test('requires an absolute regular-file bundletool path', async (t) => {
  const { bundle, bundletoolJar } = await fixturePaths(t)
  assert.throws(() => checkAndroidUnsignedBundle(bundle, { environment: {}, runner: fixtureRunner() }), /BUNDLETOOL_JAR_PATH is required/)
  assert.throws(() => checkAndroidUnsignedBundle(bundle, options('bundletool.jar', fixtureRunner())), /must be absolute/)
  assert.throws(() => checkAndroidUnsignedBundle(bundle, options(`${bundletoolJar}.missing`, fixtureRunner())), /not a regular file/)
  const directory = join(dirname(bundletoolJar), 'bundletool-directory')
  await mkdir(directory)
  assert.throws(() => checkAndroidUnsignedBundle(bundle, options(directory, fixtureRunner())), /not a regular file/)
})

test('fails closed on bundletool validation status, signal, stderr, output, and spawn errors', async (t) => {
  const { bundle, bundletoolJar } = await fixturePaths(t)
  for (const validationResult of [
    { ...success(bundletoolValidation()), status: 1 },
    { ...success(bundletoolValidation()), status: null },
    { ...success(bundletoolValidation()), signal: 'SIGTERM' },
    { ...success(bundletoolValidation()), stderr: 'warning' },
    success('App Bundle information\n'),
    null,
  ]) {
    assert.throws(
      () => checkAndroidUnsignedBundle(bundle, options(bundletoolJar, fixtureRunner({ validationResult }))),
      /bundletool validate returned an unexpected result|bundletool validate returned unexpected output/,
    )
  }
  assert.throws(
    () => checkAndroidUnsignedBundle(bundle, options(bundletoolJar, fixtureRunner({ javaError: new Error('no java') }))),
    /bundletool validate failed to run/,
  )
})

test('requires exact bundletool manifest scalar output and metadata', async (t) => {
  const { bundle, bundletoolJar } = await fixturePaths(t)
  const xpath = '/manifest/uses-sdk/@android:targetSdkVersion'
  for (const [index, result] of [
    success('35\n'),
    success('36'),
    success('36\nextra\n'),
    { ...success('36\n'), stderr: 'warning' },
    { ...success('36\n'), status: 1 },
    { ...success('36\n'), signal: 'SIGTERM' },
  ].entries()) {
    assert.throws(
      () => checkAndroidUnsignedBundle(bundle, options(bundletoolJar, fixtureRunner({
        manifestResults: { [xpath]: result },
      }))),
      /manifest query|manifest .* must be 36/,
      `manifest evidence case ${index}`,
    )
  }
})

test('normalizes only CRLF in bundletool outputs', async (t) => {
  const { bundle, bundletoolJar } = await fixturePaths(t)
  const manifestResults = Object.fromEntries([...expectedManifest].map(([xpath, value]) => [xpath, success(`${value}\r\n`)]))
  const runner = fixtureRunner({
    validationResult: success(bundletoolValidation().replaceAll('\n', '\r\n')),
    manifestResults,
    jarsignerResult: { ...unsignedJarsigner, stdout: '\r\njar is unsigned.\r\n' },
  })
  assert.doesNotThrow(() => checkAndroidUnsignedBundle(bundle, options(bundletoolJar, runner)))
})

test('rejects malformed ZIP evidence, unzip failures, and missing required entries', async (t) => {
  const malformed = await fixturePaths(t, Buffer.from('not a zip'))
  assert.throws(
    () => checkAndroidUnsignedBundle(malformed.bundle, options(malformed.bundletoolJar, fixtureRunner())),
    /not a valid ZIP file/,
  )

  const { bundle, bundletoolJar } = await fixturePaths(t)
  assert.throws(
    () => checkAndroidUnsignedBundle(bundle, options(bundletoolJar, fixtureRunner({ unzipResult: { ...success(), status: 2 } }))),
    /unzip integrity check returned an unexpected result/,
  )
  assert.throws(
    () => checkAndroidUnsignedBundle(bundle, options(bundletoolJar, fixtureRunner({ entries: requiredEntries.slice(0, -1) }))),
    /missing required entry: base\/assets\/public\/index\.html/,
  )
})

test('rejects duplicate, absolute, ambiguous, parent-traversal, and backslash archive paths', async (t) => {
  const { bundle, bundletoolJar } = await fixturePaths(t)
  for (const [entries, expected] of [
    [[...requiredEntries, requiredEntries[0]], /duplicate archive entries/],
    [[...requiredEntries, '/absolute'], /unsafe archive path/],
    [[...requiredEntries, 'base/assets/public//ambiguous'], /unsafe archive path/],
    [[...requiredEntries, 'base/assets/public/./ambiguous'], /unsafe archive path/],
    [[...requiredEntries, 'base/assets/public/control\rname'], /unsafe archive path/],
    [[...requiredEntries, 'base/assets/public/../escape'], /unsafe archive path/],
    [[...requiredEntries, 'base\\assets\\public\\escape'], /unsafe archive path/],
  ]) {
    assert.throws(
      () => checkAndroidUnsignedBundle(bundle, options(bundletoolJar, fixtureRunner({ entries }))),
      expected,
    )
  }
})

test('allows a manifest but rejects case-insensitive JAR signature material', async (t) => {
  const { bundle, bundletoolJar } = await fixturePaths(t)
  const manifestEntries = [...requiredEntries, 'base/assets/public/', 'META-INF/MANIFEST.MF']
  assert.doesNotThrow(() => checkAndroidUnsignedBundle(bundle, options(bundletoolJar, fixtureRunner({ entries: manifestEntries }))))

  for (const extension of ['SF', 'rsa', 'DsA', 'eC']) {
    const entries = [...requiredEntries, `META-INF/RELEASE.${extension}`]
    assert.throws(
      () => checkAndroidUnsignedBundle(bundle, options(bundletoolJar, fixtureRunner({ entries }))),
      /JAR signing material/,
    )
  }
})

test('rejects symlinks, special entries, and incomplete file-type evidence', async (t) => {
  const { bundle, bundletoolJar } = await fixturePaths(t)
  for (const type of ['l', 'c', 'b', 'p', 's']) {
    const details = archiveDetails(requiredEntries, { [requiredEntries[0]]: type })
    assert.throws(
      () => checkAndroidUnsignedBundle(bundle, options(bundletoolJar, fixtureRunner({ details }))),
      /symbolic link or unsupported archive entry/,
    )
  }
  assert.throws(
    () => checkAndroidUnsignedBundle(bundle, options(bundletoolJar, fixtureRunner({ details: archiveDetails(requiredEntries).split('\n').slice(0, -3).join('\n') }))),
    /did not report file types for every AAB entry/,
  )
})

test('reuses packaged-native policy and rejects an omitted extracted entrypoint', async (t) => {
  const { bundle, bundletoolJar } = await fixturePaths(t)
  assert.throws(() => checkAndroidUnsignedBundle(bundle, options(bundletoolJar, fixtureRunner({
    extractedFiles: {
      'index.html': '<main>native</main>',
      'assets/app.js': 'navigator.serviceWorker.register("/sw.js")',
    },
  }))), /service-worker registration/)
  assert.throws(
    () => checkAndroidUnsignedBundle(bundle, options(bundletoolJar, fixtureRunner({ extractedFiles: {} }))),
    /packaged native entrypoint/,
  )
})

test('requires the canonical app-release.aab filename before invoking tools', async (t) => {
  const { bundletoolJar } = await fixturePaths(t)
  const directory = dirname(bundletoolJar)
  const wrongName = join(directory, 'artifact.aab')
  await writeFile(wrongName, emptyZip)
  assert.throws(() => checkAndroidUnsignedBundle(join(directory, 'missing.aab'), options(bundletoolJar, fixtureRunner())), /AAB does not exist/)
  assert.throws(() => checkAndroidUnsignedBundle(wrongName, options(bundletoolJar, fixtureRunner())), /filename must be app-release\.aab/)
})
