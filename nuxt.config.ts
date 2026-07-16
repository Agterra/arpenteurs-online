import { readFileSync } from 'node:fs'

// App version = package.json "version", baked at build time so the deployed
// bundle always self-reports the code it was built from.
const pkgVersion = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf-8'),
).version as string

export default defineNuxtConfig({
  compatibilityDate: '2026-07-01',
  modules: ['@pinia/nuxt', '@nuxt/ui'],
  css: ['~/assets/css/main.css'],
  devtools: { enabled: true },
  nitro: {
    experimental: { websocket: true },
  },
  runtimeConfig: {
    // Overridable via NUXT_* env vars
    databaseUrl: '',
    // Exact public origin used to validate WebSocket upgrade Origin headers (CSWSH defense)
    publicOrigin: 'http://localhost:3000',
    adminToken: '',
    scryfallUserAgent: 'arpenteurs/0.1 (louis@gravyr.fr)',
    public: {
      // Semantic app version from package.json (build-time).
      version: pkgVersion,
      // Deploy identifier — git short sha / image tag. Baked at docker build via
      // NUXT_PUBLIC_BUILD_TAG, and overridable at container runtime (Nuxt reads
      // NUXT_PUBLIC_* at server start and propagates to the client via payload).
      buildTag: 'dev',
    },
  },
})
