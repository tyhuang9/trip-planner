import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPackagedNativeBundlePolicy } from './check-native-bundle-policy.mjs'

const REQUIRED_ENTRIES = [
  'BundleConfig.pb',
  'base/manifest/AndroidManifest.xml',
  'base/assets/public/index.html',
]
const EXPECTED_MANIFEST = new Map([
  ['/manifest/@package', 'io.github.tyhuang9.dupert'],
  ['/manifest/@android:versionCode', '1'],
  ['/manifest/@android:versionName', '1.0'],
  ['/manifest/uses-sdk/@android:minSdkVersion', '24'],
  ['/manifest/uses-sdk/@android:targetSdkVersion', '36'],
])
const UNSIGNED_JARSIGNER_OUTPUTS = new Set([
  '\njar is unsigned.\n',
  '\nno manifest.\n\njar is unsigned.\n',
])

function defaultRunner(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8' })
  if (result.error) throw new Error(`Could not run ${executable}: ${result.error.message}`)
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function normalizeLineEndings(value) {
  return value.replaceAll('\r\n', '\n')
}

function assertResultShape(result, label) {
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || result.status !== 0 || result.signal !== null
    || typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
    || result.stderr !== '') {
    throw new Error(`${label} returned an unexpected result`)
  }
  return normalizeLineEndings(result.stdout)
}

function run(runner, executable, args, label) {
  let result
  try {
    result = runner(executable, args)
  } catch (error) {
    throw new Error(`${label} failed to run`, { cause: error })
  }
  return assertResultShape(result, label)
}

function assertBundletoolValidationOutput(stdout) {
  const lines = stdout.split('\n')
  if (lines.at(-1) === '') lines.pop()
  if (lines.length < 5
    || lines[0] !== 'App Bundle information'
    || lines[1] !== '------------'
    || lines[2] !== 'Feature modules:'
    || lines[3] !== '\tFeature module: base'
    || lines.slice(4).some((line) => !/^\t\tFile: [^\\\r\n]+$/.test(line))) {
    throw new Error('bundletool validate returned unexpected output')
  }
}

export function assertUnsignedJarsignerResult(result) {
  const stdout = assertResultShape(result, 'jarsigner -verify')
  if (!UNSIGNED_JARSIGNER_OUTPUTS.has(stdout)) {
    throw new Error('jarsigner -verify did not report an accepted unsigned result')
  }
}

function resolveBundletoolJar(environment) {
  const configuredPath = environment.BUNDLETOOL_JAR_PATH
  if (!configuredPath) throw new Error('BUNDLETOOL_JAR_PATH is required')
  if (!isAbsolute(configuredPath)) throw new Error('BUNDLETOOL_JAR_PATH must be absolute')
  const jarPath = resolve(configuredPath)
  if (!existsSync(jarPath) || !statSync(jarPath).isFile()) {
    throw new Error(`BUNDLETOOL_JAR_PATH is not a regular file: ${jarPath}`)
  }
  return jarPath
}

function assertBundletool(runner, jarPath, bundlePath) {
  const prefix = ['-jar', jarPath]
  const bundle = `--bundle=${bundlePath}`
  const validation = run(runner, 'java', [...prefix, 'validate', bundle], 'bundletool validate')
  assertBundletoolValidationOutput(validation)

  for (const [xpath, expected] of EXPECTED_MANIFEST) {
    const output = run(
      runner,
      'java',
      [...prefix, 'dump', 'manifest', bundle, `--xpath=${xpath}`],
      `bundletool manifest query ${xpath}`,
    )
    if (output !== `${expected}\n`) {
      throw new Error(`AAB manifest ${xpath} must be ${expected}`)
    }
  }
}

function assertZipFile(bundlePath) {
  const bytes = readFileSync(bundlePath)
  const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06])
  const eocdOffset = bytes.lastIndexOf(eocd)
  if (bytes.length < 22 || eocdOffset < Math.max(0, bytes.length - 65557)
    || eocdOffset + 22 > bytes.length
    || eocdOffset + 22 + bytes.readUInt16LE(eocdOffset + 20) !== bytes.length) {
    throw new Error(`AAB is not a valid ZIP file: ${bundlePath}`)
  }
}

