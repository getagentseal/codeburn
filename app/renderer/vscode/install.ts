import { installBridge } from './bridge'

// A module of its own so it evaluates before any renderer module that reads
// `window.codeburn` at load (lib/ipc.ts): entries import it first.
export const { boot, api } = installBridge(window as Parameters<typeof installBridge>[0])
