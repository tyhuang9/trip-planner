import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNativeBundlePolicy } from './check-native-bundle-policy.mjs'

const APK_NAME = 'app-release-unsigned.apk'
const MIN_LOAD_ALIGNMENT = 2n ** 14n

function command(runner, executable, args) {
  const result = runner(executable, args)
  if (result.status !== 0) throw new Error(`${basename(executable)} failed while inspecting the unsigned APK`)
  return result.stdout ?? ''
}

function defaultRunner(executable, args) {
  const result = spawnSync(executable, args, { encoding: 'utf8' })
  if (result.error) throw new Error(`Could not run ${executable}: ${result.error.message}`)
  return { status: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
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
  return {
    aapt: requiredTool(join(buildTools, 'aapt'), 'aapt'),
    apksigner: requiredTool(join(buildTools, 'apksigner'), 'apksigner'),
    zipalign: requiredTool(join(buildTools, 'zipalign'), 'zipalign'),
    objdump: requiredTool(join(androidHome, 'ndk', ndkVersion, 'toolchains', 'llvm', 'prebuilt', androidHostTag(), 'bin', 'llvm-objdump'), 'NDK llvm-objdump'),
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

function assertZipFile(apkPath) {
  if (basename(apkPath) !== APK_NAME) throw new Error(`APK filename must be exactly ${APK_NAME}`)
  if (!existsSync(apkPath) || !statSync(apkPath).isFile()) throw new Error(`APK does not exist: ${apkPath}`)
  const bytes = readFileSync(apkPath)
  const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06])
  if (bytes.length < 22 || bytes.lastIndexOf(eocd) < Math.max(0, bytes.length - 65557)) {
    throw new Error(`APK is not a valid ZIP file: ${apkPath}`)
  }
}

function assertUnsigned(runner, tools, apkPath) {
  const result = runner(tools.apksigner, ['verify', '--verbose', apkPath])
  if (result.status === 0) throw new Error('APK must be unsigned; apksigner verified a signature')
  const report = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  if (!/(does not verify|not signed|no (jar )?signatures|unsigned)/i.test(report)) {
    throw new Error('apksigner did not clearly report that the APK is unsigned')
  }
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
  assertZipFile(resolvedApk)
  const officialTools = tools ?? resolveAndroidTools(environment)
  assertExpectedBadging(command(runner, officialTools.aapt, ['dump', 'badging', resolvedApk]))
  assertUnsigned(runner, officialTools, resolvedApk)
  command(runner, 'unzip', ['-tqq', resolvedApk])
  const entries = command(runner, 'unzip', ['-Z1', resolvedApk]).split(/\r?\n/).filter(Boolean)
  for (const required of ['assets/public/index.html', 'assets/public/.vite/manifest.json']) {
    if (!entries.includes(required)) throw new Error(`APK is missing required packaged bundle file: ${required}`)
  }
  for (const entry of entries.filter((entry) => entry.startsWith('assets/public/'))) assertSafeArchiveEntry(entry)

  const directory = mkdtempSync(join(tmpdir(), 'dupert-android-apk-'))
  try {
    command(runner, 'unzip', ['-qq', resolvedApk, 'assets/public/*', '-d', directory])
    assertNativeBundlePolicy(join(directory, 'assets', 'public'), environment)
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
