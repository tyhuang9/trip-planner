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
const EXTERNAL_TOOL_TIMEOUT_MS = 5 * 60 * 1000
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50
const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50
const ZIP64_UINT16_SENTINEL = 0xffff
const ZIP64_UINT32_SENTINEL = 0xffffffff
const ZIP_HOST_DOS = 0
const ZIP_HOST_UNIX = 3
const ZIP_EXTENDED_TIMESTAMP_FIELD_ID = 0x5455
const ZIP_EXTENDED_TIMESTAMP_FLAGS_MASK = 0x07
const ZIP_EXTENDED_TIMESTAMP_MODIFIED_FLAG = 0x01
const ZIP_UNIX_DIRECTORY = 0x4000
const ZIP_UNIX_FILE_TYPE_MASK = 0xf000
const ZIP_UNIX_REGULAR_FILE = 0x8000

function defaultRunner(executable, args) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    timeout: EXTERNAL_TOOL_TIMEOUT_MS,
  })
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

function readZipFile(bundlePath) {
  const bytes = readFileSync(bundlePath)
  const eocd = Buffer.allocUnsafe(4)
  eocd.writeUInt32LE(ZIP_EOCD_SIGNATURE)
  const eocdOffset = bytes.lastIndexOf(eocd)
  if (bytes.length < 22 || eocdOffset < Math.max(0, bytes.length - 65557)
    || eocdOffset + 22 > bytes.length
    || eocdOffset + 22 + bytes.readUInt16LE(eocdOffset + 20) !== bytes.length) {
    throw new Error(`AAB is not a valid ZIP file: ${bundlePath}`)
  }
  return { bytes, eocdOffset }
}

function assertSafeEntry(entry) {
  const normalizedEntry = entry.endsWith('/') ? entry.slice(0, -1) : entry
  const segments = normalizedEntry.split('/')
  if (!entry || entry.startsWith('/') || entry.includes('\\') || /\p{Cc}/u.test(entry)
    || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`AAB contains an unsafe archive path: ${entry}`)
  }
}

function assertArchiveEntries(entries) {
  if (new Set(entries).size !== entries.length) throw new Error('AAB contains duplicate archive entries')
  for (const entry of entries) assertSafeEntry(entry)

  const signingEntry = entries.find((entry) => /^META-INF\/(?:[^/]+\.(?:SF|RSA|DSA|EC)|SIG-[^/]*)$/i.test(entry))
  if (signingEntry) throw new Error(`AAB contains JAR signing material: ${signingEntry}`)

  for (const required of REQUIRED_ENTRIES) {
    if (!entries.includes(required)) throw new Error(`AAB is missing required entry: ${required}`)
  }
}

function decodeEntryName(bytes) {
  if (bytes.length === 0 || bytes.some((byte) => byte <= 0x1f || byte === 0x7f)) {
    throw new Error('AAB contains an empty or control-character archive path')
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new Error('AAB contains a non-UTF-8 archive path')
  }
}

function assertSupportedEntryType(name, versionMadeBy, externalAttributes) {
  const hostSystem = versionMadeBy >>> 8
  const namedDirectory = name.endsWith('/')
  if (hostSystem === ZIP_HOST_UNIX) {
    const unixType = (externalAttributes >>> 16) & ZIP_UNIX_FILE_TYPE_MASK
    if (unixType !== ZIP_UNIX_REGULAR_FILE && unixType !== ZIP_UNIX_DIRECTORY) {
      throw new Error('AAB contains a symbolic link or unsupported archive entry')
    }
    if ((unixType === ZIP_UNIX_DIRECTORY) !== namedDirectory) {
      throw new Error('AAB archive entry type conflicts with its path')
    }
    return
  }

  if (hostSystem !== ZIP_HOST_DOS || (externalAttributes >>> 16) !== 0) {
    throw new Error('AAB contains an unsupported ZIP creator or external file type')
  }
  const dosAttributes = externalAttributes & 0xffff
  if ((dosAttributes & 0x08) !== 0) {
    throw new Error('AAB contains a ZIP volume-label entry')
  }
  const dosDirectory = (dosAttributes & 0x10) !== 0
  if (dosDirectory !== namedDirectory) {
    throw new Error('AAB archive entry type conflicts with its path')
  }
}

function readSupportedExtraFields(bytes, start, length, location) {
  if (length === 0) return null
  const end = start + length
  let offset = start
  let timestamp = null
  while (offset < end) {
    if (offset + 4 > end) {
      throw new Error(`AAB contains malformed ${location} ZIP extra metadata`)
    }
    const fieldId = bytes.readUInt16LE(offset)
    const fieldSize = bytes.readUInt16LE(offset + 2)
    const dataStart = offset + 4
    const nextOffset = dataStart + fieldSize
    if (nextOffset > end) {
      throw new Error(`AAB contains malformed ${location} ZIP extra metadata`)
    }
    if (fieldId !== ZIP_EXTENDED_TIMESTAMP_FIELD_ID) {
      const formattedId = fieldId.toString(16).padStart(4, '0')
      throw new Error(`AAB contains unsupported ${location} ZIP extra field 0x${formattedId} (${fieldSize} bytes)`)
    }
    if (timestamp !== null || fieldSize < 1) {
      throw new Error(`AAB contains duplicate or malformed ${location} ZIP timestamp metadata`)
    }
    const flags = bytes[dataStart]
    const timestampCount = (flags & 1) + ((flags >>> 1) & 1) + ((flags >>> 2) & 1)
    const expectedSize = location === 'central' ? 5 : 1 + (4 * timestampCount)
    if ((flags & ~ZIP_EXTENDED_TIMESTAMP_FLAGS_MASK) !== 0
      || (flags & ZIP_EXTENDED_TIMESTAMP_MODIFIED_FLAG) === 0
      || fieldSize !== expectedSize) {
      throw new Error(`AAB contains malformed ${location} ZIP timestamp metadata`)
    }
    timestamp = { flags, modifiedTime: bytes.readUInt32LE(dataStart + 1) }
    offset = nextOffset
  }
  return timestamp
}

