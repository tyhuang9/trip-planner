import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  assertPackagedNativeBundlePolicy,
  inspectNativeBundle,
} from './check-native-bundle-policy.mjs'

async function createBundle(files, { manifest = true } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dupert-native-bundle-'))
  if (manifest) {
    await mkdir(join(directory, '.vite'))
    await writeFile(join(directory, '.vite', 'manifest.json'), '{}')
  }
  await Promise.all(Object.entries(files).map(([name, contents]) =>
    writeFile(join(directory, name), contents),
  ))
  return directory
}

test('accepts a native bundle without browser-only integrations', async (t) => {
  const directory = await createBundle({ 'app.js': 'const target = "native";' })
  t.after(() => rm(directory, { force: true, recursive: true }))

  assert.deepEqual(inspectNativeBundle(directory, {}), [])
})

test('reports browser-only source and configured value leakage without echoing values', async (t) => {
  const directory = await createBundle({
    'app.js': 'navigator.serviceWorker.register("/sw.js"); const key = "public-browser-key"; const heading = "Private trip planner";',
  })
  t.after(() => rm(directory, { force: true, recursive: true }))

  assert.deepEqual(inspectNativeBundle(directory, { VITE_GOOGLE_MAPS_API_KEY: 'public-browser-key' }), [
    {
      file: 'app.js',
      findings: ['service-worker registration', 'AppAccessGate UI', 'VITE_GOOGLE_MAPS_API_KEY value'],
    },
  ])
})

test('keeps the Vite manifest mandatory for source bundle inspection', async (t) => {
  const directory = await createBundle({ 'index.html': '<main>native</main>' }, { manifest: false })
  t.after(() => rm(directory, { force: true, recursive: true }))

  assert.throws(() => inspectNativeBundle(directory, {}), /Could not find a Vite manifest/)
})

test('rejects a directory masquerading as the source Vite manifest', async (t) => {
  const directory = await createBundle({ 'index.html': '<main>native</main>' }, { manifest: false })
  await mkdir(join(directory, '.vite', 'manifest.json'), { recursive: true })
  t.after(() => rm(directory, { force: true, recursive: true }))

  assert.throws(() => inspectNativeBundle(directory, {}), /Could not find a Vite manifest/)
})

test('accepts a packaged native bundle with an entrypoint and no Vite manifest', async (t) => {
  const directory = await createBundle({ 'index.html': '<main>native</main>' }, { manifest: false })
  t.after(() => rm(directory, { force: true, recursive: true }))

  assert.doesNotThrow(() => assertPackagedNativeBundlePolicy(directory, {}))
})

test('rejects a packaged native bundle without an entrypoint', async (t) => {
  const directory = await createBundle({ 'app.js': 'const target = "native";' }, { manifest: false })
  t.after(() => rm(directory, { force: true, recursive: true }))

  assert.throws(() => assertPackagedNativeBundlePolicy(directory, {}), /packaged native entrypoint/)
})

test('rejects a packaged entrypoint symlink', async (t) => {
  const directory = await createBundle({ 'real-index.html': '<main>native</main>' }, { manifest: false })
  await symlink('real-index.html', join(directory, 'index.html'))
  t.after(() => rm(directory, { force: true, recursive: true }))

  assert.throws(() => assertPackagedNativeBundlePolicy(directory, {}), /packaged native entrypoint/)
})

test('rejects nested symlinks instead of silently skipping them', async (t) => {
  const directory = await createBundle({ 'index.html': '<main>native</main>' }, { manifest: false })
  await mkdir(join(directory, 'assets'))
  await symlink('../index.html', join(directory, 'assets', 'linked.html'))
  t.after(() => rm(directory, { force: true, recursive: true }))

  assert.throws(
    () => assertPackagedNativeBundlePolicy(directory, {}),
    /symbolic link or unsupported filesystem entry/,
  )
})

test('scans manifest-free packaged content without exposing configured values', async (t) => {
  const configuredValue = 'packaged-browser-key'
  const directory = await createBundle({
    'index.html': '<main>native</main>',
  }, { manifest: false })
  await mkdir(join(directory, 'assets'))
  await writeFile(
    join(directory, 'assets', 'app.js'),
    `navigator.serviceWorker.register('/sw.js'); const key = '${configuredValue}';`,
  )
  t.after(() => rm(directory, { force: true, recursive: true }))

  let error
  assert.throws(() => assertPackagedNativeBundlePolicy(directory, {
    VITE_GOOGLE_MAPS_API_KEY: configuredValue,
  }), (caught) => {
    error = caught
    return /assets\/app\.js: service-worker registration/.test(caught.message)
      && /VITE_GOOGLE_MAPS_API_KEY value/.test(caught.message)
  })
  assert.ok(!error.message.includes(configuredValue))
})
