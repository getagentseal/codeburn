import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { join } from 'node:path'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import {
  workbuddy,
  workbuddyai,
  getWorkBuddyHome,
  getWorkBuddyProjectsDir,
  WORKBUDDY_CONFIG,
  WORKBUDDYAI_CONFIG,
  decodeWorkBuddyProjectPath,
  normalizeWorkBuddyTool,
  extractUserPrompt,
} from '../../src/providers/workbuddy.js'
import type { SessionSource } from '../../src/providers/types.js'

describe('WorkBuddy and WorkBuddy AI providers', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'workbuddy-test-'))
  })

  afterEach(() => {
    delete process.env.WORKBUDDY_HOME
    delete process.env.WORKBUDDY_AI_HOME
    rmSync(tempDir, { recursive: true, force: true })
  })

  describe('identity and registration', () => {
    it('declares expected identities', () => {
      expect(workbuddy.name).toBe('workbuddy')
      expect(workbuddy.displayName).toBe('WorkBuddy')

      expect(workbuddyai.name).toBe('workbuddyai')
      expect(workbuddyai.displayName).toBe('WorkBuddy AI')
    })

    it('normalizes tool display names to canonical vocabulary', () => {
      for (const p of [workbuddy, workbuddyai]) {
        expect(p.toolDisplayName('Read')).toBe('Read')
        expect(p.toolDisplayName('read_file')).toBe('Read')
        expect(p.toolDisplayName('Write')).toBe('Write')
        expect(p.toolDisplayName('write_to_file')).toBe('Write')
        expect(p.toolDisplayName('Edit')).toBe('Edit')
        expect(p.toolDisplayName('replace_in_file')).toBe('Edit')
        expect(p.toolDisplayName('Bash')).toBe('Bash')
        expect(p.toolDisplayName('execute_command')).toBe('Bash')
        expect(p.toolDisplayName('Grep')).toBe('Grep')
        expect(p.toolDisplayName('Glob')).toBe('Glob')
        expect(p.toolDisplayName('browser_navigate')).toBe('Browser')
        expect(p.toolDisplayName('custom_tool')).toBe('custom_tool')
      }
    })
  })

  describe('path resolution and probe roots', () => {
    it('resolves home and projects dir from defaults', () => {
      const home = getWorkBuddyHome(WORKBUDDY_CONFIG)
      expect(home).toContain('.workbuddy')
      const pDir = getWorkBuddyProjectsDir(WORKBUDDY_CONFIG)
      expect(pDir).toBe(join(home, 'projects'))
    })

    it('honors environment variable overrides', () => {
      process.env.WORKBUDDY_HOME = join(tempDir, 'custom-wb')
      expect(getWorkBuddyHome(WORKBUDDY_CONFIG)).toBe(join(tempDir, 'custom-wb'))

      process.env.WORKBUDDY_AI_HOME = join(tempDir, 'custom-wb-ai')
      expect(getWorkBuddyHome(WORKBUDDYAI_CONFIG)).toBe(join(tempDir, 'custom-wb-ai'))
    })

    it('returns probe roots correctly', async () => {
      const wbRoots = await workbuddy.probeRoots!()
      expect(wbRoots.length).toBeGreaterThan(0)
      expect(wbRoots[0].path).toContain('.workbuddy')

      const wbaiRoots = await workbuddyai.probeRoots!()
      expect(wbaiRoots.length).toBeGreaterThan(0)
      expect(wbaiRoots[0].path).toContain('.workbuddy-ai')
    })
  })

  describe('project path slug decoding', () => {
    it('decodes Windows and POSIX path slugs', () => {
      expect(decodeWorkBuddyProjectPath('c-Users-MING-.pi-agent')).toBe('C:\\Users\\MING\\.pi\\agent')
      expect(decodeWorkBuddyProjectPath('d-Desktop-test-project')).toBe('D:\\Desktop\\test\\project')
      expect(decodeWorkBuddyProjectPath('-home-user-project')).toBe('/home/user/project')
    })
  })

  describe('user prompt extraction', () => {
    it('extracts query from XML tags', () => {
      const raw = '<system-reminder>...</system-reminder>\n<user_query>Hello, WorkBuddy!</user_query>'
      expect(extractUserPrompt(raw)).toBe('Hello, WorkBuddy!')
    })

    it('cleans plain prompt without user_query tags', () => {
      const raw = '<system-reminder>...</system-reminder>\nHelp me write code'
      expect(extractUserPrompt(raw)).toBe('Help me write code')
    })
  })

  describe('Session parser with real JSONL', () => {
    it('parses calls with tokens and tools correctly', async () => {
      const projDir = join(tempDir, 'c-Users-MING-project')
      mkdirSync(projDir, { recursive: true })
      const jsonlPath = join(projDir, 'session-123.jsonl')

      const lines = [
        JSON.stringify({
          type: 'message',
          role: 'user',
          timestamp: 1700000000000,
          sessionId: 'session-123',
          cwd: 'C:\\Users\\MING\\project',
          content: [
            {
              type: 'input_text',
              text: '<system-reminder>...</system-reminder>\n<user_query>Hello, WorkBuddy!</user_query>',
            },
          ],
        }),
        JSON.stringify({
          type: 'message',
          role: 'assistant',
          timestamp: 1700000001000,
          sessionId: 'session-123',
          content: 'Hello! How can I help you today?',
          providerData: {
            model: 'deepseek-v4.1-flash',
            rawUsage: {
              prompt_tokens: 100,
              completion_tokens: 20,
              total_tokens: 120,
              prompt_cache_hit_tokens: 30,
              prompt_cache_miss_tokens: 70,
              completion_tokens_details: {
                reasoning_tokens: 5,
              },
            },
          },
        }),
        JSON.stringify({
          type: 'function_call',
          name: 'Read',
          timestamp: 1700000002000,
          sessionId: 'session-123',
          arguments: { path: 'file.txt' },
          providerData: {
            model: 'deepseek-v4.1-flash',
            rawUsage: {
              prompt_tokens: 150,
              completion_tokens: 10,
              total_tokens: 160,
              prompt_cache_hit_tokens: 50,
              prompt_cache_miss_tokens: 100,
            },
          },
        }),
        JSON.stringify({
          type: 'ai-title',
          content: 'Greeting Conversation',
        }),
      ]

      writeFileSync(jsonlPath, lines.join('\n'), 'utf8')

      const source: SessionSource = {
        path: jsonlPath,
        project: 'c-Users-MING-project',
        provider: 'workbuddy',
      }
      const seenKeys = new Set<string>()
      const parser = workbuddy.createSessionParser(source, seenKeys)

      const calls = []
      for await (const call of parser.parse()) {
        calls.push(call)
      }

      expect(calls.length).toBe(2)

      const call1 = calls[0]
      expect(call1.provider).toBe('workbuddy')
      expect(call1.model).toBe('deepseek-v4.1-flash')
      expect(call1.sessionId).toBe('session-123')
      expect(call1.projectPath).toBe('C:\\Users\\MING\\project')
      expect(call1.userMessage).toBe('Greeting Conversation')
      expect(call1.inputTokens).toBe(100)
      expect(call1.outputTokens).toBe(20)
      expect(call1.cacheReadInputTokens).toBe(30)
      expect(call1.reasoningTokens).toBe(5)

      const call2 = calls[1]
      expect(call2.tools).toEqual(['Read'])
      expect(call2.toolSequence).toBeDefined()
      expect(call2.toolSequence![0][0].file).toBe('file.txt')
    })
  })

  describe('source discovery', () => {
    it('discovers jsonl files in projects directory', async () => {
      process.env.WORKBUDDY_HOME = tempDir
      const projDir = join(tempDir, 'projects', 'test-proj')
      mkdirSync(projDir, { recursive: true })
      writeFileSync(join(projDir, 'session-1.jsonl'), '{}', 'utf8')
      writeFileSync(join(projDir, 'session-1.file-rollback.ndjson'), '{}', 'utf8')

      const sources = await workbuddy.discoverSessions()
      expect(sources.length).toBe(1)
      expect(sources[0].path).toBe(join(projDir, 'session-1.jsonl'))
      expect(sources[0].project).toBe('test-proj')
      expect(sources[0].provider).toBe('workbuddy')
    })
  })
})
