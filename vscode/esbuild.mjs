import { build } from 'esbuild'

// The extension host bundle: this package's sources plus the desktop's shared
// CLI client, bridge handlers, quota readers and the renderer's formatting and
// text catalogs, so there is one implementation of each.
await build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  define: { 'process.env.NODE_ENV': '"production"' },
  sourcemap: true,
  minify: true,
  logLevel: 'info',
})
