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
  },
})
