/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
  ],
  build: {
    manifest: true,
  },
  server: {
    port: 3000,
    strictPort: true,
    proxy: {
      // Same-origin API proxy during dev: frontend code can call `/api/...`
      // without worrying about CORS, and the Spring Boot backend on :8000 gets
      // the request verbatim.
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
})
