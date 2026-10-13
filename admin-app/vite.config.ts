/// <reference types="vitest" />
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// PROJECT_ADMIN_CONFIG builds the console for another config file (the same
// override the Node tools honour); src/lib/project-config.ts follows it via
// the alias below.
const here = path.dirname(fileURLToPath(import.meta.url))
const configPath = process.env.PROJECT_ADMIN_CONFIG ? path.resolve(process.env.PROJECT_ADMIN_CONFIG) : path.resolve(here, '../project-admin.config.json')
const projectConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'))
// The store the console talks to (docs/BACKENDS.md), fixed at build time so
// the unused adapter, and the Firebase SDK for non-firestore builds, is dropped.
const backend = projectConfig.backend?.type ?? 'firestore'
if (!['firestore', 'local', 'github'].includes(backend)) throw new Error(`Unknown backend.type "${backend}" in ${configPath}`)

export default defineConfig({
  base: `${projectConfig.project.adminPath.replace(/\/$/, '')}/`,
  plugins: [react()],
  define: { __PA_BACKEND__: JSON.stringify(backend) },
  resolve: process.env.PROJECT_ADMIN_CONFIG
    ? { alias: [{ find: /^(\.\.\/)+project-admin\.config\.json$/, replacement: configPath }] }
    : undefined,
  build: {
    outDir: `../public${projectConfig.project.adminPath}`,
    emptyOutDir: true,
    sourcemap: false,
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/firebase') || id.includes('node_modules/@firebase')) return 'firebase'
          if (id.includes('node_modules/react')) return 'react'
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './src/test/setup.ts',
  },
})
