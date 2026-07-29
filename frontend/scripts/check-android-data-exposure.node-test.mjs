import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { inspectAndroidDataExposure } from './check-android-data-exposure.mjs'

const manifest = '<manifest><application android:allowBackup="false" /></manifest>'

async function createAndroidApp(manifestContents = manifest, files = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dupert-android-policy-'))
  const source = join(directory, 'src', 'main')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'AndroidManifest.xml'), manifestContents)
  await Promise.all(Object.entries(files).map(async ([path, contents]) => {
    const file = join(source, path)
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, contents)
  }))
  return directory
}

test('accepts the committed Android data-exposure boundary', () => {
  assert.deepEqual(inspectAndroidDataExposure('android/app'), [])
})

test('rejects missing, unsafe, and duplicate backup declarations', async (t) => {
  const cases = [
    '<manifest><application /></manifest>',
    '<manifest><application android:allowBackup="true" /></manifest>',
    '<manifest><application android:allowBackup="false" android:allowBackup="false" /></manifest>',
  ]
  for (const candidate of cases) {
    const directory = await createAndroidApp(candidate)
    t.after(() => rm(directory, { force: true, recursive: true }))
    assert.match(inspectAndroidDataExposure(directory).join('\n'), /allowBackup/)
  }
})

test('rejects a FileProvider, file_paths.xml, and broad paths', async (t) => {
  const directory = await createAndroidApp(
    '<manifest><application android:allowBackup="false"><provider android:name="androidx.core.content.FileProvider" /></application></manifest>',
    { 'res/xml/file_paths.xml': '<paths><external-path name="all" path="." /></paths>' },
  )
  t.after(() => rm(directory, { force: true, recursive: true }))
  const result = inspectAndroidDataExposure(directory).join('\n')
  assert.match(result, /FileProvider/)
  assert.match(result, /file_paths\.xml/)
  assert.match(result, /broad external-path/)

  const cacheDirectory = await createAndroidApp(manifest, {
    'res/xml/paths.xml': '<paths><cache-path name="all" path="/" /></paths>',
  })
  t.after(() => rm(cacheDirectory, { force: true, recursive: true }))
  assert.match(inspectAndroidDataExposure(cacheDirectory).join('\n'), /broad external-path or cache-path/)
})

test('rejects unsafe release-source-set additions', async (t) => {
  const directory = await createAndroidApp()
  const releaseManifest = join(directory, 'src', 'release', 'AndroidManifest.xml')
  await mkdir(dirname(releaseManifest), { recursive: true })
  await writeFile(releaseManifest, '<manifest><application><provider android:name="androidx.core.content.FileProvider" /></application></manifest>')
  t.after(() => rm(directory, { force: true, recursive: true }))

  assert.match(inspectAndroidDataExposure(directory).join('\n'), /FileProvider/)
})
