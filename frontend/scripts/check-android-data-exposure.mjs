import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function collectFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? collectFiles(path) : entry.isFile() ? [path] : []
  })
}

function broadPath(contents) {
  return /<(?:external-path|cache-path)\b[^>]*\bpath\s*=\s*(["'])(?:\.{1,2}\/?|\/?)\1/i.test(contents)
}

export function inspectAndroidDataExposure(androidAppDirectory) {
  const appDirectory = resolve(androidAppDirectory)
  const sourceSetsDirectory = join(appDirectory, 'src')
  const manifestPath = join(sourceSetsDirectory, 'main', 'AndroidManifest.xml')
  const violations = []

  if (!existsSync(manifestPath)) return [`Android manifest is missing: ${manifestPath}`]

  const manifest = readFileSync(manifestPath, 'utf8')
  const application = manifest.match(/<application\b[^>]*>/i)?.[0]
  const allowBackup = [...(application?.matchAll(/\bandroid:allowBackup\s*=\s*(["'])([^"']*)\1/gi) ?? [])]
  if (allowBackup.length !== 1) violations.push('Android application must declare exactly one android:allowBackup="false" attribute')
  if (allowBackup.length === 1 && allowBackup[0][2].toLowerCase() !== 'false') {
    violations.push('Android application must set android:allowBackup="false"')
  }
  for (const path of collectFiles(sourceSetsDirectory)) {
    const contents = readFileSync(path, 'utf8')
    if (/androidx\.core\.content\.FileProvider/i.test(contents)) {
      violations.push(`Android source must not declare androidx.core.content.FileProvider without a reviewed scoped sharing design: ${path.slice(appDirectory.length + 1)}`)
    }
    if (basename(path) === 'file_paths.xml') violations.push(`Android source must not include ${path.slice(appDirectory.length + 1)}`)
    if (broadPath(contents)) violations.push(`Android source must not expose a broad external-path or cache-path: ${path.slice(appDirectory.length + 1)}`)
  }

  return violations
}

export function assertAndroidDataExposurePolicy(androidAppDirectory) {
  const violations = inspectAndroidDataExposure(androidAppDirectory)
  if (violations.length > 0) throw new Error(`Android data-exposure policy failed:\n${violations.join('\n')}`)
}

const invokedPath = process.argv[1] && resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  const appDirectory = resolve(process.cwd(), process.argv[2] ?? 'android/app')
  assertAndroidDataExposurePolicy(appDirectory)
  console.log('PASS Android data-exposure policy')
}
