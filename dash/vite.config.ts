import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

// base './' so the built assets load with relative URLs when the CLI serves
// dist/dash from the local server root. Built output goes straight into the
// package's dist/dash so `codeburn web` can serve it after `npm run build`.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: '../dist/dash',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // During frontend dev, run `codeburn web` (CLI api on 4747) and `npm run dev`
    // here; this proxies the data calls to the CLI.
    proxy: { '/api': 'http://127.0.0.1:4747' },
  },
})
