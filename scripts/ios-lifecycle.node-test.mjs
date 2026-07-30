import assert from 'node:assert/strict'
import { access, chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const lifecycleScript = join(repositoryRoot, 'scripts/ios-lifecycle.sh')
const simulatorUdid = '00000000-0000-0000-0000-000000000001'
const secondSimulatorUdid = '00000000-0000-0000-0000-000000000002'
const reservationName = `${simulatorUdid}--io.github.tyhuang9.dupert.lock`

async function fixture({ devices, pendingReservation, reservationOwner, state } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dupert-ios-lifecycle-'))
  const bin = join(root, 'bin')
  const log = join(root, 'commands.log')
  await mkdir(join(root, 'scripts'), { recursive: true })
  await mkdir(join(root, 'frontend/node_modules/.bin'), { recursive: true })
  await mkdir(join(root, '.git'), { recursive: true })
  await mkdir(bin)
  await cp(lifecycleScript, join(root, 'scripts/ios-lifecycle.sh'))
  await writeFile(join(root, 'frontend/.env.native-development.local'), 'VITE_BACKEND_API_URL=http://localhost:8000\n')
  await writeFile(join(root, 'frontend/node_modules/.bin/cap'), '')
  await chmod(join(root, 'frontend/node_modules/.bin/cap'), 0o755)
  if (state !== undefined) {
    await mkdir(join(root, '.dupert'))
    await writeFile(
      join(root, '.dupert/ios-lifecycle.json'),
      typeof state === 'string' ? state : JSON.stringify({ repositoryRoot: root, ...state }),
    )
  }
  const hasValidStateShape = typeof state === 'object' && state !== null &&
    typeof state.simulatorUdid === 'string' && typeof state.bootedByShortcut === 'boolean'
  if (pendingReservation || reservationOwner !== undefined || hasValidStateShape) {
    const owner = reservationOwner === 'self'
      ? root
      : reservationOwner ?? state?.repositoryRoot ?? root
    const reservation = join(root, '.git/dupert-ios-shortcuts', reservationName)
    await mkdir(join(root, '.git/dupert-ios-shortcuts'), { recursive: true })
    await writeFile(reservation, JSON.stringify(pendingReservation ? {
      phase: 'pending',
      repositoryRoot: pendingReservation.repositoryRoot === 'self' ? root : pendingReservation.repositoryRoot,
      pid: pendingReservation.pid,
      processStart: pendingReservation.processStart,
    } : { phase: 'owned', repositoryRoot: owner }))
  }
  const payload = JSON.stringify({ devices: { 'iOS 26.0': devices ?? [] } })
  const commands = {
    uname: '#!/usr/bin/env bash\necho Darwin\n',
    'xcode-select': '#!/usr/bin/env bash\necho /Applications/Xcode.app\n',
    git: '#!/usr/bin/env bash\necho "$DUPERT_TEST_GIT_COMMON_DIR"\n',
    lockf: '#!/usr/bin/env bash\nexit 0\n',
    npm: `#!/usr/bin/env bash\necho "npm $*" >> "$DUPERT_TEST_LOG"\n`,
    npx: `#!/usr/bin/env bash\necho "npx $*" >> "$DUPERT_TEST_LOG"\nexit "\${DUPERT_TEST_NPX_EXIT:-0}"\n`,
    ps: `#!/usr/bin/env bash
pid=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-p" ]]; then pid="$2"; break; fi
  shift
done
if [[ "$pid" == "999999" ]]; then exit 1; fi
if [[ -n "\${DUPERT_TEST_LIVE_PID:-}" && "$pid" == "\$DUPERT_TEST_LIVE_PID" ]]; then echo "\$DUPERT_TEST_LIVE_START"; exit 0; fi
echo test-current-process-start
`,
    xcrun: `#!/usr/bin/env bash
echo "xcrun $*" >> "$DUPERT_TEST_LOG"
if [[ "$1" == "--find" ]]; then echo /usr/bin/simctl; exit 0; fi
if [[ "$1 $2 $3 $4" == "simctl list devices available" ]]; then echo '${payload}'; exit 0; fi
if [[ "$1 $2" == "simctl boot" ]]; then exit "\${DUPERT_TEST_BOOT_EXIT:-0}"; fi
if [[ "$1 $2" == "simctl terminate" ]]; then
  [[ -z "\${DUPERT_TEST_TERMINATE_MESSAGE:-}" ]] || echo "\$DUPERT_TEST_TERMINATE_MESSAGE" >&2
  exit "\${DUPERT_TEST_TERMINATE_EXIT:-0}"
fi
exit 0
`,
  }
  await Promise.all(Object.entries(commands).map(async ([name, contents]) => {
    const path = join(bin, name)
    await writeFile(path, contents)
    await chmod(path, 0o755)
  }))
  const run = (command, env = {}) => spawnSync('bash', [join(root, 'scripts/ios-lifecycle.sh'), command], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      DUPERT_TEST_GIT_COMMON_DIR: join(root, '.git'),
      DUPERT_TEST_LOG: log,
      PATH: `${bin}:${process.env.PATH}`,
    },
  })
  const commandsRun = async () => readFile(log, 'utf8').catch(() => '')
  return {
    root,
    reservation: join(root, '.git/dupert-ios-shortcuts', reservationName),
    run,
    commandsRun,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

const iphone = (state = 'Shutdown') => ({ udid: simulatorUdid, name: 'iPhone 17', state, isAvailable: true })
const secondIphone = (state = 'Shutdown') => ({
  udid: secondSimulatorUdid, name: 'iPhone 17 Pro', state, isAvailable: true,
})

function checkedSpawnSync(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options })
  assert.equal(result.status, 0, `${command} ${args.join(' ')} failed:\n${result.stderr}`)
  return result.stdout.trim()
}

