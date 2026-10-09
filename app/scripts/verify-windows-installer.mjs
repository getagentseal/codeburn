#!/usr/bin/env node

import { readFileSync, readdirSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { rootFromModuleUrl } from './windows-installer-paths.mjs'

function fail(message) {
  console.error(`Windows installer manifest invalid: ${message}`)
  process.exitCode = 1
}

function option(name, fallback) {
  const index = process.argv.indexOf(name)
  if (index === -1) return fallback
  if (!process.argv[index + 1]) throw new Error(`${name} requires a value`)
  return process.argv[index + 1]
}

function packageVersion(path) {
  return JSON.parse(readFileSync(path, 'utf8')).version
}

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => basename(entry.name))
}

function releaseVersion(tag) {
  const match = /^desktop-v(.+)$/.exec(tag)
  if (!match) throw new Error(`${tag || '(missing tag)'} is not a desktop release tag`)
  return match[1]
}

function verifyLiveRelease(tag, assetPath) {
  const version = releaseVersion(tag)
  const assets = JSON.parse(readFileSync(assetPath, 'utf8'))
  if (!Array.isArray(assets) || assets.some(asset => typeof asset !== 'string')) {
    throw new Error('release asset manifest must be a JSON array of names')
  }
  const required = [
    `CodeBurn-${version}-arm64.dmg`,
    `CodeBurn-${version}.dmg`,
    `CodeBurn-${version}-arm64-mac.zip`,
    `CodeBurn-${version}-mac.zip`,
    `CodeBurn-${version}.AppImage`,
    `codeburn-desktop_${version}_amd64.deb`,
    `codeburn-desktop-${version}.x86_64.rpm`,
    `CodeBurn-Setup-${version}.exe`,
    `CodeBurn-Setup-${version}.exe.blockmap`,
    'latest-mac.yml',
    'latest-linux.yml',
  ]
  for (const expected of required) {
    const count = assets.filter(asset => asset === expected).length
    if (count === 0) fail(`live release is missing ${expected}`)
    if (count > 1) fail(`live release contains ${count} copies of ${expected}`)
  }
  if (!process.exitCode) console.log(`Live desktop release assets verified for ${version}`)
}

try {
  const tag = option('--tag', '')
  const releaseAssets = option('--release-assets', '')
  if (releaseAssets) {
    verifyLiveRelease(tag, resolve(releaseAssets))
  } else {
    const root = resolve(option('--root', rootFromModuleUrl(import.meta.url)))
    const artifacts = resolve(option('--artifacts', join(root, 'app', 'release')))
    const rootVersion = packageVersion(join(root, 'package.json'))
    const appVersion = packageVersion(join(root, 'app', 'package.json'))

    if (rootVersion !== appVersion) {
      fail(`root version ${rootVersion} does not match app version ${appVersion}`)
    }

    if (tag && tag !== `desktop-v${appVersion}`) {
      fail(`${tag} does not match app version ${appVersion}`)
    }

    const files = filesBelow(artifacts)
    const expectedArtifacts = [
      `CodeBurn-Setup-${appVersion}.exe`,
      `CodeBurn-Setup-${appVersion}.exe.blockmap`,
    ]
    for (const expected of expectedArtifacts) {
      const count = files.filter(file => file === expected).length
      if (count !== 1) fail(`expected exactly one ${expected}, found ${count}`)
    }

    const installerArtifacts = files.filter(file => /^CodeBurn-Setup-.*\.exe(?:\.blockmap)?$/.test(file))
    const unexpected = installerArtifacts.filter(file => !expectedArtifacts.includes(file))
    if (unexpected.length > 0) {
      fail(`unexpected Windows installer artifacts: ${unexpected.join(', ')}`)
    }

    if (!process.exitCode) {
      console.log(`Windows installer manifest verified for ${appVersion}`)
    }
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error))
}
