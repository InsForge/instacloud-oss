import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Dev proxies the API prefixes to a running instad; production is same-origin (instad serves dist).
// Mirrors src/server.ts API_PREFIXES so a dev browser hitting /templates gets JSON as on the cloud
// (the SPA's gallery lives under /p/.../templates). The cookie flow works through the proxy because
// it is the same host and the daemon marks the cookie Secure only over https.
const API_PREFIXES = [
  '/projects', '/orgs', '/me', '/tokens', '/healthz', '/regions',
  '/auth', '/api', '/templates', '/template-deployments',
]
const target = process.env.VITE_INSTA_API ?? 'http://127.0.0.1:8080'
// The dev server has no daemon shell to read the always-on default from. Set
// VITE_INSTA_ALWAYS_ON_DEFAULT=0 when the daemon above runs with INSTA_OSS_ALWAYS_ON_DEFAULT=0, so the
// add-service switch shows what the daemon will do; unset, it assumes the daemon's default (on).

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Explicit empty postcss config: stop Vite from crawling parent dirs for stray postcss configs.
  css: { postcss: { plugins: [] } },
  server: {
    proxy: Object.fromEntries(API_PREFIXES.map((p) => [p, { target, changeOrigin: true }])),
  },
})
