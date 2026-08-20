import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const REQUIRED_SOURCE = {
  nativeMapSurface: 'frontend/src/components/TripMapSurface.native.tsx',
  nativeBridge: 'frontend/src/platform/nativeGoogleMapsBridge.ts',
  packageJson: 'frontend/package.json',
  swiftPackage: 'frontend/ios/App/CapApp-SPM/Package.swift',
  swiftResolved: 'frontend/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
  nativeProductionEnvironment: 'frontend/.env.native-production',
  nativeStagingEnvironment: 'frontend/.env.native-staging',
}

function sourceText(path) {
  return readFileSync(resolve(ROOT, path), 'utf8')
}

function requireText(text, pattern, label, violations) {
  if (!pattern.test(text)) violations.push(label)
}

export function inspectIosNativeMapSource(sources = Object.fromEntries(
  Object.entries(REQUIRED_SOURCE).map(([name, path]) => [name, sourceText(path)]),
)) {
  const violations = []
  const surface = sources.nativeMapSurface ?? ''
  const bridge = sources.nativeBridge ?? ''
  const packageJson = sources.packageJson ?? ''
  const swiftPackage = sources.swiftPackage ?? ''
  const swiftResolved = sources.swiftResolved ?? ''

  requireText(surface, /NativeGoogleMap\.create\(/, 'native map surface must create through NativeGoogleMap', violations)
  requireText(surface, /VITE_NATIVE_IOS_MAPS_API_KEY/, 'native map surface must use the iOS SDK credential boundary', violations)
  requireText(surface, /Native Google Maps could not start/, 'native map surface must expose an understandable startup failure state', violations)
  if (/VITE_GOOGLE_MAPS_API_KEY|@vis\.gl\/react-google-maps/.test(surface)) {
    violations.push('native map surface must not include browser Maps configuration or renderer')
  }
  requireText(bridge, /registerPlugin<NativeGoogleMapsPlugin>\('CapacitorGoogleMaps'\)/, 'native bridge must use the Capacitor Google Maps plugin', violations)
  requireText(bridge, /capacitorGoogleMaps\.destroy\(/, 'native bridge must destroy maps', violations)
  requireText(bridge, /ResizeObserver/, 'native bridge must observe native map bounds', violations)
  requireText(bridge, /onDisplay/, 'native bridge must restore an iOS map after display', violations)
  requireText(bridge, /dispatchMapEvent/, 'native bridge must route focus events', violations)
  requireText(packageJson, /"@capacitor\/google-maps"\s*:/, 'package manifest must include the Capacitor Google Maps dependency', violations)
  requireText(swiftPackage, /CapacitorGoogleMaps/, 'iOS Swift package must include the Capacitor Google Maps product', violations)
  requireText(swiftResolved, /googlemaps\/ios-maps-sdk\.git/, 'iOS Swift resolution must include Google Maps SDK', violations)
  for (const [name, text] of Object.entries({
    nativeProductionEnvironment: sources.nativeProductionEnvironment ?? '',
    nativeStagingEnvironment: sources.nativeStagingEnvironment ?? '',
  })) {
    if (/^VITE_NATIVE_IOS_MAPS_API_KEY\s*=\s*\S+/m.test(text)) {
      violations.push(`${name} must not commit an iOS Maps credential`)
    }
  }
  return violations
}

export function assertIosNativeMapSource(sources) {
  const violations = inspectIosNativeMapSource(sources)
  if (violations.length > 0) throw new Error(`iOS native Maps source contract failed:\n${violations.join('\n')}`)
}

const invokedPath = process.argv[1] && resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  assertIosNativeMapSource()
  console.log('PASS iOS native Maps source contract (physical-device qualification remains blocked)')
}
