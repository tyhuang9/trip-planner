export const validBadging = `package: name='io.github.tyhuang9.dupert' versionCode='1' versionName='1.0'
sdkVersion:'24'
targetSdkVersion:'36'`

export const packagedEntries = [
  'assets/public/index.html',
]

export const alignedLoad = '  LOAD off    0x000000 vaddr 0x000000 paddr 0x000000 align 2**14'

export const emptyZip = Buffer.from('504b0506000000000000000000000000000000000000', 'hex')

export function signingBlockZip({ headerSize = 24n, footerSize = 24n } = {}) {
  const block = Buffer.alloc(32)
  block.writeBigUInt64LE(headerSize, 0)
  block.writeBigUInt64LE(footerSize, 8)
  block.write('APK Sig Block 42', 16, 'ascii')
  const eocd = Buffer.from(emptyZip)
  eocd.writeUInt32LE(block.length, 16)
  return Buffer.concat([block, eocd])
}
