import { posix, win32 } from 'node:path'

/** Default Electron editor data directory, honoring the OS's redirected root. */
export function getEditorDataDir(editor: string, home: string, os: string): string {
  if (os === 'darwin') return posix.join(home, 'Library', 'Application Support', editor)
  if (os === 'win32') {
    return win32.join(process.env['APPDATA'] || win32.join(home, 'AppData', 'Roaming'), editor)
  }
  return posix.join(process.env['XDG_CONFIG_HOME'] || posix.join(home, '.config'), editor)
}
