import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { inspectIosNativeMapSource } from './check-ios-native-map-source.mjs'

const root = resolve(import.meta.dirname, '../..')
const paths = {
  nativeMapSurface: 'frontend/src/components/TripMapSurface.native.tsx',
  nativeBridge: 'frontend/src/platform/nativeGoogleMapsBridge.ts',
  packageJson: 'frontend/package.json',
  swiftPackage: 'frontend/ios/App/CapApp-SPM/Package.swift',
  swiftResolved: 'frontend/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved',
  nativeProductionEnvironment: 'frontend/.env.native-production',
  nativeStagingEnvironment: 'frontend/.env.native-staging',
}

async function sources() {
  return Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([name, path]) => [name, await readFile(resolve(root, path), 'utf8')])))
}

test('accepts the iOS native Maps source contract', async () => {
  assert.deepEqual(inspectIosNativeMapSource(await sources()), [])
})

test('rejects renderer, bridge, dependency, and credential drift', async () => {
  const control = await sources()
  const mutated = {
    ...control,
    nativeMapSurface: control.nativeMapSurface.replaceAll('VITE_NATIVE_IOS_MAPS_API_KEY', 'VITE_GOOGLE_MAPS_API_KEY'),
    nativeBridge: control.nativeBridge.replace('capacitorGoogleMaps.destroy', 'capacitorGoogleMaps.dispose'),
    packageJson: control.packageJson.replace('"@capacitor/google-maps"', '"@capacitor/maps"'),
    nativeStagingEnvironment: `${control.nativeStagingEnvironment}\nVITE_NATIVE_IOS_MAPS_API_KEY=test-only-map-credential`,
  }
  const violations = inspectIosNativeMapSource(mutated)
  assert.ok(violations.some((entry) => /iOS SDK credential boundary/.test(entry)))
  assert.ok(violations.some((entry) => /browser Maps configuration/.test(entry)))
  assert.ok(violations.some((entry) => /destroy maps/.test(entry)))
  assert.ok(violations.some((entry) => /Capacitor Google Maps dependency/.test(entry)))
  assert.ok(violations.some((entry) => /must not commit an iOS Maps credential/.test(entry)))
})