function runAsync(script, cwd, env) {
  const child = spawn('bash', [script, 'start'], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
  const result = new Promise((resolveRun, rejectRun) => {
    child.once('error', rejectRun)
    child.once('close', (status, signal) => resolveRun({ status, signal, stdout, stderr }))
  })
  return { child, result }
}

async function sharedWorktreeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dupert-ios-lifecycle-shared-'))
  const repository = join(root, 'repository')
  const firstRoot = join(root, 'worktree-a')
  const secondRoot = join(root, 'worktree-b')
  const bin = join(root, 'bin')
  const sync = join(root, 'lock-sync')
  const gates = [join(sync, 'gate-a'), join(sync, 'gate-b')]
  const log = join(root, 'commands.log')
  await Promise.all([mkdir(repository), mkdir(bin), mkdir(sync)])
  for (const gate of gates) checkedSpawnSync('mkfifo', [gate])
  checkedSpawnSync('git', ['init', '-q', '-b', 'main', repository])
  checkedSpawnSync('git', ['-C', repository, 'config', 'user.email', 'ios-lifecycle@example.test'])
  checkedSpawnSync('git', ['-C', repository, 'config', 'user.name', 'iOS Lifecycle Test'])
  checkedSpawnSync('git', ['-C', repository, 'commit', '--allow-empty', '-qm', 'fixture'])
  checkedSpawnSync('git', ['-C', repository, 'worktree', 'add', '-qb', 'fixture-a', firstRoot])
  checkedSpawnSync('git', ['-C', repository, 'worktree', 'add', '-qb', 'fixture-b', secondRoot])

  for (const worktree of [firstRoot, secondRoot]) {
    await mkdir(join(worktree, 'scripts'), { recursive: true })
    await mkdir(join(worktree, 'frontend/node_modules/.bin'), { recursive: true })
    await cp(lifecycleScript, join(worktree, 'scripts/ios-lifecycle.sh'))
    await writeFile(join(worktree, 'frontend/.env.native-development.local'), 'VITE_BACKEND_API_URL=http://localhost:8000\n')
    await writeFile(join(worktree, 'frontend/node_modules/.bin/cap'), '')
    await chmod(join(worktree, 'frontend/node_modules/.bin/cap'), 0o755)
  }

  const payload = JSON.stringify({ devices: { 'iOS 26.0': [iphone('Booted')] } })
  const systemLockf = '/usr/bin/lockf'
  await access(systemLockf)
  const commands = {
    uname: '#!/usr/bin/env bash\necho Darwin\n',
    'xcode-select': '#!/usr/bin/env bash\necho /Applications/Xcode.app\n',
    lockf: `#!/usr/bin/env bash
read -r _ < "$DUPERT_TEST_LOCK_GATE"
exec ${systemLockf} "$@"
`,
    npm: `#!/usr/bin/env bash\necho "npm $PWD $*" >> "$DUPERT_TEST_LOG"\n`,
    npx: `#!/usr/bin/env bash\necho "npx $PWD $*" >> "$DUPERT_TEST_LOG"\n`,
    ps: `#!/usr/bin/env bash
pid=""
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-p" ]]; then pid="$2"; break; fi
  shift
done
if [[ "$pid" == "999999" ]]; then exit 1; fi
echo test-current-process-start
`,
    xcrun: `#!/usr/bin/env bash
echo "xcrun $PWD $*" >> "$DUPERT_TEST_LOG"
if [[ "$1" == "--find" ]]; then echo /usr/bin/simctl; exit 0; fi
if [[ "$1 $2 $3 $4" == "simctl list devices available" ]]; then echo '${payload}'; exit 0; fi
exit 0
`,
  }
  await Promise.all(Object.entries(commands).map(async ([name, contents]) => {
    const path = join(bin, name)
    await writeFile(path, contents)
    await chmod(path, 0o755)
  }))

  const commonDirectory = checkedSpawnSync('git', ['-C', firstRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
  const reservationsDirectory = join(commonDirectory, 'dupert-ios-shortcuts')
  const reservation = join(reservationsDirectory, reservationName)
  await mkdir(reservationsDirectory)
  await writeFile(reservation, JSON.stringify({
    phase: 'pending', repositoryRoot: '/abandoned/worktree', pid: 999999, processStart: 'dead-process-start',
  }))

  const env = {
    DUPERT_TEST_LOG: log,
    PATH: `${bin}:${process.env.PATH}`,
  }
  return {
    roots: [firstRoot, secondRoot],
    scripts: [join(firstRoot, 'scripts/ios-lifecycle.sh'), join(secondRoot, 'scripts/ios-lifecycle.sh')],
    reservation,
    gates,
    log,
    env,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

test('selects an explicit simulator name, boots it once, and records ownership', async (t) => {
  const subject = await fixture({ devices: [iphone()] })
  t.after(subject.cleanup)
  const result = subject.run('start', { DUPERT_IOS_SIMULATOR: 'iPhone 17' })
  assert.equal(result.status, 0, result.stderr)
  assert.match(await subject.commandsRun(), new RegExp(`xcrun simctl boot ${simulatorUdid}`))
  assert.match(await subject.commandsRun(), new RegExp(`xcrun simctl bootstatus ${simulatorUdid} -b`))
  assert.match(await subject.commandsRun(), /npm run sync:native:development/)
  assert.match(await subject.commandsRun(), new RegExp(`npx cap run ios --target ${simulatorUdid} --no-sync`))
  assert.deepEqual(JSON.parse(await readFile(join(subject.root, '.dupert/ios-lifecycle.json'))), {
    repositoryRoot: subject.root, simulatorUdid, bootedByShortcut: true,
  })
})

test('uses exactly one prebooted iPhone without claiming ownership', async (t) => {
  const subject = await fixture({ devices: [iphone('Booted')] })
  t.after(subject.cleanup)
  const result = subject.run('start')
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(await subject.commandsRun(), /simctl boot /)
  assert.equal(JSON.parse(await readFile(join(subject.root, '.dupert/ios-lifecycle.json'))).bootedByShortcut, false)
})

test('reuses the worktree-owned booted simulator without a second boot', async (t) => {
  const subject = await fixture({ devices: [iphone('Booted')], state: { simulatorUdid, bootedByShortcut: true } })
  t.after(subject.cleanup)
  const result = subject.run('start')
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(await subject.commandsRun(), /simctl boot /)
  assert.doesNotMatch(await subject.commandsRun(), /npm |npx /)
  assert.equal(JSON.parse(await readFile(join(subject.root, '.dupert/ios-lifecycle.json'))).bootedByShortcut, true)
})

test('ignores corrupt and partial state when starting safely', async (t) => {
  for (const [label, state] of [
    ['corrupt', '{not json'],
    ['partial', { simulatorUdid }],
  ]) {
    await t.test(label, async (t) => {
      const subject = await fixture({ devices: [iphone('Booted')], state })
      t.after(subject.cleanup)
      const result = subject.run('start')
      assert.equal(result.status, 0, result.stderr)
      assert.equal(JSON.parse(await readFile(join(subject.root, '.dupert/ios-lifecycle.json'))).bootedByShortcut, false)
    })
  }
})

test('fails instead of guessing when no safe default simulator exists', async (t) => {
  const subject = await fixture({ devices: [iphone()] })
  t.after(subject.cleanup)
  const result = subject.run('start')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Set DUPERT_IOS_SIMULATOR/)
  assert.doesNotMatch(await subject.commandsRun(), /simctl boot /)
})

test('fails before invoking Simulator when the native development environment is absent', async (t) => {
  const subject = await fixture({ devices: [iphone('Booted')] })
  t.after(subject.cleanup)
  await rm(join(subject.root, 'frontend/.env.native-development.local'))
  const result = subject.run('start')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Missing frontend\/\.env\.native-development\.local/)
  assert.equal(await subject.commandsRun(), 'xcrun --find simctl\n')
})

test('does not record ownership when Simulator cannot boot the selected device', async (t) => {
  const subject = await fixture({ devices: [iphone()] })
  t.after(subject.cleanup)
  const result = subject.run('start', {
    DUPERT_IOS_SIMULATOR: simulatorUdid,
    DUPERT_TEST_BOOT_EXIT: '42',
  })
  assert.equal(result.status, 42)
  await assert.rejects(readFile(join(subject.root, '.dupert/ios-lifecycle.json')))
  await assert.rejects(readFile(subject.reservation), result.stderr)
})

test('releases a pending reservation when Capacitor launch fails', async (t) => {
  const subject = await fixture({ devices: [iphone('Booted')] })
  t.after(subject.cleanup)
  const result = subject.run('start', { DUPERT_TEST_NPX_EXIT: '23' })
  assert.equal(result.status, 23)
  await assert.rejects(readFile(join(subject.root, '.dupert/ios-lifecycle.json')))
  await assert.rejects(readFile(subject.reservation), result.stderr)
})

test('recovers a pending reservation abandoned by an interrupted first start', async (t) => {
  const subject = await fixture({
    devices: [iphone('Booted')],
    pendingReservation: { repositoryRoot: 'self', pid: 999999, processStart: 'dead-process-start' },
  })
  t.after(subject.cleanup)
  const result = subject.run('start')
  assert.equal(result.status, 0, result.stderr)
  assert.match(await subject.commandsRun(), /npm run sync:native:development/)
  assert.equal(JSON.parse(await readFile(subject.reservation, 'utf8')).phase, 'owned')
})

test('allows exactly one stale-reservation takeover across worktrees sharing a Git common directory', {
  skip: process.platform !== 'darwin' ? 'macOS lockf semantics are required' : false,
}, async (t) => {
  const subject = await sharedWorktreeFixture()
  t.after(subject.cleanup)
  const runs = subject.scripts.map((script, index) => runAsync(script, subject.roots[index], {
    ...subject.env,
    DUPERT_TEST_LOCK_GATE: subject.gates[index],
  }))
  t.after(() => runs.forEach(({ child }) => { if (child.exitCode === null) child.kill('SIGKILL') }))

  await Promise.all(subject.gates.map((gate) => writeFile(gate, 'continue\n')))
  const results = await Promise.all(runs.map(({ result }) => result))

  const winners = results.flatMap((result, index) => result.status === 0 ? [{ result, index }] : [])
  const losers = results.flatMap((result, index) => result.status !== 0 ? [{ result, index }] : [])
  assert.equal(winners.length, 1, JSON.stringify(results, null, 2))
  assert.equal(losers.length, 1, JSON.stringify(results, null, 2))
  assert.match(losers[0].result.stderr, /start in progress|reserved by another worktree/)

  const winnerRoot = subject.roots[winners[0].index]
  assert.deepEqual(JSON.parse(await readFile(subject.reservation, 'utf8')), {
    phase: 'owned', repositoryRoot: winnerRoot,
  })
  const commands = await readFile(subject.log, 'utf8')
  assert.equal(commands.match(/npm .* run sync:native:development/g)?.length, 1, commands)
  assert.equal(commands.match(/npx .* cap run ios/g)?.length, 1, commands)
})

test('serializes a same-worktree start while its pending owner is alive', async (t) => {
  const subject = await fixture({
    devices: [iphone('Booted')],
    pendingReservation: { repositoryRoot: 'self', pid: 4242, processStart: 'live-process-start' },
  })
  t.after(subject.cleanup)
  const result = subject.run('start', {
    DUPERT_TEST_LIVE_PID: '4242', DUPERT_TEST_LIVE_START: 'live-process-start',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /start in progress/)
  assert.doesNotMatch(await subject.commandsRun(), /npm |npx /)
  assert.equal(JSON.parse(await readFile(subject.reservation, 'utf8')).phase, 'pending')
})

test('does not let one worktree reserve a different simulator while it owns another', async (t) => {
  const subject = await fixture({
    devices: [iphone('Booted'), secondIphone('Booted')],
    state: { simulatorUdid, bootedByShortcut: false },
  })
  t.after(subject.cleanup)

  const result = subject.run('start', { DUPERT_IOS_SIMULATOR: secondSimulatorUdid })

  assert.notEqual(result.status, 0)
  assert.match(result.stderr, new RegExp(`already owns simulator ${simulatorUdid}`))
  assert.match(result.stderr, /run npm run stopios/)
  assert.doesNotMatch(await subject.commandsRun(), /npm |npx |simctl boot /)
  assert.deepEqual(JSON.parse(await readFile(subject.reservation, 'utf8')), {
    phase: 'owned', repositoryRoot: subject.root,
  })
  await assert.rejects(readFile(join(
    subject.root,
    '.git/dupert-ios-shortcuts',
    `${secondSimulatorUdid}--io.github.tyhuang9.dupert.lock`,
  )))
})

test('rejects a concurrent start reserved by another worktree', async (t) => {
  const subject = await fixture({ devices: [iphone('Booted')], reservationOwner: '/different/worktree' })
  t.after(subject.cleanup)
  const result = subject.run('start')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /reserved by another worktree/)
  assert.doesNotMatch(await subject.commandsRun(), /npm |npx |simctl boot /)
})

test('reports same-worktree reservation recovery when local state cannot prove ownership', async (t) => {
  const scenarios = [
    { name: 'missing state', state: undefined },
    { name: 'invalid state', state: '{not json' },
    {
      name: 'different simulator',
      state: {
        simulatorUdid: '00000000-0000-0000-0000-000000000002',
        bootedByShortcut: false,
      },
    },
  ]

  for (const scenario of scenarios) {
    await t.test(scenario.name, async (scenarioTest) => {
      const subject = await fixture({
        devices: [iphone('Booted')],
        reservationOwner: 'self',
        state: scenario.state,
      })
      scenarioTest.after(subject.cleanup)

      const result = subject.run('start')

      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /This worktree holds the reservation/)
      assert.match(result.stderr, /local state is missing, invalid, or records a different simulator/)
      assert.match(result.stderr, /After confirming Dupert is not running/)
      assert.match(result.stderr, /run npm run startios again/)
      assert.doesNotMatch(result.stderr, /reserved by another worktree/)
      assert.doesNotMatch(await subject.commandsRun(), /npm |npx |simctl boot /)
      assert.equal(JSON.parse(await readFile(subject.reservation, 'utf8')).phase, 'owned')
    })
  }
})

test('stops only the recorded app and never shuts down Simulator', async (t) => {
  const subject = await fixture({ devices: [iphone('Booted')], state: { simulatorUdid, bootedByShortcut: false } })
  t.after(subject.cleanup)
  const result = subject.run('stop')
  assert.equal(result.status, 0, result.stderr)
  const commands = await subject.commandsRun()
  assert.match(commands, new RegExp(`xcrun simctl terminate ${simulatorUdid} io\\.github\\.tyhuang9\\.dupert`))
  assert.doesNotMatch(commands, /simctl shutdown/)
})

test('does not shut down even when the shortcut originally booted Simulator', async (t) => {
  const subject = await fixture({ devices: [iphone('Booted')], state: { simulatorUdid, bootedByShortcut: true } })
  t.after(subject.cleanup)
  const result = subject.run('stop')
  assert.equal(result.status, 0, result.stderr)
  const commands = await subject.commandsRun()
  assert.match(commands, new RegExp(`terminate ${simulatorUdid} io\\.github\\.tyhuang9\\.dupert`))
  assert.doesNotMatch(commands, /shutdown/)
})

test('preserves state and does not touch Simulator for another worktree', async (t) => {
  const subject = await fixture({ devices: [iphone('Booted')], state: {
    repositoryRoot: '/different/worktree', simulatorUdid, bootedByShortcut: true,
  } })
  t.after(subject.cleanup)
  const result = subject.run('stop')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /belongs to another worktree/)
  assert.equal(await subject.commandsRun(), '')
  assert.equal(JSON.parse(await readFile(join(subject.root, '.dupert/ios-lifecycle.json'))).repositoryRoot, '/different/worktree')
})