function assertMatchingLocalHeader(
  bytes,
  centralDirectoryOffset,
  centralOffset,
  flags,
  nameBytes,
  centralTimestamp,
) {
  const localOffset = bytes.readUInt32LE(centralOffset + 42)
  if (localOffset === ZIP64_UINT32_SENTINEL || localOffset + 30 > centralDirectoryOffset
    || bytes.readUInt32LE(localOffset) !== ZIP_LOCAL_FILE_HEADER_SIGNATURE) {
    throw new Error('AAB contains an invalid ZIP local-file header')
  }
  const localFlags = bytes.readUInt16LE(localOffset + 6)
  const localNameLength = bytes.readUInt16LE(localOffset + 26)
  const localExtraLength = bytes.readUInt16LE(localOffset + 28)
  const localEnd = localOffset + 30 + localNameLength + localExtraLength
  if (localEnd > centralDirectoryOffset) {
    throw new Error('AAB contains truncated ZIP local metadata')
  }
  const localName = bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength)
  if (localFlags !== flags || !localName.equals(nameBytes)) {
    throw new Error('AAB local and central ZIP metadata do not match')
  }
  const localTimestamp = readSupportedExtraFields(
    bytes,
    localOffset + 30 + localNameLength,
    localExtraLength,
    'local',
  )
  if ((localTimestamp === null) !== (centralTimestamp === null)
    || (localTimestamp !== null
      && (localTimestamp.flags !== centralTimestamp.flags
        || localTimestamp.modifiedTime !== centralTimestamp.modifiedTime))) {
    throw new Error('AAB local and central ZIP timestamp metadata do not match')
  }
}

export function readCentralDirectoryEntries(bytes, eocdOffset) {
  const diskNumber = bytes.readUInt16LE(eocdOffset + 4)
  const centralDirectoryDisk = bytes.readUInt16LE(eocdOffset + 6)
  const entriesOnDisk = bytes.readUInt16LE(eocdOffset + 8)
  const entryCount = bytes.readUInt16LE(eocdOffset + 10)
  const centralDirectorySize = bytes.readUInt32LE(eocdOffset + 12)
  const centralDirectoryOffset = bytes.readUInt32LE(eocdOffset + 16)
  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount
    || entryCount === ZIP64_UINT16_SENTINEL
    || centralDirectorySize === ZIP64_UINT32_SENTINEL
    || centralDirectoryOffset === ZIP64_UINT32_SENTINEL
    || centralDirectoryOffset + centralDirectorySize !== eocdOffset) {
    throw new Error('AAB uses an unsupported or inconsistent ZIP central directory')
  }

  const entries = []
  let offset = centralDirectoryOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > eocdOffset || bytes.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error('AAB contains an invalid ZIP central-directory record')
    }
    const versionMadeBy = bytes.readUInt16LE(offset + 4)
    const flags = bytes.readUInt16LE(offset + 8)
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    const externalAttributes = bytes.readUInt32LE(offset + 38)
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength
    if ((flags & 0x1) !== 0) throw new Error('AAB contains an encrypted ZIP entry')
    if (nextOffset > eocdOffset) throw new Error('AAB contains a truncated ZIP entry')
    const centralTimestamp = readSupportedExtraFields(
      bytes,
      offset + 46 + nameLength,
      extraLength,
      'central',
    )
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength)
    if ((flags & 0x800) === 0 && nameBytes.some((byte) => byte >= 0x80)) {
      throw new Error('AAB contains a non-UTF-8 archive path')
    }
    assertMatchingLocalHeader(
      bytes,
      centralDirectoryOffset,
      offset,
      flags,
      nameBytes,
      centralTimestamp,
    )
    const name = decodeEntryName(nameBytes)
    assertSupportedEntryType(name, versionMadeBy, externalAttributes)
    entries.push(name)
    offset = nextOffset
  }
  if (offset !== eocdOffset) throw new Error('AAB central-directory size does not match its entries')
  return entries
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

  const { bytes, eocdOffset } = readZipFile(resolvedBundle)
  run(runner, 'unzip', ['-UU', '-tqq', resolvedBundle], 'unzip integrity check')
  const entries = readCentralDirectoryEntries(bytes, eocdOffset)
  assertArchiveEntries(entries)

  const directory = mkdtempSync(join(tmpdir(), 'dupert-android-aab-'))
  try {
    run(runner, 'unzip', ['-UU', '-qq', resolvedBundle, 'base/assets/public/*', '-d', directory], 'unzip packaged bundle extraction')
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
