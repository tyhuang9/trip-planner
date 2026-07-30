import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_MACH_O_FILES = [
  'App',
  'Frameworks/Capacitor.framework/Capacitor',
  'Frameworks/Cordova.framework/Cordova',
]
const MACH_O_MAGICS = new Set([
  'cafebabe',
  'cafebabf',
  'bebafeca',
  'bfbafeca',
  'cefaedfe',
  'cffaedfe',
  'feedface',
  'feedfacf',
])
const ALLOWED_RPATHS = new Map([
  ['@rpath/Capacitor.framework/Capacitor', 'Frameworks/Capacitor.framework/Capacitor'],
  ['@rpath/Cordova.framework/Cordova', 'Frameworks/Cordova.framework/Cordova'],
])
const EXPECTED_RUNPATHS = new Map([
  ['App', ['/usr/lib/swift', '@executable_path/Frameworks']],
  ['Frameworks/Capacitor.framework/Capacitor', [
    '/usr/lib/swift',
    '@executable_path/Frameworks',
    '@loader_path/Frameworks',
  ]],
  ['Frameworks/Cordova.framework/Cordova', [
    '@executable_path/Frameworks',
    '@loader_path/Frameworks',
  ]],
])
const ALLOWED_USR_LIB_DEPENDENCIES = new Set([
  '/usr/lib/libSystem.B.dylib',
  '/usr/lib/libc++.1.dylib',
  '/usr/lib/libobjc.A.dylib',
  '/usr/lib/libz.1.dylib',
  '/usr/lib/swift/libswiftCore.dylib',
  '/usr/lib/swift/libswiftCoreFoundation.dylib',
  '/usr/lib/swift/libswiftCoreGraphics.dylib',
  '/usr/lib/swift/libswiftCoreImage.dylib',
  '/usr/lib/swift/libswiftCoreLocation.dylib',
  '/usr/lib/swift/libswiftDarwin.dylib',
  '/usr/lib/swift/libswiftDispatch.dylib',
  '/usr/lib/swift/libswiftFoundation.dylib',
  '/usr/lib/swift/libswiftMetal.dylib',
  '/usr/lib/swift/libswiftOSLog.dylib',
  '/usr/lib/swift/libswiftObjectiveC.dylib',
  '/usr/lib/swift/libswiftQuartzCore.dylib',
  '/usr/lib/swift/libswiftSpatial.dylib',
  '/usr/lib/swift/libswiftUIKit.dylib',
  '/usr/lib/swift/libswiftUniformTypeIdentifiers.dylib',
  '/usr/lib/swift/libswiftXPC.dylib',
  '/usr/lib/swift/libswiftos.dylib',
  '/usr/lib/swift/libswiftsimd.dylib',
])
const TOOL_TIMEOUT_MS = 15_000
const TOOL_MAX_BUFFER = 1024 * 1024

function checkedLines(output, description) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > TOOL_MAX_BUFFER) {
    throw new Error(`${description} output is missing or exceeds ${TOOL_MAX_BUFFER} bytes`)
  }
  if (!output.endsWith('\n') || output.includes('\r') || output.includes('\0')) {
    throw new Error(`${description} output is malformed`)
  }
  const lines = output.slice(0, -1).split('\n')
  if (lines.some((line) => line.length === 0)) throw new Error(`${description} output is malformed`)
  return lines
}

