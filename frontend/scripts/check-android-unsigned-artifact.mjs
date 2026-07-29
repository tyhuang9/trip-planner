import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPackagedNativeBundlePolicy } from './check-native-bundle-policy.mjs'

const APK_NAME = 'app-release-unsigned.apk'
const APK_SIGNING_BLOCK_MAGIC = Buffer.from('APK Sig Block 42')
const MIN_LOAD_ALIGNMENT = 2n ** 14n
const APKSIGNER_MAX_PREVIEW_BYTES = 256
const APKSIGNER_MAX_DIAGNOSTIC_BYTES = 4096
const APKSIGNER_TRUNCATION_MARKER = '…[truncated]'
const UNSIGNED_APKSIGNER_REPORTS = new Set([
  'DOES NOT VERIFY\nERROR: No JAR signatures',
  'DOES NOT VERIFY\nERROR: Missing META-INF/MANIFEST.MF',
])

function command(runner, executable, args) {
  const result = runner(executable, args)
  if (result.status !== 0) throw new Error(`${basename(executable)} failed while inspecting the unsigned APK`)
  return result.stdout ?? ''
}

function defaultRunner(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8' })
  if (result.error) throw new Error(`Could not run ${executable}: ${result.error.message}`)
  return { status: result.status, signal: result.signal, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function requiredTool(path, label) {
  if (!existsSync(path)) throw new Error(`${label} is unavailable at ${path}`)
  return path
}

function androidHostTag() {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x86_64'
  if (process.platform === 'linux') return 'linux-x86_64'
  throw new Error(`Unsupported host for Android NDK tools: ${process.platform}`)
}

export function resolveAndroidTools(environment = process.env) {
  const androidHome = environment.ANDROID_HOME
  const buildToolsVersion = environment.ANDROID_BUILD_TOOLS_VERSION
  const ndkVersion = environment.ANDROID_NDK_VERSION
  if (!androidHome) throw new Error('ANDROID_HOME is required to locate official Android tools')
  if (!buildToolsVersion) throw new Error('ANDROID_BUILD_TOOLS_VERSION is required for deterministic Android Build Tools')
  if (!ndkVersion) throw new Error('ANDROID_NDK_VERSION is required to locate llvm-objdump')
  if (Number(buildToolsVersion.split('.')[0]) < 35) throw new Error('ANDROID_BUILD_TOOLS_VERSION must be 35 or newer for the 16 KB APK alignment check')

  const buildTools = join(androidHome, 'build-tools', buildToolsVersion)
  const objdump = join(androidHome, 'ndk', ndkVersion, 'toolchains', 'llvm', 'prebuilt', androidHostTag(), 'bin', 'llvm-objdump')
  return {
    aapt: requiredTool(join(buildTools, 'aapt'), 'aapt'),
    apksigner: requiredTool(join(buildTools, 'apksigner'), 'apksigner'),
    zipalign: requiredTool(join(buildTools, 'zipalign'), 'zipalign'),
    objdump: existsSync(objdump) ? objdump : null,
  }
}

function packageAttributes(badging) {
  const line = badging.split(/\r?\n/).find((candidate) => /^\s*package:\s/.test(candidate))
  if (!line) throw new Error('aapt did not report package metadata')
  return Object.fromEntries([...line.matchAll(/(\w+)='([^']*)'/g)].map(([, key, value]) => [key, value]))
}

function badgingValue(badging, name) {
  const match = badging.match(new RegExp(`^\\s*${name}:'([^']*)'`, 'm'))
  return match?.[1]
}

export function assertExpectedBadging(badging) {
  const pkg = packageAttributes(badging)
  const expected = {
    name: 'io.github.tyhuang9.dupert',
    versionCode: '1',
    versionName: '1.0',
    minSdk: '24',
    targetSdk: '36',
  }
  const actual = {
    name: pkg.name,
    versionCode: pkg.versionCode,
    versionName: pkg.versionName,
    minSdk: badgingValue(badging, 'sdkVersion'),
    targetSdk: badgingValue(badging, 'targetSdkVersion'),
  }
  for (const [name, value] of Object.entries(expected)) {
    if (actual[name] !== value) throw new Error(`APK ${name} must be ${value}; found ${actual[name] ?? 'missing'}`)
  }
}

function readZipFile(apkPath) {
  if (basename(apkPath) !== APK_NAME) throw new Error(`APK filename must be exactly ${APK_NAME}`)
  if (!existsSync(apkPath) || !statSync(apkPath).isFile()) throw new Error(`APK does not exist: ${apkPath}`)
  const bytes = readFileSync(apkPath)
  const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06])
  const eocdOffset = bytes.lastIndexOf(eocd)
  if (bytes.length < 22 || eocdOffset < Math.max(0, bytes.length - 65557)
    || eocdOffset + 22 > bytes.length
    || eocdOffset + 22 + bytes.readUInt16LE(eocdOffset + 20) !== bytes.length) {
    throw new Error(`APK is not a valid ZIP file: ${apkPath}`)
  }
  return { bytes, eocdOffset }
}

function normalizeApksignerStream(stream) {
  return stream.replaceAll('\r\n', '\n').replace(/\n$/, '')
}

function stringDiagnostic(value, apkPath) {
  const byteLength = Buffer.byteLength(value)
  const redacted = value.replaceAll(apkPath, '<APK_PATH>')
  if (Buffer.byteLength(JSON.stringify(redacted)) <= APKSIGNER_MAX_PREVIEW_BYTES) {
    return { type: 'string', byteLength, truncated: false, preview: redacted }
  }

  let preview = ''
  for (const character of redacted) {
    const candidate = `${preview}${character}${APKSIGNER_TRUNCATION_MARKER}`
    if (Buffer.byteLength(JSON.stringify(candidate)) > APKSIGNER_MAX_PREVIEW_BYTES) break
    preview += character
  }
  return { type: 'string', byteLength, truncated: true, preview: `${preview}${APKSIGNER_TRUNCATION_MARKER}` }
}

function diagnosticValue(value, apkPath) {
  if (typeof value === 'string') return stringDiagnostic(value, apkPath)
  if (Buffer.isBuffer(value)) return { type: 'Buffer', byteLength: value.byteLength }
  if (Array.isArray(value)) return { type: 'Array', length: value.length }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value
  return { type: typeof value }
}

function apksignerDiagnostics(result, apkPath) {
  const diagnostics = JSON.stringify({
    status: diagnosticValue(result?.status, apkPath),
    signal: diagnosticValue(result?.signal, apkPath),
    stdout: diagnosticValue(result?.stdout, apkPath),
    stderr: diagnosticValue(result?.stderr, apkPath),
  })
  return Buffer.byteLength(diagnostics) <= APKSIGNER_MAX_DIAGNOSTIC_BYTES
    ? diagnostics
    : JSON.stringify({ truncated: true })
}

function assertUnsigned(runner, tools, apkPath) {
  let result
  try {
    result = runner(tools.apksigner, ['verify', '--verbose', apkPath])
  } catch (error) {
    throw new Error('apksigner failed to run while confirming the APK has no signatures', { cause: error })
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)
    || result.status !== 1 || result.signal !== null
    || typeof result.stdout !== 'string' || typeof result.stderr !== 'string'
    || normalizeApksignerStream(result.stdout) !== ''
    || !UNSIGNED_APKSIGNER_REPORTS.has(normalizeApksignerStream(result.stderr))) {
    throw new Error(`apksigner did not report an accepted unsigned result (${apksignerDiagnostics(result, apkPath)})`)
  }
}

