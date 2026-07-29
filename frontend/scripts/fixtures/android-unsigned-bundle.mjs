export const emptyZip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex')

export const requiredEntries = [
  'BundleConfig.pb',
  'base/manifest/AndroidManifest.xml',
  'base/assets/public/index.html',
]

export const expectedManifest = new Map([
  ['/manifest/@package', 'io.github.tyhuang9.dupert'],
  ['/manifest/@android:versionCode', '1'],
  ['/manifest/@android:versionName', '1.0'],
  ['/manifest/uses-sdk/@android:minSdkVersion', '24'],
  ['/manifest/uses-sdk/@android:targetSdkVersion', '36'],
])

export const unsignedJarsigner = {
  status: 0,
  signal: null,
  stdout: '\njar is unsigned.\n',
  stderr: '',
}

export function bundletoolValidation(entries = requiredEntries) {
  const files = entries
    .filter((entry) => entry.startsWith('base/') && !entry.endsWith('/'))
    .map((entry) => `\t\tFile: ${entry.slice('base/'.length)}`)
  return `App Bundle information\n------------\nFeature modules:\n\tFeature module: base\n${files.join('\n')}\n`
}

const UNIX_MODES = {
  '-': 0o100644,
  b: 0o060644,
  c: 0o020644,
  d: 0o040755,
  l: 0o120777,
  p: 0o010644,
  s: 0o140777,
}

export function unicodePathExtra(path) {
  const encodedPath = Buffer.from(path, 'utf8')
  const field = Buffer.alloc(9 + encodedPath.length)
  field.writeUInt16LE(0x7075, 0)
  field.writeUInt16LE(5 + encodedPath.length, 2)
  field.writeUInt8(1, 4)
  encodedPath.copy(field, 9)
  return field
}

export function extendedTimestampExtra({ accessedTime, createdTime, modifiedTime = 0 } = {}) {
  const values = [modifiedTime, accessedTime, createdTime]
  const flags = values.reduce((result, value, index) => (
    value === undefined ? result : result | (1 << index)
  ), 0)
  const field = Buffer.alloc(5 + (4 * values.filter((value) => value !== undefined).length))
  field.writeUInt16LE(0x5455, 0)
  field.writeUInt16LE(field.length - 4, 2)
  field.writeUInt8(flags, 4)
  let offset = 5
  for (const value of values) {
    if (value === undefined) continue
    field.writeUInt32LE(value, offset)
    offset += 4
  }
  return field
}

export function zipFixture(entries = requiredEntries, types = {}, {
  centralExtraFields = {},
  declaredEntryCount = entries.length,
  externalAttributes = {},
  hostSystem = 3,
  hostSystems = {},
  localExtraFields = centralExtraFields,
} = {}) {
  const localRecords = []
  const centralRecords = []
  let localOffset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry, 'utf8')
    const flags = name.some((byte) => byte >= 0x80) ? 0x800 : 0
    const type = types[entry] ?? (entry.endsWith('/') ? 'd' : '-')
    const mode = UNIX_MODES[type]
    if (mode === undefined) throw new Error(`Unsupported fixture ZIP type: ${type}`)
    const creator = hostSystems[entry] ?? hostSystem
    const centralExtra = centralExtraFields[entry] ?? Buffer.alloc(0)
    const localExtra = localExtraFields[entry] ?? Buffer.alloc(0)
    const attributes = Object.hasOwn(externalAttributes, entry)
      ? externalAttributes[entry]
      : creator === 3 ? (mode << 16) >>> 0 : 0

    const local = Buffer.alloc(30 + name.length + localExtra.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(localExtra.length, 28)
    name.copy(local, 30)
    localExtra.copy(local, 30 + name.length)
    localRecords.push(local)

    const central = Buffer.alloc(46 + name.length + centralExtra.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((creator << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(centralExtra.length, 30)
    central.writeUInt32LE(attributes >>> 0, 38)
    central.writeUInt32LE(localOffset, 42)
    name.copy(central, 46)
    centralExtra.copy(central, 46 + name.length)
    centralRecords.push(central)
    localOffset += local.length
  }

  const centralDirectory = Buffer.concat(centralRecords)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(declaredEntryCount, 8)
  eocd.writeUInt16LE(declaredEntryCount, 10)
  eocd.writeUInt32LE(centralDirectory.length, 12)
  eocd.writeUInt32LE(localOffset, 16)
  return Buffer.concat([...localRecords, centralDirectory, eocd])
}
