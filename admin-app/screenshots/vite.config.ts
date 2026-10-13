// Vite config for the screenshot harness. It serves screenshots/harness.html
// and swaps the Firebase module plus the data hooks for fixture-backed mocks,
// so the real pages and stylesheet render without a signed-in session.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const here = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(here, '..')

export default defineConfig({
  root: here,
  base: '/',
  plugins: [react()],
  // The harness renders the firestore console against fixture-backed mocks.
  define: { __PA_BACKEND__: JSON.stringify('firestore') },
  logLevel: 'warn',
  resolve: {
    alias: [
      { find: /^(\.\.?\/)+(lib\/)?firebase$/, replacement: path.join(here, 'mocks/firebase.ts') },
      { find: /^(\.\.?\/)+hooks\/useCollection$/, replacement: path.join(here, 'mocks/useCollection.ts') },
      { find: /^(\.\.?\/)+hooks\/useLoopData$/, replacement: path.join(here, 'mocks/useLoopData.ts') },
    ],
  },
  server: { host: '127.0.0.1', fs: { allow: [appRoot] } },
})
