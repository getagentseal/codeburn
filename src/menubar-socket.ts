import { connect } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SOCKET_PATH = join(homedir(), '.cache', 'codeburn', 'menubar.sock')

export function notifyMenubar(): void {
  const sock = connect(SOCKET_PATH)
  sock.on('error', () => {})
  sock.write('refresh\n')
  sock.end()
}