function assertNoSigningMaterial(bytes, eocdOffset, entries) {
  const v1Entry = entries.find((entry) => /^META-INF\/[^/]+\.(?:SF|RSA|DSA|EC)$/i.test(entry))
  if (v1Entry) throw new Error(`APK contains v1 signing material: ${v1Entry}`)

  const centralDirectoryOffset = bytes.readUInt32LE(eocdOffset + 16)
  if (centralDirectoryOffset > eocdOffset) throw new Error('APK central-directory offset is invalid')
  if (centralDirectoryOffset < APK_SIGNING_BLOCK_MAGIC.length
    || !bytes.subarray(centralDirectoryOffset - APK_SIGNING_BLOCK_MAGIC.length, centralDirectoryOffset).equals(APK_SIGNING_BLOCK_MAGIC)) return

  const footerSizeOffset = centralDirectoryOffset - 24
  if (footerSizeOffset < 0) throw new Error('APK contains a malformed APK Signing Block')
  const footerSize = bytes.readBigUInt64LE(footerSizeOffset)
  if (footerSize < 24n || footerSize > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('APK contains a malformed APK Signing Block')
  }
  const blockStart = centralDirectoryOffset - Number(footerSize) - 8
  if (blockStart < 0 || bytes.readBigUInt64LE(blockStart) !== footerSize) {
    throw new Error('APK contains a malformed APK Signing Block')
  }
  throw new Error('APK contains an APK Signing Block')
}

