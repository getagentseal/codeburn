// Child-process probe for tests/user-timing-guard.test.tsx.
//
// Renders a ticking Ink component into a throwaway stream for a while and
// reports how many user-timing entries React left in Node's buffer. It has to
// run in a plain Node process: vitest swaps `console` for one without
// `timeStamp`, and React's development build only records its performance
// tracks when `console.timeStamp` and `performance.measure` both exist at
// module load - which is exactly the case in the shipped CLI.
//
//   argv[2]  'guard' to run startUserTimingGuard(10) for the duration
//   argv[3]  how long to keep rendering, in ms (default 500)
//
// Prints one JSON line: { nodeEnv, renders, entriesWhileRunning, entriesAfterStop }.
import { PassThrough } from 'node:stream'

import React, { useEffect, useState } from 'react'
import { render, Text } from 'ink'

import { startUserTimingGuard, userTimingEntryCount } from '../../src/user-timing-guard.js'

const useGuard = process.argv[2] === 'guard'
const durationMs = Number(process.argv[3] ?? 500)
let renders = 0

function Ticker() {
  const [n, setN] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setN(v => v + 1), 2)
    return () => clearInterval(id)
  }, [])
  renders++
  return <Text>tick {n}</Text>
}

const stdout = Object.assign(new PassThrough(), { columns: 80, rows: 24 })
stdout.resume()
const stop = useGuard ? startUserTimingGuard(10) : () => {}
const app = render(<Ticker />, { stdout: stdout as unknown as NodeJS.WriteStream, patchConsole: false })
await new Promise<void>(resolve => setTimeout(resolve, durationMs))
app.unmount()
const entriesWhileRunning = userTimingEntryCount()
stop()
const entriesAfterStop = userTimingEntryCount()
process.stdout.write(JSON.stringify({ nodeEnv: process.env.NODE_ENV ?? null, renders, entriesWhileRunning, entriesAfterStop }) + '\n')