function run(command, args, runner) {
  let result
  try {
    result = runner(command, args, {
      encoding: 'utf8',
      killSignal: 'SIGKILL',
      maxBuffer: TOOL_MAX_BUFFER,
      shell: false,
      timeout: TOOL_TIMEOUT_MS,
      windowsHide: true,
    })
  } catch (error) {
    throw new Error(`${basename(command)} could not start: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!result || typeof result !== 'object') throw new Error(`${basename(command)} returned no process result`)
  if (result.error) {
    const reason = result.error.code === 'ETIMEDOUT'
      ? `timed out after ${TOOL_TIMEOUT_MS}ms`
      : result.error.code === 'ENOBUFS'
        ? `exceeded ${TOOL_MAX_BUFFER} bytes of output`
        : `failed to start: ${result.error.message}`
    throw new Error(`${basename(command)} ${reason}`)
  }
  if (result.signal) throw new Error(`${basename(command)} was terminated by ${result.signal}`)
  if (!Number.isInteger(result.status) || result.status !== 0) {
    throw new Error(`${basename(command)} exited with status ${String(result.status)}`)
  }
  if (typeof result.stderr !== 'string' || result.stderr !== '') {
    throw new Error(`${basename(command)} wrote unexpected stderr output`)
  }
  if (typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > TOOL_MAX_BUFFER) {
    throw new Error(`${basename(command)} output is missing or exceeds ${TOOL_MAX_BUFFER} bytes`)
  }
  return result.stdout
}

function isMachO(path, initialStats) {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const openedStats = fstatSync(descriptor)
    if (!openedStats.isFile()
      || openedStats.dev !== initialStats.dev
      || openedStats.ino !== initialStats.ino) {
      throw new Error(`${path} changed while the app bundle was being inspected`)
    }
    const magic = Buffer.alloc(4)
    return readSync(descriptor, magic, 0, magic.length, 0) === magic.length
      && MACH_O_MAGICS.has(magic.toString('hex'))
  } finally {
    closeSync(descriptor)
  }
}

function validateName(name) {
  if (name === '.' || name === '..' || /[\0-\x1f\x7f\\/]/u.test(name)) {
    throw new Error(`App bundle contains an unsafe path component: ${JSON.stringify(name)}`)
  }
}

function inventoryMachOFiles(appPath) {
  const rootStats = lstatSync(appPath)
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error('App path must be a regular directory, not a symlink or special entry')
  }

  const files = new Map()
  const directories = [appPath]
  while (directories.length > 0) {
    const directory = directories.pop()
    for (const name of readdirSync(directory).sort()) {
      validateName(name)
      const path = join(directory, name)
      const relativePath = relative(appPath, path).split(sep).join('/')
      if (!relativePath || relativePath.startsWith('../') || isAbsolute(relativePath)) {
        throw new Error(`App bundle path escapes its root: ${relativePath}`)
      }
      const stats = lstatSync(path)
      if (stats.isSymbolicLink()) throw new Error(`App bundle must not contain symlinks: ${relativePath}`)
      if (stats.isDirectory()) {
        directories.push(path)
      } else if (stats.isFile()) {
        if (isMachO(path, stats)) files.set(relativePath, { path, stats })
      } else {
        throw new Error(`App bundle contains an unsupported filesystem entry: ${relativePath}`)
      }
    }
  }
  return files
}

function validateArchitecture(path, runner) {
  const lines = checkedLines(run('/usr/bin/lipo', ['-archs', path], runner), 'lipo -archs')
  if (lines.length !== 1 || lines[0] !== 'arm64') {
    throw new Error(`${path} must contain exactly the arm64 architecture`)
  }
}

function validateBuildVersion(path, runner) {
  const lines = checkedLines(
    run('/usr/bin/xcrun', ['vtool', '-show-build', path], runner),
    'vtool -show-build',
  )
  let cursor = 0
  if (lines[cursor++] !== `${path}:`
    || !/^Load command \d+$/u.test(lines[cursor++] ?? '')
    || lines[cursor++]?.trim() !== 'cmd LC_BUILD_VERSION'
    || !/^\s+cmdsize \d+$/u.test(lines[cursor++] ?? '')) {
    throw new Error(`${path} has malformed vtool build-version output`)
  }
  const platform = lines[cursor++]?.match(/^\s+platform ([A-Z0-9_]+)$/u)?.[1]
  const minimumOs = lines[cursor++]?.match(/^\s+minos (\d+(?:\.\d+)+)$/u)?.[1]
  if (!/^\s+sdk \S+$/u.test(lines[cursor++] ?? '')) {
    throw new Error(`${path} has malformed vtool build-version output`)
  }
  const toolCountText = lines[cursor++]?.match(/^\s+ntools (\d+)$/u)?.[1]
  if (toolCountText === undefined) throw new Error(`${path} has malformed vtool build-version output`)
  const toolCount = Number(toolCountText)
  if (!Number.isSafeInteger(toolCount) || lines.length - cursor !== toolCount * 2) {
    throw new Error(`${path} has malformed vtool build-version output`)
  }
  for (let index = 0; index < toolCount; index += 1) {
    if (!/^\s+tool [A-Z0-9_]+$/u.test(lines[cursor++] ?? '')
      || !/^\s+version \S+$/u.test(lines[cursor++] ?? '')) {
      throw new Error(`${path} has malformed vtool build-version output`)
    }
  }
  if (platform !== 'IOS') throw new Error(`${path} must target exactly platform IOS`)
  if (minimumOs !== '15.0') throw new Error(`${path} must declare exactly minos 15.0`)
}

function isSafeSystemDependency(dependency) {
  if (ALLOWED_USR_LIB_DEPENDENCIES.has(dependency)) return true
  const prefix = '/System/Library/Frameworks/'
  if (!dependency.startsWith(prefix)) return false
  const remainder = dependency.slice(prefix.length)
  return remainder.length > 0
    && !remainder.includes('\\')
    && !remainder.includes('//')
    && remainder.split('/').every((part) => part !== '.' && part !== '..' && part.length > 0)
    && !/[\0-\x1f\x7f]/u.test(remainder)
}

function validateDependencies(path, appPath, machOFiles, runner) {
  const lines = checkedLines(run('/usr/bin/otool', ['-L', path], runner), 'otool -L')
  if (lines.shift() !== `${path}:` || lines.length === 0) {
    throw new Error(`${path} has malformed otool dependency output`)
  }
  const seen = new Set()
  for (const line of lines) {
    const dependency = line.match(/^\t(\S+) \(compatibility version \d+(?:\.\d+)*, current version \d+(?:\.\d+)*(?:, weak)?\)$/u)?.[1]
    if (!dependency) throw new Error(`${path} has malformed otool dependency output`)
    if (seen.has(dependency)) throw new Error(`${path} has a duplicate dependency: ${dependency}`)
    seen.add(dependency)
    if (isSafeSystemDependency(dependency)) continue
    const embeddedPath = ALLOWED_RPATHS.get(dependency)
    if (!embeddedPath) throw new Error(`${path} has an unsafe or unexpected dependency: ${dependency}`)
    const expected = machOFiles.get(embeddedPath)
    const currentStats = expected && lstatSync(resolve(appPath, embeddedPath))
    if (!expected || !currentStats.isFile() || currentStats.isSymbolicLink()
      || currentStats.dev !== expected.stats.dev || currentStats.ino !== expected.stats.ino) {
      throw new Error(`${path} has an rpath dependency that does not resolve to the expected embedded file: ${dependency}`)
    }
  }
}

function validateRunpaths(relativePath, path, runner) {
  const lines = checkedLines(run('/usr/bin/otool', ['-l', path], runner), 'otool -l')
  if (lines.shift() !== `${path}:`) throw new Error(`${path} has malformed otool load-command output`)

  const runpaths = []
  const loadCommands = new Set()
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].includes('LC_RPATH')) continue
    const loadCommand = lines[index - 1]?.match(/^Load command (\d+)$/u)?.[1]
    const nextLoadCommand = lines.findIndex((line, nextIndex) =>
      nextIndex > index && /^Load command \d+$/u.test(line))
    const blockEnd = nextLoadCommand === -1 ? lines.length : nextLoadCommand
    const commandSize = lines[index + 1]?.match(/^\s+cmdsize (\d+)$/u)?.[1]
    const pathMatch = lines[index + 2]?.match(/^\s+path (\S+) \(offset 12\)$/u)
    const expectedCommandSize = pathMatch
      ? Math.ceil((12 + Buffer.byteLength(pathMatch[1]) + 1) / 8) * 8
      : null
    if (!loadCommand
      || lines[index] !== '          cmd LC_RPATH'
      || commandSize === undefined
      || !pathMatch
      || Number(commandSize) !== expectedCommandSize
      || blockEnd !== index + 3) {
      throw new Error(`${path} has malformed LC_RPATH output`)
    }
    if (loadCommands.has(loadCommand)) throw new Error(`${path} has duplicate LC_RPATH load commands`)
    loadCommands.add(loadCommand)
    runpaths.push(pathMatch[1])
  }

  if (new Set(runpaths).size !== runpaths.length) throw new Error(`${path} has duplicate LC_RPATH entries`)
  const actual = [...runpaths].sort()
  const expected = [...EXPECTED_RUNPATHS.get(relativePath)].sort()
  if (actual.length !== expected.length || actual.some((runpath, index) => runpath !== expected[index])) {
    throw new Error(`${path} LC_RPATH entries must be exactly ${expected.join(', ')}; found ${actual.join(', ') || 'none'}`)
  }
}

export function inspectIosArchiveMachO(appPath, { runner = spawnSync } = {}) {
  if (typeof appPath !== 'string'
    || !isAbsolute(appPath)
    || normalize(appPath) !== appPath
    || appPath.endsWith(sep)
    || basename(appPath) !== 'App.app'
    || /[\0-\x1f\x7f\\]/u.test(appPath)) {
    throw new Error('App path must be a normalized absolute path ending in App.app')
  }
  const machOFiles = inventoryMachOFiles(appPath)
  const actualInventory = [...machOFiles.keys()].sort()
  const expectedInventory = [...EXPECTED_MACH_O_FILES].sort()
  if (actualInventory.length !== expectedInventory.length
    || actualInventory.some((path, index) => path !== expectedInventory[index])) {
    throw new Error(`Mach-O inventory must be exactly ${expectedInventory.join(', ')}; found ${actualInventory.join(', ') || 'none'}`)
  }

  for (const relativePath of EXPECTED_MACH_O_FILES) {
    const file = machOFiles.get(relativePath)
    if ((file.stats.mode & 0o111) === 0) throw new Error(`${relativePath} must be executable`)
    validateArchitecture(file.path, runner)
    validateBuildVersion(file.path, runner)
    validateDependencies(file.path, appPath, machOFiles, runner)
    validateRunpaths(relativePath, file.path, runner)
  }
  return actualInventory
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) {
    console.error('Usage: node scripts/check-ios-archive-mach-o.mjs /absolute/path/to/App.app')
    process.exitCode = 1
  } else {
    try {
      const inventory = inspectIosArchiveMachO(process.argv[2])
      console.log(`PASS iOS archive Mach-O policy: ${inventory.join(', ')}`)
    } catch (error) {
      console.error(`FAIL iOS archive Mach-O policy: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  }
}
