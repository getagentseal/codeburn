/**
 * codeburn plugin — CLI commands for the plugin socket (teams issue #3).
 *
 * Registers: plugin list | info <name> | verify <name>
 *
 * The socket is the user-facing escape hatch: when a plugin is silently
 * rejected (bad manifest, name/dir mismatch, CLI version out of range,
 * unsigned without CODEBURN_PLUGIN_DEV=1), `codeburn plugin list` prints
 * the reason. There is no on-the-wire behavior here — this is a read-only
 * inspector for the manifest layer.
 */

import type { Command } from 'commander'
import { stat, mkdir, readFile, writeFile, rm, readdir, copyFile, mkdtemp } from 'fs/promises'
import { join } from 'path'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { tmpdir } from 'os'

import { defaultPluginsDir, loadPlugins, currentCliVersion, verifyPlugin, readPluginManifestRaw, type PluginLoad } from './loader.js'
import { parsePluginManifest, PLUGIN_NAME, type PluginManifest } from './manifest.js'
import { readSyncConfig } from '../sync/config.js'
import { createCredentialStore } from '../sync/credentials.js'
import { fetchOidcConfig, refreshToken } from '../sync/auth.js'

export function registerPluginCommands(program: Command): void {
  const plugin = program
    .command('plugin')
    .description('Inspect the plugin socket: list, info, verify (no installation; see docs/sync/README.md for `codeburn plugin add`)')

  plugin
    .command('list')
    .description('List every plugin the loader found, with status (loaded | rejected) and reason for rejections')
    .option('--dir <path>', 'Override the plugins directory (defaults to ~/.config/codeburn/plugins)')
    .option('--json', 'Output as machine-readable JSON')
    .action(async (opts: { dir?: string; json?: boolean }) => {
      const loads = await loadPlugins(opts.dir)

      if (opts.json) {
        const result = loads.map(load => {
          if (load.status === 'loaded') {
            const m = load.manifest
            return {
              name: m.name,
              version: m.version,
              status: 'loaded' as const,
              capabilities: {
                commands: m.capabilities.commands,
                syncAttributes: m.capabilities.syncAttributes,
                payloadSections: m.capabilities.payloadSections,
                spanKinds: m.capabilities.spanKinds,
              }
            }
          } else {
            return {
              name: load.name,
              status: 'rejected' as const,
              reason: load.reason,
            }
          }
        })
        process.stdout.write(JSON.stringify(result, null, 0) + '\n')
        return
      }

      if (loads.length === 0) {
        process.stdout.write(`No plugins found in ${opts.dir ?? defaultPluginsDir()}.\n`)
        return
      }
      for (const load of loads) {
        if (load.status === 'loaded') {
          const m = load.manifest
          const caps: string[] = []
          if (m.capabilities.commands.length > 0) caps.push(`commands=${m.capabilities.commands.length}`)
          if (m.capabilities.syncAttributes.length > 0) caps.push(`syncAttrs=${m.capabilities.syncAttributes.length}`)
          if (m.capabilities.payloadSections.length > 0) caps.push(`sections=${m.capabilities.payloadSections.length}`)
          process.stdout.write(`loaded   ${m.name}@${m.version}  (${caps.join(', ')})\n`)
        } else {
          process.stdout.write(`rejected ${load.name}  ${load.reason}\n`)
        }
      }
    })

  plugin
    .command('info <name>')
    .description('Print the full manifest of a loaded plugin plus on-disk payload sections')
    .option('--dir <path>', 'Override the plugins directory')
    .option('--json', 'Output as machine-readable JSON')
    .action(async (name: string, opts: { dir?: string; json?: boolean }) => {
      if (!PLUGIN_NAME.test(name)) return rejectName(name)
      const loads = await loadPlugins(opts.dir)
      const loaded = loads.find((l): l is Extract<typeof l, { status: 'loaded' }> => l.status === 'loaded' && l.manifest.name === name)
      if (loaded) {
        const m = loaded.manifest
        const sections = await listOnDiskSections(loaded.dir, m)
        if (opts.json) {
          const result = {
            ...m,
            dir: loaded.dir,
            onDiskSections: sections,
          }
          process.stdout.write(JSON.stringify(result, null, 0) + '\n')
          return
        }
        process.stdout.write(JSON.stringify(m, null, 2) + '\n')
        if (sections.length > 0) {
          process.stdout.write(`\non-disk payload sections: ${sections.join(', ')}\n`)
        } else {
          process.stdout.write(`\nno on-disk payload sections yet (plugin has not written any).\n`)
        }
        return
      }
      const rejected = loads.find((l): l is Extract<typeof l, { status: 'rejected' }> => l.status === 'rejected' && l.name === name)
      if (rejected) {
        process.stderr.write(`Error: Plugin "${name}" is not loaded: ${rejected.reason}\n`)
        process.exitCode = 1
        return
      }
      process.stderr.write(`Error: Plugin "${name}" not found in ${opts.dir ?? defaultPluginsDir()}.\n`)
      process.exitCode = 1
      return
    })

  plugin
    .command('verify <name>')
    .description('Re-run the verification hook for a named plugin and print the result (release-key signing lands in 9b)')
    .option('--dir <path>', 'Override the plugins directory')
    .action(async (name: string, opts: { dir?: string }) => {
      if (!PLUGIN_NAME.test(name)) return rejectName(name)
      const dir = join(opts.dir ?? defaultPluginsDir(), name)
      const manifest = await readManifestForVerify(dir, name)
      if (!manifest) {
        process.stderr.write(`Error: Plugin "${name}" could not be loaded for verify.\n`)
        process.exitCode = 1
        return
      }
      const result = await verifyPlugin(dir, manifest, process.env)
      if (result.ok) {
        process.stdout.write(`verified  ${name}@${manifest.version}\n`)
      } else {
        process.stderr.write(`Error: unverified  ${name}@${manifest.version}  ${result.reason ?? 'verification failed'}\n`)
        process.exitCode = 1
        return
      }
    })

  plugin
    .command('add <source>')
    .description('Install a plugin from a local path or the org receiver')
    .option('--dir <path>', 'Override the plugins directory')
    .action(async (source: string, opts: { dir?: string }) => {
      const pluginsDir = opts.dir ?? defaultPluginsDir()

      try {
        // Dispatch: if source looks like a path or exists as directory, use local flow; otherwise remote
        const isLocal = source.includes('/') || source.includes('.') ||
          (await stat(source).then(() => true).catch(() => false))

        if (isLocal) {
          await addLocal(source, pluginsDir)
        } else {
          // Validate plugin name
          if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(source)) {
            throw new Error(`Invalid plugin name "${source}". Must match [a-z0-9]([a-z0-9-]*[a-z0-9])?`)
          }
          await addRemote(source, pluginsDir)
        }
      } catch (err) {
        process.stderr.write(`Error: ${(err as Error).message}\n`)
        process.exitCode = 1
        return
      }
    })

  plugin
    .command('remove <name>')
    .description('Remove an installed plugin')
    .option('--dir <path>', 'Override the plugins directory')
    .option('--confirm', 'Confirm removal')
    .action(async (name: string, opts: { dir?: string, confirm?: boolean }) => {
      if (!PLUGIN_NAME.test(name)) return rejectName(name)
      const pluginsDir = opts.dir ?? defaultPluginsDir()
      const destDir = join(pluginsDir, name)
      if (!opts.confirm) {
        process.stderr.write(`Error: Use --confirm to proceed with removal of ${destDir}\n`)
        process.exitCode = 1
        return
      }
      await rm(destDir, { recursive: true, force: true })
      process.stdout.write(`Plugin "${name}" removed.\n`)
    })
}

