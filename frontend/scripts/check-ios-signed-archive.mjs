import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPackagedNativeBundlePolicy } from './check-native-bundle-policy.mjs'
import { inspectIosArchiveMachO } from './check-ios-archive-mach-o.mjs'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const APP_RELATIVE_PATH = 'Products/Applications/App.app'
const EXPECTED_CAPACITOR_CONFIG = {
  appId: 'io.github.tyhuang9.dupert',
  appName: 'Dupert',
  webDir: 'dist',
  server: { hostname: 'localhost', iosScheme: 'capacitor', androidScheme: 'https' },
}
const MAX_TEXT_BYTES = 1024 * 1024

function fail(message) {
  throw new Error(`iOS signed archive inspection failed: ${message}`)
}

function safeDirectory(path, label) {
  const resolved = resolve(path)
  if (!isAbsolute(path) || path !== resolved) fail(`${label} must be a normalized absolute path`)
  let stats
  try { stats = lstatSync(resolved) } catch { fail(`${label} is missing`) }
  if (stats.isSymbolicLink() || !stats.isDirectory()) fail(`${label} must be a regular directory`)
  return resolved
}

function safeFile(path, label) {
  let stats
  try { stats = lstatSync(path) } catch { fail(`${label} is missing`) }
  if (stats.isSymbolicLink() || !stats.isFile()) fail(`${label} must be a regular file`)
  return path
}

function command(commandPath, args, runner) {
  const result = runner(commandPath, args, {
    encoding: 'utf8',
    shell: false,
    timeout: 15_000,
    maxBuffer: MAX_TEXT_BYTES,
    windowsHide: true,
  })
  if (!result || result.error || result.signal || result.status !== 0) fail(`${commandPath.split('/').at(-1)} did not complete successfully`)
  const stdout = typeof result.stdout === 'string' ? result.stdout : ''
  const stderr = typeof result.stderr === 'string' ? result.stderr : ''
  if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > MAX_TEXT_BYTES) fail(`${commandPath.split('/').at(-1)} output is too large`)
  return `${stdout}${stderr}`
}

function plistString(source, key, label) {
  const matches = [...source.matchAll(new RegExp(`<key>${key}<\\/key>\\s*<string>([^<]+)<\\/string>`, 'g'))]
  if (matches.length !== 1) fail(`${label} is missing or ambiguous`)
  return matches[0][1]
}

function plistBoolean(source, key, label) {
  const matches = [...source.matchAll(new RegExp(`<key>${key}<\\/key>\\s*<(true|false)\\/>`, 'g'))]
  if (matches.length !== 1) fail(`${label} is missing or ambiguous`)
  return matches[0][1] === 'true'
}

function profileTeam(source) {
  const match = source.match(/<key>TeamIdentifier<\/key>\s*<array>\s*<string>([A-Z0-9]{10})<\/string>\s*<\/array>/)
  if (!match) fail('embedded provisioning profile team identifier is missing or invalid')
  return match[1]
}

function collectText(directory) {
  const files = []
  const pending = [directory]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const name of readdirSync(current)) {
      if (!name || /[\0-\x1f\\/]/.test(name)) fail('packaged public bundle contains an unsafe path component')
      const path = join(current, name)
      const stats = lstatSync(path)
      if (stats.isSymbolicLink()) fail('packaged public bundle must not contain symlinks')
      if (stats.isDirectory()) pending.push(path)
      else if (stats.isFile() && statSync(path).size <= MAX_TEXT_BYTES && /\.(?:html|js|json|css|mjs)$/i.test(name)) files.push(readFileSync(path, 'utf8'))
    }
  }
  return files.join('\n')
}

function parseArguments(args) {
  const values = {}
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (!/^--(?:archive|bundle-id|version|build|team-id|production-api-origin)$/.test(flag ?? '') || !value || values[flag]) {
      fail('usage requires each expected non-secret argument exactly once')
    }
    values[flag] = value
  }
  if (Object.keys(values).length !== 6) fail('usage requires archive, bundle-id, version, build, team-id, and production-api-origin')
  if (values['--bundle-id'] !== 'io.github.tyhuang9.dupert') fail('bundle-id must be the Dupert iOS identifier')
  if (!/^\d+(?:\.\d+){1,2}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(values['--version'])) fail('version must be a release version')
  if (!/^\d+$/.test(values['--build'])) fail('build must be numeric')
  if (!/^[A-Z0-9]{10}$/.test(values['--team-id'])) fail('team-id must be a ten-character Apple Team identifier')
  let origin
  try { origin = new URL(values['--production-api-origin']) } catch { fail('production-api-origin must be an HTTPS origin') }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) fail('production-api-origin must be an HTTPS origin without path or credentials')
  return {
    archive: values['--archive'],
    bundleId: values['--bundle-id'],
    version: values['--version'],
    build: values['--build'],
    teamId: values['--team-id'],
    productionApiOrigin: origin.origin,
  }
}

