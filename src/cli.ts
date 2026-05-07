import { assertSupportedNodeVersion } from './node-runtime.js'

assertSupportedNodeVersion()

await import(new URL('./main.js', import.meta.url).href)
