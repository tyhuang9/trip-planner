import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { inspectIosArchiveMachO } from './check-ios-archive-mach-o.mjs'

const MACH_O_FILES = [
  'App',
  'Frameworks/Capacitor.framework/Capacitor',
  'Frameworks/Cordova.framework/Cordova',
]
const MACH_O_MAGICS = [
  'cafebabe', 'cafebabf', 'bebafeca', 'bfbafeca',
  'cefaedfe', 'cffaedfe', 'feedface', 'feedfacf',
]

async function createApp() {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'dupert-mach-o-test-'))
  const appPath = join(temporaryDirectory, 'App.app')
  for (const relativePath of MACH_O_FILES) {
    const path = join(appPath, relativePath)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, Buffer.from(`${relativePath === 'App' ? 'cffaedfe' : 'cafebabe'}00000000`, 'hex'))
    await chmod(path, 0o755)
  }
  await writeFile(join(appPath, 'Info.plist'), 'not a Mach-O file')
  return { appPath, temporaryDirectory }
}

function buildOutput(path, { minos = '15.0', platform = 'IOS' } = {}) {
  return `${path}:
Load command 10
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform ${platform}
    minos ${minos}
      sdk 99.7
   ntools 1
     tool LD
  version 1234.5
`
}

function dependencyOutput(path, dependencies = ['/System/Library/Frameworks/Foundation.framework/Foundation']) {
  return `${path}:\n${dependencies.map((dependency) => `\t${dependency} (compatibility version 1.0.0, current version 2.0.0)`).join('\n')}\n`
}

function successRunner(overrides = {}) {
  return (command, args, options) => {
    const path = args.at(-1)
    const key = command === '/usr/bin/lipo' ? 'lipo' : command === '/usr/bin/xcrun' ? 'vtool' : 'otool'
    const stdout = overrides[key]?.(path, command, args, options)
      ?? (key === 'lipo' ? 'arm64\n' : key === 'vtool' ? buildOutput(path) : dependencyOutput(path))
    return { error: undefined, signal: null, status: 0, stderr: '', stdout }
  }
}

async function withApp(t) {
  const fixture = await createApp()
  t.after(() => rm(fixture.temporaryDirectory, { force: true, recursive: true }))
  return fixture.appPath
}

test('accepts exactly the expected executable arm64 iOS 15.0 Mach-O inventory', async (t) => {
  const appPath = await withApp(t)
  const calls = []
  const delegate = successRunner({
    otool: (path, command, args, options) => {
      const dependencies = path.endsWith('/App')
        ? [
            '/System/Library/Frameworks/UIKit.framework/UIKit',
            '/usr/lib/libSystem.B.dylib',
            '@rpath/Capacitor.framework/Capacitor',
            '@rpath/Cordova.framework/Cordova',
          ]
        : [path.includes('Capacitor.framework')
            ? '@rpath/Capacitor.framework/Capacitor'
            : '@rpath/Cordova.framework/Cordova']
      return dependencyOutput(path, dependencies)
    },
  })
  const runner = (command, args, options) => {
    calls.push({ command, args, options })
    return delegate(command, args, options)
  }

  assert.deepEqual(inspectIosArchiveMachO(appPath, { runner }), [...MACH_O_FILES].sort())
  assert.equal(calls.length, 9)
  assert.deepEqual([...new Set(calls.map(({ command }) => command))].sort(), [
    '/usr/bin/lipo',
    '/usr/bin/otool',
    '/usr/bin/xcrun',
  ])
  assert.equal(calls[0].options.shell, false)
  assert.equal(calls[0].options.timeout, 15_000)
  assert.equal(calls[0].options.maxBuffer, 1024 * 1024)
  assert.deepEqual(calls[0].args.slice(0, -1), ['-archs'])
})

test('discovers every thin and fat Mach-O magic and rejects it as extra inventory', async (t) => {
  for (const magic of MACH_O_MAGICS) {
    await t.test(magic, async (t) => {
      const appPath = await withApp(t)
      const extraPath = join(appPath, `extra-${magic}`)
      await writeFile(extraPath, Buffer.from(`${magic}00000000`, 'hex'))
      await chmod(extraPath, 0o755)
      assert.throws(
        () => inspectIosArchiveMachO(appPath, { runner: successRunner() }),
        new RegExp(`found .*extra-${magic}`),
      )
    })
  }
})

test('rejects missing Mach-O files and expected files without executable permission', async (t) => {
  const appPath = await withApp(t)
  await writeFile(join(appPath, 'App'), 'not Mach-O')
  assert.throws(() => inspectIosArchiveMachO(appPath, { runner: successRunner() }), /Mach-O inventory must be exactly/u)

  await writeFile(join(appPath, 'App'), Buffer.from('cffaedfe00000000', 'hex'))
  await chmod(join(appPath, 'App'), 0o644)
  assert.throws(() => inspectIosArchiveMachO(appPath, { runner: successRunner() }), /App must be executable/u)
})

test('rejects simulator, x86_64, universal, duplicate, and additional architecture output', async (t) => {
  const appPath = await withApp(t)
  for (const architectures of ['x86_64', 'arm64 x86_64', 'x86_64 arm64', 'arm64 arm64', 'arm64 arm64e']) {
    assert.throws(
      () => inspectIosArchiveMachO(appPath, { runner: successRunner({ lipo: () => `${architectures}\n` }) }),
      /must contain exactly the arm64 architecture/u,
    )
  }
  assert.throws(
    () => inspectIosArchiveMachO(appPath, { runner: successRunner({
      vtool: (path) => buildOutput(path, { platform: 'IOSSIMULATOR' }),
    }) }),
    /must target exactly platform IOS/u,
  )
})

