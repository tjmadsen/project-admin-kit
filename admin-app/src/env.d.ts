/// <reference types="vite/client" />

/** project-admin.config.json `backend.type`, fixed at build time (vite.config.ts). */
declare const __PA_BACKEND__: 'firestore' | 'local' | 'github'
