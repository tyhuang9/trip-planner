import type { ManifestOptions } from 'vite-plugin-pwa'

export const WEB_APP_MANIFEST = {
  id: '/',
  name: 'Dupert Trip Planner',
  short_name: 'Dupert',
  description: 'Plan trips, organize activities, and collaborate with your travel group.',
  lang: 'en-US',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#f6f5f2',
  theme_color: '#3f5f53',
  categories: ['travel', 'productivity'],
  icons: [
    {
      src: '/pwa/icon-192.png',
      sizes: '192x192',
      type: 'image/png',
      purpose: 'any maskable',
    },
    {
      src: '/pwa/icon-512.png',
      sizes: '512x512',
      type: 'image/png',
      purpose: 'any maskable',
    },
  ],
} satisfies Partial<ManifestOptions>
