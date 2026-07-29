import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { assertUnsignedJarsignerResult, checkAndroidUnsignedBundle } from './check-android-unsigned-bundle.mjs'
import {
  bundletoolValidation,
  emptyZip,
  extendedTimestampExtra,
  expectedManifest,
  requiredEntries,
  unicodePathExtra,
  unsignedJarsigner,
  zipFixture,
} from './fixtures/android-unsigned-bundle.mjs'

async function fixturePaths(t, contents = zipFixture()) {
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
    if (args.includes('-qq') && args.includes('-d')) {
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
    ['-UU', '-tqq', bundle],
    ['-UU', '-qq', bundle, 'base/assets/public/*', '-d', calls[8][1][5]],
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
  const missing = await fixturePaths(t, zipFixture(requiredEntries.slice(0, -1)))
  assert.throws(
    () => checkAndroidUnsignedBundle(missing.bundle, options(missing.bundletoolJar, fixtureRunner())),
    /missing required entry: base\/assets\/public\/index\.html/,
  )
})

test('rejects duplicate, absolute, ambiguous, control, parent-traversal, and backslash archive paths', async (t) => {
  for (const [entries, expected] of [
    [[...requiredEntries, requiredEntries[0]], /duplicate archive entries/],
    [[...requiredEntries, '/absolute'], /unsafe archive path/],
    [[...requiredEntries, 'base/assets/public//ambiguous'], /unsafe archive path/],
    [[...requiredEntries, 'base/assets/public/./ambiguous'], /unsafe archive path/],
    [[...requiredEntries, 'base/assets/public/control\rname'], /control-character archive path/],
    [[...requiredEntries, 'base/assets/public/control\nname'], /control-character archive path/],
    [[...requiredEntries, 'base/assets/public/control\r\nname'], /control-character archive path/],
    [[...requiredEntries, 'base/assets/public/../escape'], /unsafe archive path/],
    [[...requiredEntries, 'base\\assets\\public\\escape'], /unsafe archive path/],
  ]) {
    const { bundle, bundletoolJar } = await fixturePaths(t, zipFixture(entries))
    assert.throws(
      () => checkAndroidUnsignedBundle(bundle, options(bundletoolJar, fixtureRunner())),
      expected,
    )
  }
})

test('allows a manifest but rejects case-insensitive JAR signature material', async (t) => {
  const manifestEntries = [...requiredEntries, 'base/assets/public/', 'META-INF/MANIFEST.MF']
  const manifest = await fixturePaths(t, zipFixture(manifestEntries))
  assert.doesNotThrow(() => checkAndroidUnsignedBundle(
    manifest.bundle,
    options(manifest.bundletoolJar, fixtureRunner()),
  ))

  for (const extension of ['SF', 'rsa', 'DsA', 'eC']) {
    const entries = [...requiredEntries, `META-INF/RELEASE.${extension}`]
    const { bundle, bundletoolJar } = await fixturePaths(t, zipFixture(entries))
    assert.throws(
      () => checkAndroidUnsignedBundle(bundle, options(bundletoolJar, fixtureRunner())),
      /JAR signing material/,
    )
  }
  for (const name of ['META-INF/SIG-CUSTOM', 'meta-inf/sig-extra.bin']) {
    const { bundle, bundletoolJar } = await fixturePaths(t, zipFixture([...requiredEntries, name]))
    assert.throws(
      () => checkAndroidUnsignedBundle(bundle, options(bundletoolJar, fixtureRunner())),
      /JAR signing material/,
    )
  }
})

test('rejects symlinks, special entries, and inconsistent central-directory evidence', async (t) => {
  for (const type of ['l', 'c', 'b', 'p', 's']) {
    const { bundle, bundletoolJar } = await fixturePaths(
      t,
      zipFixture(requiredEntries, { [requiredEntries[0]]: type }),
    )
    assert.throws(
      () => checkAndroidUnsignedBundle(bundle, options(bundletoolJar, fixtureRunner())),
      /symbolic link or unsupported archive entry/,
    )
  }
  const inconsistent = await fixturePaths(t, zipFixture(
    requiredEntries,
    {},
    { declaredEntryCount: requiredEntries.length + 1 },
  ))
  assert.throws(
    () => checkAndroidUnsignedBundle(
      inconsistent.bundle,
      options(inconsistent.bundletoolJar, fixtureRunner()),
    ),
    /invalid ZIP central-directory record/,
  )
})