function assertSafeEntry(entry) {
  const normalizedEntry = entry.endsWith('/') ? entry.slice(0, -1) : entry
  const segments = normalizedEntry.split('/')
  if (!entry || entry.startsWith('/') || entry.includes('\\') || /[\0-\x1f\x7f]/.test(entry)
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`AAB contains an unsafe archive path: ${entry}`)
  }
}

function assertArchiveEntries(entries, details) {
  if (new Set(entries).size !== entries.length) throw new Error('AAB contains duplicate archive entries')
  for (const entry of entries) assertSafeEntry(entry)

  const signingEntry = entries.find((entry) => /^META-INF\/[^/]+\.(?:SF|RSA|DSA|EC)$/i.test(entry))
  if (signingEntry) throw new Error(`AAB contains JAR signing material: ${signingEntry}`)

  for (const required of REQUIRED_ENTRIES) {
    if (!entries.includes(required)) throw new Error(`AAB is missing required entry: ${required}`)
  }

  const modes = details.split('\n').flatMap((line) => {
    const match = line.match(/^(\S+)\s+\d+\.\d+\s+(?:fat|unx)\s+/)
    return match ? [match[1][0]] : []
  })
  if (modes.length !== entries.length) throw new Error('unzip did not report file types for every AAB entry')
  if (modes.some((type) => type !== '-' && type !== 'd')) {
    throw new Error('AAB contains a symbolic link or unsupported archive entry')
  }
}

export function checkAndroidUnsignedBundle(bundlePath, { environment = process.env, runner = defaultRunner } = {}) {
  const resolvedBundle = resolve(bundlePath)
  if (!existsSync(resolvedBundle) || !statSync(resolvedBundle).isFile()) {
    throw new Error(`AAB does not exist: ${resolvedBundle}`)
  }
  if (basename(resolvedBundle) !== 'app-release.aab') {
    throw new Error('AAB filename must be app-release.aab')
  }

  const bundletoolJar = resolveBundletoolJar(environment)
  assertBundletool(runner, bundletoolJar, resolvedBundle)

  let jarsignerResult
  try {
    jarsignerResult = runner('jarsigner', ['-verify', resolvedBundle])
  } catch (error) {
    throw new Error('jarsigner failed to run while confirming the AAB is unsigned', { cause: error })
  }
  assertUnsignedJarsignerResult(jarsignerResult)

  assertZipFile(resolvedBundle)
  run(runner, 'unzip', ['-tqq', resolvedBundle], 'unzip integrity check')
  const entries = run(runner, 'unzip', ['-Z1', resolvedBundle], 'unzip entry listing')
    .split(/\r?\n/)
    .filter(Boolean)
  const details = run(runner, 'unzip', ['-Z', '-l', resolvedBundle], 'unzip file-type listing')
  assertArchiveEntries(entries, details)

  const directory = mkdtempSync(join(tmpdir(), 'dupert-android-aab-'))
  try {
    run(runner, 'unzip', ['-qq', resolvedBundle, 'base/assets/public/*', '-d', directory], 'unzip packaged bundle extraction')
    assertPackagedNativeBundlePolicy(join(directory, 'base', 'assets', 'public'), environment)
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }

  return { entryCount: entries.length }
}

const invokedPath = process.argv[1] && resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  const bundlePath = process.argv[2]
  if (!bundlePath || process.argv.length !== 3) {
    throw new Error(`Usage: BUNDLETOOL_JAR_PATH=/absolute/path/bundletool-all-1.18.3.jar node ${basename(fileURLToPath(import.meta.url))} path/to/app-release.aab`)
  }
  const result = checkAndroidUnsignedBundle(bundlePath)
  console.log(`PASS unsigned Android App Bundle: ${basename(resolve(bundlePath))}; ${result.entryCount} archive entries inspected`)
}
