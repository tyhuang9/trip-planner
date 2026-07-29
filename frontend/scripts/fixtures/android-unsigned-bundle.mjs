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

export function archiveDetails(entries = requiredEntries, types = {}) {
  const records = entries.map((entry) => {
    const type = types[entry] ?? (entry.endsWith('/') ? 'd' : '-')
    return `${type}rw-r--r--  3.0 unx        1 bx        1 stor 26-Jan-01 00:00 ${entry}`
  })
  return `Archive: fixture.aab\n${records.join('\n')}\n${entries.length} files, 0 bytes uncompressed, 0 bytes compressed:  0.0%\n`
}
