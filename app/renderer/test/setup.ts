import '@testing-library/jest-dom/vitest'
import { afterEach } from 'vitest'

// Only wire DOM cleanup in a browser-like (jsdom) environment; node-env tests
// (cli/main) have no document and must not import RTL's DOM cleanup — nor the
// renderer hook graph (usePolled → ipc touches `window` at load).
if (typeof document !== 'undefined') {
  const { cleanup } = await import('@testing-library/react')
  // The usePolled memo is module-level and persists across renders; clear it
  // between tests so a cached result from one test never seeds another.
  const { __resetPolledMemo } = await import('../hooks/usePolled')
  afterEach(() => { cleanup(); __resetPolledMemo() })
}
