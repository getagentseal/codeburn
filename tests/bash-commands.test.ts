import { describe, it, expect } from 'vitest'
import { extractBashCommands } from '../src/bash-utils.js'
import { BASH_TOOLS } from '../src/classifier.js'

describe('extractBashCommands', () => {
  it('extracts single command', () => {
    expect(extractBashCommands('git status')).toEqual(['git'])
  })

  it('extracts chained commands with &&', () => {
    expect(extractBashCommands('git add . && git commit -m "x"')).toEqual(['git', 'git'])
  })

  it('extracts chained commands with ;', () => {
    expect(extractBashCommands('ls; pwd')).toEqual(['ls', 'pwd'])
  })

  it('extracts piped commands', () => {
    expect(extractBashCommands('cat file | grep pattern')).toEqual(['cat', 'grep'])
  })

  it('filters out cd', () => {
    expect(extractBashCommands('cd /path && git status')).toEqual(['git'])
  })

  it('returns empty for cd only', () => {
    expect(extractBashCommands('cd /path')).toEqual([])
  })

  it('returns empty for empty string', () => {
    expect(extractBashCommands('')).toEqual([])
  })

  it('returns empty for whitespace only', () => {
    expect(extractBashCommands('   ')).toEqual([])
  })

  it('extracts basename from full path binary', () => {
    expect(extractBashCommands('/usr/bin/git status')).toEqual(['git'])
  })

  it('handles mixed separators', () => {
    expect(extractBashCommands('cd /x && npm install; npm run build | tee log')).toEqual(['npm', 'npm', 'tee'])
  })

  it('handles extra whitespace', () => {
    expect(extractBashCommands('  git   status  ')).toEqual(['git'])
  })

  it('handles command with quotes containing separators', () => {
    expect(extractBashCommands('echo "hello && world"')).toEqual(['echo'])
  })

  it('handles quoted separators followed by real separator', () => {
    expect(extractBashCommands('echo "hello && world" && git status')).toEqual(['echo', 'git'])
  })

  it('handles single-quoted separators', () => {
    expect(extractBashCommands("echo 'hello && world'")).toEqual(['echo'])
  })

  it('skips leading env var assignments', () => {
    expect(extractBashCommands('NODE_ENV=prod npm test')).toEqual(['npm'])
    expect(extractBashCommands('FOO=bar BAZ=qux ls -la')).toEqual(['ls'])
  })

  it('skips standalone true/false', () => {
    expect(extractBashCommands('true && git status')).toEqual(['git'])
    expect(extractBashCommands('false || echo done')).toEqual(['echo'])
    expect(extractBashCommands('true')).toEqual([])
  })

  it('handles env vars combined with chained commands', () => {
    expect(extractBashCommands('NODE_ENV=test npm test && git push')).toEqual(['npm', 'git'])
  })

  it('skips command wrapper prefixes', () => {
    expect(extractBashCommands('rtk git status')).toEqual(['git'])
    expect(extractBashCommands('sudo npm install')).toEqual(['npm'])
    expect(extractBashCommands('npx vitest --run')).toEqual(['vitest'])
  })

  it('skips prefix combined with env var assignment', () => {
    expect(extractBashCommands('DEBUG=1 rtk git status')).toEqual(['git'])
  })

  it('skips nested wrapper prefixes', () => {
    expect(extractBashCommands('sudo npx vitest --run')).toEqual(['vitest'])
  })

  it('skips prefix across chained commands', () => {
    expect(extractBashCommands('rtk git add . && rtk git commit -m "msg"')).toEqual(['git', 'git'])
  })

  it('keeps a standalone prefix with no following command', () => {
    expect(extractBashCommands('rtk')).toEqual(['rtk'])
    expect(extractBashCommands('sudo')).toEqual(['sudo'])
  })

  it('keeps prefix when the next token is a flag', () => {
    expect(extractBashCommands('nice -n 10 git push')).toEqual(['nice'])
  })

  it('skips env assignment that follows a wrapper prefix', () => {
    expect(extractBashCommands('sudo NODE_ENV=production node server.js')).toEqual(['node'])
    expect(extractBashCommands('time FOO=1 make build')).toEqual(['make'])
  })

  it('keeps prefix when the next token is quoted', () => {
    expect(extractBashCommands('npx "@angular/cli" new app')).toEqual(['npx'])
    expect(extractBashCommands("npx 'ts-node' script.ts")).toEqual(['npx'])
  })
})

describe('BASH_TOOLS', () => {
  it('recognizes Bash', () => { expect(BASH_TOOLS.has('Bash')).toBe(true) })
  it('recognizes BashTool', () => { expect(BASH_TOOLS.has('BashTool')).toBe(true) })
  it('rejects unknown tools', () => { expect(BASH_TOOLS.has('Read')).toBe(false) })
})