test('preserves local state when the global reservation has another owner', async (t) => {
  const subject = await fixture({
    devices: [iphone('Booted')],
    reservationOwner: '/different/worktree',
    state: { simulatorUdid, bootedByShortcut: true },
  })
  t.after(subject.cleanup)
  const result = subject.run('stop')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /reservation belongs to another worktree/)
  assert.equal(await subject.commandsRun(), '')
  assert.equal(JSON.parse(await readFile(join(subject.root, '.dupert/ios-lifecycle.json'))).simulatorUdid, simulatorUdid)
})

test('preserves corrupt state without touching Simulator during stop', async (t) => {
  const subject = await fixture({ devices: [iphone('Booted')], state: '{not json' })
  t.after(subject.cleanup)
  const result = subject.run('stop')
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Invalid iOS shortcut state/)
  assert.equal(await subject.commandsRun(), '')
  assert.equal(await readFile(join(subject.root, '.dupert/ios-lifecycle.json'), 'utf8'), '{not json')
})

test('preserves state and does not shut down after an unexpected terminate failure', async (t) => {
  const subject = await fixture({ devices: [iphone('Booted')], state: { simulatorUdid, bootedByShortcut: true } })
  t.after(subject.cleanup)
  const result = subject.run('stop', {
    DUPERT_TEST_TERMINATE_EXIT: '17',
    DUPERT_TEST_TERMINATE_MESSAGE: 'permission denied',
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Could not terminate Dupert/)
  assert.doesNotMatch(await subject.commandsRun(), /simctl shutdown/)
  assert.equal(JSON.parse(await readFile(join(subject.root, '.dupert/ios-lifecycle.json'))).bootedByShortcut, true)
})

test('recognizes the expected app-not-running result before releasing ownership', async (t) => {
  const subject = await fixture({ devices: [iphone('Booted')], state: { simulatorUdid, bootedByShortcut: true } })
  t.after(subject.cleanup)
  const result = subject.run('stop', {
    DUPERT_TEST_TERMINATE_EXIT: '3',
    DUPERT_TEST_TERMINATE_MESSAGE: 'domain=NSPOSIXErrorDomain, code=3: No such process',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.doesNotMatch(await subject.commandsRun(), /simctl shutdown/)
  await assert.rejects(readFile(join(subject.root, '.dupert/ios-lifecycle.json')))
})
