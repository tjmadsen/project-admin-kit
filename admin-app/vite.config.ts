/// <reference types="vitest" />
import { allowedNodeEnvironmentFlags } from 'node:process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import projectConfig from '../project-admin.config.json'

// Let jsdom provide browser storage instead of Node's experimental global,
// which has no working Storage methods without a --localstorage-file path.
const testExecArgv = allowedNodeEnvironmentFlags.has('--no-experimental-webstorage')
  ? ['--no-experimental-webstorage']
  : []

export default defineConfig({
  base: `${projectConfig.project.adminPath.replace(/\/$/, '')}/`,
  plugins: [react()],
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
    poolOptions: {
      forks: { execArgv: testExecArgv },
      threads: { execArgv: testExecArgv },
    },
    globals: true,
    setupFiles: './src/test/setup.ts',
  },
})