test('rejects alternate path metadata and unsupported ZIP creator/type combinations', async (t) => {
  const entry = requiredEntries[0]
  const cases = [
    [
      zipFixture(requiredEntries, {}, {
        centralExtraFields: { [entry]: unicodePathExtra('../alternate-name') },
      }),
      /unsupported central ZIP extra field 0x7075 \(22 bytes\)/,
    ],
    [
      zipFixture(requiredEntries, {}, {
        centralExtraFields: {},
        localExtraFields: { [entry]: unicodePathExtra('../local-alternate-name') },
      }),
      /unsupported local ZIP extra field 0x7075 \(28 bytes\)/,
    ],
    [zipFixture(requiredEntries, {}, { hostSystem: 10 }), /unsupported ZIP creator/],
    [
      zipFixture(requiredEntries, {}, {
        externalAttributes: { [entry]: (0o120777 << 16) >>> 0 },
        hostSystem: 0,
      }),
      /unsupported ZIP creator or external file type/,
    ],
  ]
  for (const [contents, expected] of cases) {
    const { bundle, bundletoolJar } = await fixturePaths(t, contents)
    assert.throws(
      () => checkAndroidUnsignedBundle(bundle, options(bundletoolJar, fixtureRunner())),
      expected,
    )
  }

  const dos = await fixturePaths(t, zipFixture(requiredEntries, {}, { hostSystem: 0 }))
  assert.doesNotThrow(() => checkAndroidUnsignedBundle(
    dos.bundle,
    options(dos.bundletoolJar, fixtureRunner()),
  ))
})

test('accepts canonical extended timestamps with matching local and central modification time', async (t) => {
  const entry = requiredEntries[0]
  const modifiedTime = 1_785_369_600
  for (const [centralExtra, localExtra] of [
    [extendedTimestampExtra({ modifiedTime }), extendedTimestampExtra({ modifiedTime })],
    [
      extendedTimestampExtra({ modifiedTime }),
      extendedTimestampExtra({ modifiedTime, accessedTime: modifiedTime + 1 }),
    ],
  ]) {
    centralExtra.writeUInt8(localExtra.readUInt8(4), 4)
    const { bundle, bundletoolJar } = await fixturePaths(t, zipFixture(requiredEntries, {}, {
      centralExtraFields: { [entry]: centralExtra },
      localExtraFields: { [entry]: localExtra },
    }))
    assert.doesNotThrow(() => checkAndroidUnsignedBundle(
      bundle,
      options(bundletoolJar, fixtureRunner()),
    ))
  }
})

test('rejects malformed, duplicate, or mismatched extended timestamp metadata', async (t) => {
  const entry = requiredEntries[0]
  const valid = extendedTimestampExtra({ modifiedTime: 1_785_369_600 })
  const invalidFlags = Buffer.from(valid)
  invalidFlags.writeUInt8(0x81, 4)
  const missingModificationTime = Buffer.from(valid)
  missingModificationTime.writeUInt8(0x02, 4)
  const mismatchedTime = extendedTimestampExtra({ modifiedTime: 1_785_369_601 })
  const cases = [
    { centralExtraFields: { [entry]: invalidFlags }, localExtraFields: { [entry]: valid } },
    { centralExtraFields: { [entry]: missingModificationTime }, localExtraFields: { [entry]: valid } },
    { centralExtraFields: { [entry]: Buffer.concat([valid, valid]) }, localExtraFields: { [entry]: valid } },
    { centralExtraFields: { [entry]: valid }, localExtraFields: { [entry]: mismatchedTime } },
    { centralExtraFields: { [entry]: valid }, localExtraFields: {} },
  ]
  for (const extraFields of cases) {
    const { bundle, bundletoolJar } = await fixturePaths(
      t,
      zipFixture(requiredEntries, {}, extraFields),
    )
    assert.throws(
      () => checkAndroidUnsignedBundle(bundle, options(bundletoolJar, fixtureRunner())),
      /timestamp metadata/,
    )
  }
})

test('reports bounded extra-field metadata without echoing archive names or payloads', async (t) => {
  const entry = requiredEntries[0]
  const payload = '../do-not-echo-this-path'
  const { bundle, bundletoolJar } = await fixturePaths(t, zipFixture(requiredEntries, {}, {
    centralExtraFields: { [entry]: unicodePathExtra(payload) },
  }))
  let error
  assert.throws(
    () => checkAndroidUnsignedBundle(bundle, options(bundletoolJar, fixtureRunner())),
    (caught) => {
      error = caught
      return /unsupported central ZIP extra field 0x7075 \(29 bytes\)/.test(caught.message)
    },
  )
  assert.doesNotMatch(error.message, new RegExp(entry))
  assert.doesNotMatch(error.message, /do-not-echo/)
})

test('rejects truncated central and local extra-field records without reading past their bounds', async (t) => {
  const entry = requiredEntries[0]
  const shortHeader = Buffer.from([0x75, 0x70, 0x01])
  const shortPayload = Buffer.from([0x75, 0x70, 0x02, 0x00, 0x01])
  for (const extra of [shortHeader, shortPayload]) {
    for (const location of ['central', 'local']) {
      const extraFields = location === 'central'
        ? { centralExtraFields: { [entry]: extra }, localExtraFields: {} }
        : { centralExtraFields: {}, localExtraFields: { [entry]: extra } }
      const { bundle, bundletoolJar } = await fixturePaths(t, zipFixture(requiredEntries, {}, extraFields))
      assert.throws(
        () => checkAndroidUnsignedBundle(bundle, options(bundletoolJar, fixtureRunner())),
        new RegExp(`malformed ${location} ZIP extra metadata`),
      )
    }
  }
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
