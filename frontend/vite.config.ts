/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { VitePWA } from 'vite-plugin-pwa'
import {
  resolveBuildProfile,
  validateBuildConfiguration,
} from './src/platform/buildProfile'
import { assertNativeBundlePolicy } from './scripts/check-native-bundle-policy.mjs'
import { assertPwaBundlePolicy } from './scripts/check-pwa-bundle-policy.mjs'
import { WEB_APP_MANIFEST } from './src/pwa/manifest'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const profile = resolveBuildProfile(mode)
  const env = loadEnv(mode, process.cwd(), 'VITE_')
  const backendBaseUrl = mode === 'test' ? '' : validateBuildConfiguration(profile, {
    backendBaseUrl: env.VITE_BACKEND_API_URL,
    browserMapsApiKey: env.VITE_GOOGLE_MAPS_API_KEY,
    appAccessPassword: env.VITE_APP_ACCESS_PASSWORD,
  })
  const source = (path: string) => fileURLToPath(new URL(path, import.meta.url))
  const webPwaPlugin = profile.target === 'web'
    ? VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src/pwa',
        filename: 'service-worker.ts',
        injectRegister: false,
        registerType: 'prompt',
        integration: {
          closeBundleOrder: 'pre',
        },
        includeAssets: ['offline.html'],
        manifest: WEB_APP_MANIFEST,
        injectManifest: {
          // Only Vite's content-hashed static assets are discovered here.
          // The plugin adds the revisioned offline shell, manifest, and icons.
          globPatterns: ['assets/**/*.{js,css,png,svg,webp,woff2}'],
        },
      })
    : undefined
  const webPwaPolicyPlugin = profile.target === 'web'
    ? {
        name: 'dupert-pwa-bundle-policy',
        closeBundle: {
          order: 'post' as const,
          sequential: true,
          handler() {
            assertPwaBundlePolicy(source('./dist'))
          },
        },
      }
    : undefined
  const nativeBundlePolicyPlugin = profile.target === 'native'
    ? {
        name: 'dupert-native-bundle-policy',
        closeBundle() {
          // Scan with the values Vite actually loaded from .env files or CI.
          // The inspector reports only the affected files/variable names, never
          // public configuration values themselves.
          assertNativeBundlePolicy(source('./dist'), {
            VITE_GOOGLE_MAPS_API_KEY: env.VITE_GOOGLE_MAPS_API_KEY,
            VITE_APP_ACCESS_PASSWORD: env.VITE_APP_ACCESS_PASSWORD,
          })
        },
      }
    : undefined

  return {
    plugins: [
      react(),
      babel({ presets: [reactCompilerPreset()] }),
      ...(webPwaPlugin ? [webPwaPlugin] : []),
      ...(webPwaPolicyPlugin ? [webPwaPolicyPlugin] : []),
      ...(nativeBundlePolicyPlugin ? [nativeBundlePolicyPlugin] : []),
    ],
    define: {
      __DUPERT_BUILD_TARGET__: JSON.stringify(profile.target),
      __DUPERT_DEPLOYMENT_ENVIRONMENT__: JSON.stringify(profile.environment),
      __DUPERT_BACKEND_BASE_URL__: JSON.stringify(backendBaseUrl),
    },
    resolve: {
      alias: {
        '@dupert/platform-integrations': source(`./src/platform/PlatformIntegrations.${profile.target}.tsx`),
        '@dupert/trip-map-surface': source(`./src/components/TripMapSurface.${profile.target}.tsx`),
      },
    },
    build: {
      manifest: true,
    },
    // Browser-only public assets, including PWA metadata, must never enter a
    // Capacitor bundle. Imported application assets still build normally.
    publicDir: profile.target === 'web' ? 'public' : false,
    server: {
      port: 3000,
      strictPort: true,
      proxy: {
        // Same-origin API proxy during web development only. Native profiles
        // validate an explicit absolute backend URL at config-load time.
        '/api': {
          target: 'http://localhost:8000',
          changeOrigin: false,
          secure: false,
        },
        '/actuator': {
          target: 'http://localhost:8000',
          changeOrigin: false,
          secure: false,
        },
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      css: false,
    },
  }
})