function rejectName(name: string): void {
  process.stderr.write(`Error: Invalid plugin name "${name}".\n`)
  process.exitCode = 1
}

/// Reads the manifest at <dir>/codeburn-plugin.json and parses it via the
/// same loader path (so a verify command reports the same shape list/info do).
async function readManifestForVerify(dir: string, name: string): Promise<PluginManifest | null> {
  const { raw, reason } = await readPluginManifestRaw(dir)
  if (reason) {
    process.stderr.write(`Plugin "${name}": ${reason}\n`)
    return null
  }
  const parsed = parsePluginManifest(raw, `${name}/codeburn-plugin.json`)
  if (!parsed.ok) {
    process.stderr.write(`Plugin "${name}": ${parsed.reason}\n`)
    return null
  }
  return parsed.manifest
}

async function listOnDiskSections(dir: string, m: PluginManifest): Promise<string[]> {
  const out: string[] = []
  for (const name of m.capabilities.payloadSections) {
    const file = join(dir, 'sections', `${name}.json`)
    try {
      const info = await stat(file)
      if (info.isFile() && info.size <= 256 * 1024) out.push(name)
    } catch { /* missing is fine, sections are optional */ }
  }
  return out
}

/// Verify and install a plugin from an extracted/verified root directory.
/// Both local and remote flows call this after prep.
async function verifyAndInstall(
  sourceDir: string,
  pluginsDir: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const { raw, reason } = await readPluginManifestRaw(sourceDir)
  if (reason) {
    throw new Error(`Could not read manifest from ${sourceDir}: ${reason}`)
  }
  const parsed = parsePluginManifest(raw, `${sourceDir}/codeburn-plugin.json`)
  if (!parsed.ok) {
    throw new Error(`Invalid manifest: ${parsed.reason}`)
  }
  const manifest = parsed.manifest
  const verified = await verifyPlugin(sourceDir, manifest, env)
  if (!verified.ok) {
    throw new Error(`Plugin verification failed: ${verified.reason ?? 'unknown reason'}`)
  }
  const destDir = join(pluginsDir, manifest.name)
  try {
    await stat(destDir)
    throw new Error(`Plugin "${manifest.name}" already installed at ${destDir}`)
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  await mkdir(destDir, { recursive: true })
  await copyPluginTree(sourceDir, destDir)
  process.stdout.write(`Plugin "${manifest.name}@${manifest.version}" installed to ${destDir}\n`)
  return destDir
}

/// Recursively copy plugin files from source to destination, excluding sections/
/// (sections/ is runtime-mutable plugin output and not copied on install).
async function copyPluginTree(sourceDir: string, destDir: string): Promise<void> {
  async function walk(src: string, dest: string) {
    const entries = await readdir(src, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      // Exclude sections directory (runtime-mutable plugin output)
      if (entry.name === 'sections') continue

      const srcPath = join(src, entry.name)
      const destPath = join(dest, entry.name)

      if (entry.isFile()) {
        await copyFile(srcPath, destPath)
      } else if (entry.isDirectory()) {
        await mkdir(destPath, { recursive: true })
        await walk(srcPath, destPath)
      }
    }
  }

  await walk(sourceDir, destDir)
}

/// Resolve the tar binary to spawn.
///
/// A bare `tar` on Windows can resolve to the GNU tar shipped with Git for
/// Windows, which reads any argument containing a colon as `host:path` and so
/// fails on every absolute path ("Cannot connect to C:"). Windows ships bsdtar
/// at %SystemRoot%\System32\tar.exe, which understands drive letters, so prefer
/// that and fall back to a PATH lookup when it is absent.
export function tarBin(): string {
  if (process.platform !== 'win32') return 'tar'
  const systemTar = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  return existsSync(systemTar) ? systemTar : 'tar'
}

/// Validate tarball entries to prevent directory traversal attacks.
/// Lists all entries and rejects if any: starts with /, contains .., starts with ~, or contains \.
export async function validateTarEntries(tarFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = ''
    const child = spawn(tarBin(), ['-tzf', tarFile])
    child.on('error', reject)
    if (child.stdout) {
      child.stdout.on('data', chunk => {
        output += chunk.toString('utf8')
      })
    }
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to list tarball contents (exit code ${code})`))
        return
      }
      const entries = output.trim().split('\n').filter(Boolean)
      for (const entry of entries) {
        // Reject absolute paths
        if (entry.startsWith('/')) {
          reject(new Error(`Tarball contains absolute path: ${entry}`))
          return
        }
        // Reject .. path traversal
        if (entry.includes('..')) {
          reject(new Error(`Tarball contains directory traversal: ${entry}`))
          return
        }
        // Reject home directory expansion
        if (entry.startsWith('~')) {
          reject(new Error(`Tarball contains home directory reference: ${entry}`))
          return
        }
        // Reject backslashes (path separator on Windows, escape char)
        if (entry.includes('\\')) {
          reject(new Error(`Tarball contains backslash in entry name: ${entry}`))
          return
        }
      }
      // Name checks above are blind to entry TYPE: `tar -tzf` prints a symlink
      // as a bare name, hiding its "-> target". A symlink (or hardlink, device,
      // fifo) can escape the extraction dir before verifyPlugin's post-extract
      // symlink check runs, on platforms whose tar follows links mid-archive.
      // Reject by type flag, which every tar puts at column 0 of a verbose list.
      const verbose = spawn(tarBin(), ['-tvzf', tarFile])
      let vout = ''
      verbose.on('error', reject)
      if (verbose.stdout) verbose.stdout.on('data', c => { vout += c.toString('utf8') })
      verbose.on('exit', vcode => {
        if (vcode !== 0) { reject(new Error(`Failed to list tarball types (exit code ${vcode})`)); return }
        for (const line of vout.trim().split('\n').filter(Boolean)) {
          const typeFlag = line[0]
          if (typeFlag !== '-' && typeFlag !== 'd') {
            reject(new Error(`Tarball contains a non-regular entry (type "${typeFlag}"); only files and directories are allowed`))
            return
          }
        }
        resolve()
      })
    })
  })
}

/// Install from a local path (existing flow).
async function addLocal(sourcePath: string, pluginsDir: string): Promise<void> {
  await verifyAndInstall(sourcePath, pluginsDir)
}

/// Install from the org receiver (remote flow).
async function addRemote(name: string, pluginsDir: string): Promise<void> {
  // Read sync config
  const config = readSyncConfig()
  if (!config) {
    throw new Error('Sync not configured. Run `codeburn sync setup <url>` first.')
  }

  // Refresh token
  const store = createCredentialStore()
  const rt = store.retrieve()
  if (!rt) {
    throw new Error('No auth token found. Run `codeburn sync setup` to authenticate.')
  }

  const oidc = await fetchOidcConfig(config.issuer)
  const tokens = await refreshToken(oidc.token_endpoint, rt, config.clientId)

  // Store rotated token
  if (tokens.refresh_token && tokens.refresh_token !== rt) {
    store.store(tokens.refresh_token)
  }

  // Fetch manifest
  const manifestUrl = `${config.baseUrl}/plugin/${name}/manifest`
  const manifestResp = await fetch(manifestUrl, {
    headers: { 'Authorization': `Bearer ${tokens.access_token}` },
  })

  if (!manifestResp.ok) {
    let msg = `HTTP ${manifestResp.status}`
    try {
      const body = await manifestResp.text()
      const json = JSON.parse(body)
      msg = json.error ?? json.message ?? msg
    } catch {}
    throw new Error(`Failed to fetch plugin manifest: ${msg}`)
  }

  // A manifest is a few hundred bytes; cap the read so a misbehaving server
  // cannot balloon memory before parsing.
  const manifestText = await manifestResp.text()
  if (manifestText.length > 64 * 1024) {
    throw new Error('Plugin manifest response exceeds 64 KB; refusing')
  }
  const manifestData = JSON.parse(manifestText) as Record<string, unknown>
  const manifestSha = typeof manifestData.sha256 === 'string' ? manifestData.sha256 : ''
  const manifestSize = typeof manifestData.size === 'number' ? manifestData.size : 0

  if (!manifestSha) {
    throw new Error('Manifest missing sha256')
  }

  // Download tarball
  const downloadUrl = `${config.baseUrl}/plugin/${name}/download`
  const downloadResp = await fetch(downloadUrl, {
    headers: { 'Authorization': `Bearer ${tokens.access_token}` },
  })

  if (!downloadResp.ok) {
    throw new Error(`Failed to download plugin: HTTP ${downloadResp.status}`)
  }

  // Check content-length
  const contentLength = downloadResp.headers.get('content-length')
  const size = contentLength ? parseInt(contentLength, 10) : 0
  if (size > 50 * 1024 * 1024) {
    throw new Error(`Plugin tarball exceeds 50 MB limit (${size} bytes)`)
  }

  // Download and hash
  const buffer = await downloadResp.arrayBuffer()
  const bytes = new Uint8Array(buffer)

  if (bytes.length > 50 * 1024 * 1024) {
    throw new Error(`Plugin tarball exceeds 50 MB limit (${bytes.length} bytes)`)
  }

  // Verify sha256
  const headerSha = downloadResp.headers.get('x-codeburn-sha256') || ''
  const computed = createHash('sha256').update(bytes).digest('hex')
  if (computed !== manifestSha || computed !== headerSha) {
    throw new Error(`Plugin tarball integrity check failed (sha256 mismatch)`)
  }

  // Extract to temp dir
  const tempDir = await mkdtemp(join(tmpdir(), 'codeburn-plugin-'))
  try {
    const tarFile = join(tempDir, 'plugin.tar.gz')
    await writeFile(tarFile, bytes)

    // Validate tarball entries before extraction (prevent directory traversal)
    await validateTarEntries(tarFile)

    // Extract tar
    await new Promise<void>((resolve, reject) => {
      const child = spawn(tarBin(), ['-xzf', tarFile, '-C', tempDir])
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`tar extraction failed with exit code ${code}`))
      })
    })

    // Determine plugin root: if single top-level dir, use that; else use tempDir
    const extracted = await readdir(tempDir)
    const dirs = extracted.filter(f => f !== 'plugin.tar.gz')

    let pluginRoot: string
    if (dirs.length === 1) {
      const stat_ = await stat(join(tempDir, dirs[0]))
      if (stat_.isDirectory()) {
        pluginRoot = join(tempDir, dirs[0])
      } else {
        throw new Error('Tarball must contain either a single top-level directory or files at root')
      }
    } else if (dirs.length > 1) {
      // Files or multiple dirs at root
      const allFiles = await readdir(tempDir)
      if (allFiles.some(f => f.startsWith('codeburn-plugin'))) {
        pluginRoot = tempDir
      } else {
        throw new Error('Tarball must contain either a single top-level directory or files at root')
      }
    } else {
      throw new Error('Tarball is empty')
    }

    // Verify manifest name matches requested name
    const { raw, reason } = await readPluginManifestRaw(pluginRoot)
    if (reason) {
      throw new Error(`Could not read plugin manifest: ${reason}`)
    }
    const parsed = parsePluginManifest(raw, 'codeburn-plugin.json')
    if (!parsed.ok) {
      throw new Error(`Invalid plugin manifest: ${parsed.reason}`)
    }
    if (parsed.manifest.name !== name) {
      throw new Error(`Plugin name mismatch: expected "${name}", got "${parsed.manifest.name}"`)
    }

    // Install
    await verifyAndInstall(pluginRoot, pluginsDir)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

// Re-export so consumers can pin the version pinned by the socket itself.
export { defaultPluginsDir, currentCliVersion }

export async function registerLoadedPluginCommands(program: Command, loads?: PluginLoad[]): Promise<void> {
  const pluginLoads = loads ?? await loadPlugins()

  for (const load of pluginLoads) {
    if (load.status !== 'loaded') continue
    const manifest = load.manifest
    const pluginDir = load.dir

    for (const commandName of manifest.capabilities.commands) {
      // Collision check: skip if command already exists (built-ins win)
      if (program.commands.some(c => c.name() === commandName)) {
        process.stderr.write(`plugin "${manifest.name}": command "${commandName}" conflicts with a built-in and was not registered\n`)
        continue
      }

      program
        .command(commandName)
        .description(`Plugin command from ${manifest.name}@${manifest.version}`)
        .allowUnknownOption(true)
        .argument('[args...]')
        .action(async (args: string[]) => {
          const entryFile = join(pluginDir, 'commands', commandName + '.mjs')
          try {
            await stat(entryFile)
          } catch {
            process.stderr.write(`plugin "${manifest.name}": missing commands/${commandName}.mjs\n`)
            process.exitCode = 1
            return
          }

          const env = { ...process.env, CODEBURN_PLUGIN_DIR: pluginDir }
          const child = spawn(process.execPath, [entryFile, ...args], {
            stdio: 'inherit',
            env,
          })

          await new Promise<void>((resolve) => {
            child.on('exit', (code) => {
              if (code !== null && code !== 0) {
                process.exitCode = code
              }
              resolve()
            })
          })
        })
    }
  }
}