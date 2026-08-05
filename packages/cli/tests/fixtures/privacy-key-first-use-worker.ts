import { existsSync } from 'fs'
import { writeFile } from 'fs/promises'

import { getPersistedHostPrivacyKey } from '../../src/privacy-key.js'
import { deriveDeviceId } from '../../src/sync/otlp.js'

const [goFile, readyFile] = process.argv.slice(2)
if (!goFile || !readyFile) throw new Error('missing GO_FILE/READY_FILE argument')

// Signal the parent that we are booted and spinning on the start barrier, so
// it only releases the race once BOTH processes are waiting.
await writeFile(readyFile, '')
// Busy spin (no sleep): a sleep would let one child complete its whole
// create+write before the other wakes, serializing the race instead of firing
// it. Both children observe the go file within microseconds of each other and
// attempt their first use in lockstep.
while (!existsSync(goFile)) {}

const key = getPersistedHostPrivacyKey()
const deviceId = deriveDeviceId(key, 'race-host', 'race-user')
process.stdout.write(JSON.stringify({ key, deviceId }) + '\n')