function assertSafeArchiveEntry(entry) {
  if (entry.startsWith('/') || entry.split('/').includes('..')) throw new Error('APK contains an unsafe archive path')
}

function loadAlignments(objdump) {
  const alignments = []
  for (const line of objdump.split(/\r?\n/)) {
    if (!/^\s*LOAD\b/.test(line)) continue
    const match = line.match(/\balign\s+(?:(\d+)\*\*(\d+)|(0x[\da-f]+|\d+))/i)
    if (!match) throw new Error('llvm-objdump did not report a LOAD alignment')
    alignments.push(match[1] ? BigInt(match[1]) ** BigInt(match[2]) : BigInt(match[3]))
  }
  if (alignments.length === 0) throw new Error('llvm-objdump did not report any LOAD segments')
  return alignments
}

function assertLibraries16Kb(runner, tools, apkPath, libraries, directory) {
  if (libraries.length === 0) return false
  if (!tools.objdump) throw new Error('NDK llvm-objdump is unavailable for packaged native-library inspection')
  for (const library of libraries) assertSafeArchiveEntry(library)
  command(runner, 'unzip', ['-qq', apkPath, ...libraries, '-d', directory])
  for (const library of libraries) {
    const output = command(runner, tools.objdump, ['-p', join(directory, library)])
    if (loadAlignments(output).some((alignment) => alignment < MIN_LOAD_ALIGNMENT)) {
      throw new Error(`Native library LOAD alignment is below 16 KB: ${library}`)
    }
  }
  return true
}

export function checkAndroidUnsignedArtifact(apkPath, { environment = process.env, tools, runner = defaultRunner } = {}) {
  const resolvedApk = resolve(apkPath)
  const { bytes, eocdOffset } = readZipFile(resolvedApk)
  const officialTools = tools ?? resolveAndroidTools(environment)
  assertExpectedBadging(command(runner, officialTools.aapt, ['dump', 'badging', resolvedApk]))
  command(runner, 'unzip', ['-tqq', resolvedApk])
  const entries = command(runner, 'unzip', ['-Z1', resolvedApk]).split(/\r?\n/).filter(Boolean)
  assertNoSigningMaterial(bytes, eocdOffset, entries)
  assertUnsigned(runner, officialTools, resolvedApk)
  const packagedEntrypoint = 'assets/public/index.html'
  if (!entries.includes(packagedEntrypoint)) {
    throw new Error(`APK is missing required packaged bundle file: ${packagedEntrypoint}`)
  }
  for (const entry of entries.filter((entry) => entry.startsWith('assets/public/'))) assertSafeArchiveEntry(entry)

  const directory = mkdtempSync(join(tmpdir(), 'dupert-android-apk-'))
  try {
    command(runner, 'unzip', ['-qq', resolvedApk, 'assets/public/*', '-d', directory])
    assertPackagedNativeBundlePolicy(join(directory, 'assets', 'public'), environment)
    const libraries = entries.filter((entry) => entry.startsWith('lib/') && entry.endsWith('.so'))
    const elfChecked = assertLibraries16Kb(runner, officialTools, resolvedApk, libraries, directory)
    command(runner, officialTools.zipalign, ['-c', '-P', '16', '-v', '4', resolvedApk])
    return { elfChecked, libraryCount: libraries.length }
  } finally {
    rmSync(directory, { force: true, recursive: true })
  }
}

const invokedPath = process.argv[1] && resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  const apkPath = process.argv[2]
  if (!apkPath) throw new Error(`Usage: node ${basename(fileURLToPath(import.meta.url))} path/to/${APK_NAME}`)
  const result = checkAndroidUnsignedArtifact(apkPath)
  console.log(`PASS unsigned Android APK: ${APK_NAME}; ELF 16 KB LOAD checks: ${result.elfChecked ? `${result.libraryCount} libraries checked` : 'not applicable (no packaged lib/**/*.so)'}`)
}
