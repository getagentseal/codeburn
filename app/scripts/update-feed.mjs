#!/usr/bin/env node

// Rewrites electron-builder's latest*.yml in place for the fixed update-feeds release. The
// app reads the yml from update-feeds, so the bare file names it lists would resolve there
// and 404; they become absolute URLs into the desktop-v<version> release that holds them.

import { readFileSync, writeFileSync } from 'node:fs'

const DOWNLOAD_BASE = 'https://github.com/getagentseal/codeburn/releases/download'
const FILE_LINE = /^(\s*(?:- )?(?:url|path): )(.+)$/

function rewriteFeed(text, tag, assets) {
  const version = /^desktop-v(.+)$/.exec(tag)?.[1]
  if (!version) throw new Error(`${tag || '(missing tag)'} is not a desktop release tag`)
  const feedVersion = /^version: '?([^'\s]+)'?$/m.exec(text)?.[1]
  if (feedVersion !== version) throw new Error(`feed version ${feedVersion} does not match ${tag}`)
  let files = 0
  const out = text.split('\n').map(line => {
    const match = FILE_LINE.exec(line)
    if (!match) return line
    const name = match[2].trim().replace(/^'(.*)'$/, '$1')
    if (!assets.includes(name)) throw new Error(`${tag} has no asset named ${name}`)
    files++
    return `${match[1]}${DOWNLOAD_BASE}/${tag}/${name}`
  })
  if (files === 0) throw new Error('feed lists no files')
  return out.join('\n')
}

function option(name) {
  const index = process.argv.indexOf(name)
  if (index === -1 || !process.argv[index + 1]) throw new Error(`${name} requires a value`)
  return process.argv[index + 1]
}

try {
  const tag = option('--tag')
  const assets = JSON.parse(readFileSync(option('--release-assets'), 'utf8'))
  const feeds = process.argv.slice(2).filter(arg => arg.endsWith('.yml'))
  if (feeds.length === 0) throw new Error('no feed files given')
  for (const feed of feeds) {
    writeFileSync(feed, rewriteFeed(readFileSync(feed, 'utf8'), tag, assets))
    console.log(`rewrote ${feed} for ${tag}`)
  }
} catch (error) {
  console.error(`Update feed invalid: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
