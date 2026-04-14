import fs from 'fs'
import os from 'os'
import path from 'path'

const CONFIG_PATH = path.join(os.homedir(), '.codeburnrc')

export function loadConfig(): { currency?: string } {
  try {
    const data = fs.readFileSync(CONFIG_PATH, 'utf-8')
    return JSON.parse(data)
  } catch {
    return {}
  }
}

export function saveConfig(config: { currency?: string }) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
}
