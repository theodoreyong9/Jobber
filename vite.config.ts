import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  // Served at https://theodoreyong9.github.io/Jobber/ (project Pages site),
  // so all asset URLs must be prefixed with the repo name.
  base: '/Jobber/',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icons/icon-192.png', 'icons/icon-512.png'],
      manifest: {
        name: 'Jobber — tailor your CV',
        short_name: 'Jobber',
        description: 'Adapt your CV to any job offer, privately, with no account and no cloud.',
        theme_color: '#0f1115',
        background_color: '#0f1115',
        display: 'standalone',
        start_url: '/Jobber/',
        scope: '/Jobber/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // WebLLM model shards are fetched from an external CDN and cached by
        // WebLLM's own cache (navigator.caches) — not duplicated here.
        globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        maximumFileSizeToCacheInBytes: 10 * 1024 * 1024,
      },
    }),
  ],
  worker: {
    format: 'es',
  },
})
