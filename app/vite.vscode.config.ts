import { resolve } from 'node:path'

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The renderer built for the VS Code extension's webviews: two entries (the
// dashboard and the activity bar summary) with fixed names, so the extension
// host can point a strict CSP at them through asWebviewUri.
export default defineConfig({
  root: 'renderer',
  base: './',
  // renderer/public holds only the browser demo shim, which the extension never loads.
  publicDir: false,
  plugins: [react()],
  define: {
    __BUILD_SHA__: JSON.stringify('vscode'),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
  },
  build: {
    outDir: resolve(__dirname, '../vscode/dist/webview'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        dashboard: resolve(__dirname, 'renderer/vscode/dashboard.tsx'),
        sidebar: resolve(__dirname, 'renderer/vscode/sidebar.tsx'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name]-[hash].js',
        assetFileNames: asset => (asset.names?.some(name => name.endsWith('.css')) ? '[name][extname]' : 'assets/[name]-[hash][extname]'),
      },
    },
  },
})
