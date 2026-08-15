import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { inspectPwaBundle } from './check-pwa-bundle-policy.mjs'

const POLICY_MARKER = 'static-precache;navigation-network-only;runtime-cache-none'

function pngHeader(size) {
  const image = Buffer.alloc(24)
  image.set(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  image.writeUInt32BE(size, 16)
  image.writeUInt32BE(size, 20)
  return image
}

async function createPwaBundle(overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'dupert-pwa-bundle-'))
  await mkdir(join(directory, 'assets'))
  await mkdir(join(directory, 'pwa'))
  const files = {
    'index.html': '<link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#3f5f53"><meta name="viewport" content="width=device-width,viewport-fit=cover"><link rel="apple-touch-icon" href="/pwa/icon-192.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Dupert">',
    'manifest.webmanifest': JSON.stringify({
      name: 'Dupert Trip Planner',
      short_name: 'Dupert',
      id: '/',
      start_url: '/',
      scope: '/',
      display: 'standalone',
      background_color: '#f6f5f2',
      theme_color: '#3f5f53',
      icons: [
        { src: '/pwa/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: '/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
    }),
    'offline.html': '<meta name="viewport" content="viewport-fit=cover"><main data-dupert-offline-shell>Dupert does not store private trip data.</main>',
    'service-worker.js': `const OFFLINE="/offline.html";self.__DUPERT_PWA_POLICY__="${POLICY_MARKER}";registerRoute(new NavigationRoute(async options=>{try{return await fetch(options.request)}catch{return await matchPrecache(OFFLINE)??Response.error()}}));precacheAndRoute([{url:"assets/app-abc123.js"},{url:"offline.html"},{url:"manifest.webmanifest"},{url:"pwa/icon-192.png"},{url:"pwa/icon-512.png"}]);`,
    'assets/app-abc123.js': 'const target = "web";',
    'pwa/icon-192.png': pngHeader(192),
    'pwa/icon-512.png': pngHeader(512),
    ...overrides,
  }
  await Promise.all(Object.entries(files).map(async ([relativePath, contents]) => {
    await writeFile(join(directory, relativePath), contents)
  }))
  return directory
}

test('accepts an installable static-only PWA bundle', async (t) => {
  const directory = await createPwaBundle()
  t.after(() => rm(directory, { force: true, recursive: true }))

  assert.deepEqual(inspectPwaBundle(directory), [])
})

test('rejects private API precaching and runtime caching strategies', async (t) => {
  const directory = await createPwaBundle({
    'service-worker.js': `self.__DUPERT_PWA_POLICY__="${POLICY_MARKER}";new NetworkFirst();precacheAndRoute([{url:"offline.html"},{url:"manifest.webmanifest"},{url:"pwa/icon-192.png"},{url:"pwa/icon-512.png"},{url:"api/auth/stream"}]);`,
  })
  t.after(() => rm(directory, { force: true, recursive: true }))

  const violations = inspectPwaBundle(directory)
  assert.ok(violations.some(({ message }) => message === 'runtime cache strategy code is present'))
  assert.ok(violations.some(({ message }) => message.includes('api/auth/stream')))
})

test('rejects a navigation handler that caches or falls back to private data', async (t) => {
  const directory = await createPwaBundle({
    'service-worker.js': `const OFFLINE="/offline.html";self.__DUPERT_PWA_POLICY__="${POLICY_MARKER}";registerRoute(new NavigationRoute(async options=>{try{return await fetch(options.request)}catch{return await caches.match("/api/trips")??Response.error()}}));precacheAndRoute([{url:"offline.html"},{url:"manifest.webmanifest"},{url:"pwa/icon-192.png"},{url:"pwa/icon-512.png"}]);`,
  })
  t.after(() => rm(directory, { force: true, recursive: true }))

  const violations = inspectPwaBundle(directory)
  assert.ok(violations.some(({ message }) => message === 'failed navigations must use network first and fall back only to /offline.html'))
})

test('rejects incomplete installability and iOS metadata', async (t) => {
  const directory = await createPwaBundle({
    'index.html': '<meta name="viewport" content="width=device-width">',
    'manifest.webmanifest': JSON.stringify({
      name: 'Dupert',
      short_name: 'Dupert',
      start_url: '/login',
      display: 'browser',
      icons: [],
    }),
  })
  t.after(() => rm(directory, { force: true, recursive: true }))

  const violations = inspectPwaBundle(directory)
  assert.ok(violations.some(({ message }) => message.includes('start_url')))
  assert.ok(violations.some(({ message }) => message.includes('192x192')))
  assert.ok(violations.some(({ message }) => message === 'Apple touch icon metadata is missing'))
  assert.ok(violations.some(({ message }) => message === 'safe-area viewport metadata is missing'))
})