export function inspectIosSignedArchive(expected, dependencies = {}) {
  const runner = dependencies.runner ?? spawnSync
  const inspectMachO = dependencies.inspectMachO ?? inspectIosArchiveMachO
  const inspectBundle = dependencies.inspectBundle ?? assertPackagedNativeBundlePolicy
  const archive = safeDirectory(expected.archive, 'archive')
  const appPath = safeDirectory(join(archive, APP_RELATIVE_PATH), 'archived App.app')
  if (relative(archive, appPath).split(sep).join('/') !== APP_RELATIVE_PATH) fail('archived App.app path is invalid')
  const infoPath = safeFile(join(appPath, 'Info.plist'), 'archived Info.plist')
  const info = command('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', infoPath], runner)
  if (plistString(info, 'CFBundleIdentifier', 'bundle identifier') !== expected.bundleId) fail('bundle identifier does not match the controlled expectation')
  if (plistString(info, 'CFBundleShortVersionString', 'marketing version') !== expected.version) fail('marketing version does not match the controlled expectation')
  if (plistString(info, 'CFBundleVersion', 'build number') !== expected.build) fail('build number does not match the controlled expectation')

  command('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', appPath], runner)
  const entitlements = command('/usr/bin/codesign', ['-d', '--entitlements', ':-', appPath], runner)
  if (plistString(entitlements, 'application-identifier', 'signed application identifier') !== `${expected.teamId}.${expected.bundleId}`) fail('signed application identifier does not match the expected Team and bundle')
  if (plistBoolean(entitlements, 'get-task-allow', 'get-task-allow') !== false) fail('signed app must disable get-task-allow')

  const profile = command('/usr/bin/security', ['cms', '-D', '-i', safeFile(join(appPath, 'embedded.mobileprovision'), 'embedded provisioning profile')], runner)
  if (profileTeam(profile) !== expected.teamId) fail('embedded provisioning profile Team does not match expected Team')
  if (plistString(profile, 'application-identifier', 'provisioning application identifier') !== `${expected.teamId}.${expected.bundleId}`) fail('embedded provisioning profile application identifier does not match')
  if (plistBoolean(profile, 'get-task-allow', 'provisioning get-task-allow') !== false) fail('embedded provisioning profile must disable get-task-allow')

  const packagedConfig = JSON.parse(readFileSync(safeFile(join(appPath, 'capacitor.config.json'), 'packaged Capacitor configuration'), 'utf8'))
  if (JSON.stringify(packagedConfig) !== JSON.stringify(EXPECTED_CAPACITOR_CONFIG)) fail('packaged Capacitor configuration is not the controlled native configuration')
  const sourcePrivacy = readFileSync(resolve(ROOT, 'frontend/ios/App/App/PrivacyInfo.xcprivacy'))
  const packagedPrivacy = readFileSync(safeFile(join(appPath, 'PrivacyInfo.xcprivacy'), 'packaged privacy manifest'))
  if (!sourcePrivacy.equals(packagedPrivacy)) fail('packaged privacy manifest does not match the reviewed source')

  inspectBundle(join(appPath, 'public'))
  inspectMachO(appPath, { runner })
  const packagedText = collectText(join(appPath, 'public'))
  if (!packagedText.includes(expected.productionApiOrigin)) fail('packaged native bundle does not contain the expected production API origin')
  if (/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|[^/'"\s]*\.test)(?::\d+)?/i.test(packagedText)) fail('packaged native bundle contains a development or CI endpoint')
  if (/VITE_GOOGLE_MAPS_API_KEY|VITE_APP_ACCESS_PASSWORD|@vis\.gl\/react-google-maps/.test(packagedText)) fail('packaged native bundle contains a browser-only value or renderer')
  return { appPath }
}

const invokedPath = process.argv[1] && resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const expected = parseArguments(process.argv.slice(2))
    inspectIosSignedArchive(expected)
    console.log('PASS iOS signed archive inspection (record provenance outside the repository)')
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'iOS signed archive inspection failed')
    process.exitCode = 1
  }
}

export { parseArguments }