test('rejects raised, missing, duplicate, and malformed deployment-target output', async (t) => {
  const appPath = await withApp(t)
  const cases = [
    [(path) => buildOutput(path, { minos: '16.0' }), /must declare exactly minos 15\.0/u],
    [(path) => buildOutput(path).replace('    minos 15.0\n', ''), /malformed vtool/u],
    [(path) => buildOutput(path).replace('    minos 15.0\n', '    minos 15.0\n    minos 15.0\n'), /malformed vtool/u],
    [(path) => buildOutput(path).replace(' platform IOS\n', ' platform IOS\n platform IOS\n'), /malformed vtool/u],
    [(path) => buildOutput(path).replace('  cmdsize 32', 'broken'), /malformed vtool/u],
  ]
  for (const [vtool, expectedError] of cases) {
    assert.throws(
      () => inspectIosArchiveMachO(appPath, { runner: successRunner({ vtool }) }),
      expectedError,
    )
  }
})

test('rejects malformed and duplicate lipo and otool output', async (t) => {
  const appPath = await withApp(t)
  const malformedRunners = [
    successRunner({ lipo: () => 'arm64' }),
    successRunner({ lipo: () => 'arm64\n\n' }),
    successRunner({ otool: (path) => `${path}:\nmalformed\n` }),
    successRunner({ otool: (path) => dependencyOutput(path, ['/usr/lib/libSystem.B.dylib', '/usr/lib/libSystem.B.dylib']) }),
    successRunner({ otool: (path) => `${path}:\n${path}:\n` }),
  ]
  for (const runner of malformedRunners) {
    assert.throws(() => inspectIosArchiveMachO(appPath, { runner }), /malformed|duplicate/u)
  }
})

test('rejects private, unsafe absolute, traversal, unexpected rpath, loader, and executable-relative dependencies', async (t) => {
  const appPath = await withApp(t)
  const dependencies = [
    '/System/Library/PrivateFrameworks/Secret.framework/Secret',
    '/opt/vendor/libVendor.dylib',
    '/usr/lib/../private/libSecret.dylib',
    '/System/Library/Frameworks//UIKit.framework/UIKit',
    '@rpath/Other.framework/Other',
    '@rpath/../Capacitor.framework/Capacitor',
    '@loader_path/Frameworks/Capacitor.framework/Capacitor',
    '@executable_path/Frameworks/Capacitor.framework/Capacitor',
  ]
  for (const dependency of dependencies) {
    assert.throws(
      () => inspectIosArchiveMachO(appPath, { runner: successRunner({
        otool: (path) => dependencyOutput(path, [dependency]),
      }) }),
      /unsafe or unexpected dependency/u,
    )
  }
})

test('rejects tool failure, signal, timeout, thrown runners, stderr, and oversized output', async (t) => {
  const appPath = await withApp(t)
  const error = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })
  const results = [
    { status: 2, signal: null, stderr: '', stdout: '' },
    { status: null, signal: 'SIGKILL', stderr: '', stdout: '' },
    { error, status: null, signal: 'SIGKILL', stderr: '', stdout: '' },
    { status: 0, signal: null, stderr: 'warning', stdout: 'arm64\n' },
    { status: 0, signal: null, stderr: '', stdout: `${'x'.repeat(1024 * 1024)}x` },
  ]
  for (const result of results) {
    assert.throws(() => inspectIosArchiveMachO(appPath, { runner: () => result }), /lipo/u)
  }
  assert.throws(
    () => inspectIosArchiveMachO(appPath, { runner: () => { throw new Error('boom') } }),
    /lipo could not start/u,
  )
})

test('rejects root and nested symlinks without following them', async (t) => {
  const appPath = await withApp(t)
  await symlink('Info.plist', join(appPath, 'linked-file'))
  assert.throws(() => inspectIosArchiveMachO(appPath, { runner: successRunner() }), /must not contain symlinks/u)

  const linkedDirectory = join(dirname(appPath), 'linked')
  await mkdir(linkedDirectory)
  const linkedRoot = join(linkedDirectory, 'App.app')
  await symlink(appPath, linkedRoot)
  assert.throws(() => inspectIosArchiveMachO(linkedRoot, { runner: successRunner() }), /regular directory/u)
})

test('rejects unsafe paths, missing roots, non-directory roots, and special filesystem entries', async (t) => {
  const appPath = await withApp(t)
  assert.throws(() => inspectIosArchiveMachO('relative/App.app', { runner: successRunner() }), /normalized absolute path/u)
  assert.throws(() => inspectIosArchiveMachO(`${appPath}/`, { runner: successRunner() }), /normalized absolute path/u)
  assert.throws(() => inspectIosArchiveMachO(join(dirname(appPath), 'Missing.app'), { runner: successRunner() }))

  const fileDirectory = join(dirname(appPath), 'file')
  await mkdir(fileDirectory)
  const fileRoot = join(fileDirectory, 'App.app')
  await writeFile(fileRoot, 'file')
  assert.throws(() => inspectIosArchiveMachO(fileRoot, { runner: successRunner() }), /regular directory/u)

  await writeFile(join(appPath, 'bad\\name'), 'file')
  assert.throws(() => inspectIosArchiveMachO(appPath, { runner: successRunner() }), /unsafe path component/u)
  await rm(join(appPath, 'bad\\name'))

  const fifoPath = join(appPath, 'fifo')
  assert.equal(spawnSync('/usr/bin/mkfifo', [fifoPath], { shell: false }).status, 0)
  assert.throws(() => inspectIosArchiveMachO(appPath, { runner: successRunner() }), /unsupported filesystem entry/u)
})
