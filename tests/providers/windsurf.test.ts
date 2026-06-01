import { describe, it, expect, beforeEach } from 'vitest'
import { getAllProviders } from '../../src/providers/index.js'
import { createWindsurfProvider } from '../../src/providers/windsurf.js'
import type { Provider } from '../../src/providers/types.js'

describe('windsurf provider', () => {
  let windsurfProvider: Provider

  beforeEach(async () => {
    const all = await getAllProviders()
    windsurfProvider = all.find(p => p.name === 'windsurf')!
  })

  it('is registered', () => {
    expect(windsurfProvider).toBeDefined()
    expect(windsurfProvider.name).toBe('windsurf')
    expect(windsurfProvider.displayName).toBe('Windsurf')
  })

  describe('model display names', () => {
    it('maps SWE models to readable names', () => {
      expect(windsurfProvider.modelDisplayName('swe-1.6')).toBe('SWE-1.6')
      expect(windsurfProvider.modelDisplayName('swe-1.5')).toBe('SWE-1.5')
      expect(windsurfProvider.modelDisplayName('swe-grep')).toBe('SWE-Grep')
      expect(windsurfProvider.modelDisplayName('swe-1')).toBe('SWE-1')
    })

    it('maps windsurf-auto to Windsurf Auto', () => {
      expect(windsurfProvider.modelDisplayName('windsurf-auto')).toBe('Windsurf Auto')
    })

    it('maps Claude models to readable names', () => {
      expect(windsurfProvider.modelDisplayName('claude-4.5-opus-high-thinking')).toBe('Opus 4.5 (Thinking)')
      expect(windsurfProvider.modelDisplayName('claude-4-sonnet-thinking')).toBe('Sonnet 4 (Thinking)')
      expect(windsurfProvider.modelDisplayName('claude-4.5-sonnet-thinking')).toBe('Sonnet 4.5 (Thinking)')
      expect(windsurfProvider.modelDisplayName('claude-4.6-sonnet')).toBe('Sonnet 4.6')
    })

    it('maps other models to readable names', () => {
      expect(windsurfProvider.modelDisplayName('composer-1')).toBe('Composer 1')
      expect(windsurfProvider.modelDisplayName('grok-code-fast-1')).toBe('Grok Code Fast')
      expect(windsurfProvider.modelDisplayName('gemini-3-pro')).toBe('Gemini 3 Pro')
      expect(windsurfProvider.modelDisplayName('gpt-5')).toBe('GPT-5')
      expect(windsurfProvider.modelDisplayName('gpt-4.1')).toBe('GPT-4.1')
    })

    it('returns raw name for unknown models', () => {
      expect(windsurfProvider.modelDisplayName('some-future-model')).toBe('some-future-model')
    })
  })

  describe('tool display names', () => {
    it('maps windsurf tools to standard names', () => {
      expect(windsurfProvider.toolDisplayName('read_file')).toBe('Read')
      expect(windsurfProvider.toolDisplayName('write_file')).toBe('Edit')
      expect(windsurfProvider.toolDisplayName('edit_file')).toBe('Edit')
      expect(windsurfProvider.toolDisplayName('run_command')).toBe('Bash')
      expect(windsurfProvider.toolDisplayName('bash')).toBe('Bash')
      expect(windsurfProvider.toolDisplayName('browser_search')).toBe('WebSearch')
      expect(windsurfProvider.toolDisplayName('web_search')).toBe('WebSearch')
      expect(windsurfProvider.toolDisplayName('mcp_tool')).toBe('MCP')
      expect(windsurfProvider.toolDisplayName('agent_spawn')).toBe('Agent')
      expect(windsurfProvider.toolDisplayName('think')).toBe('Think')
      expect(windsurfProvider.toolDisplayName('planning')).toBe('Plan')
    })

    it('returns raw tool name for unknown tools', () => {
      expect(windsurfProvider.toolDisplayName('some_future_tool')).toBe('some_future_tool')
    })
  })

  describe('session discovery', () => {
    it('returns empty array because windsurf data is not accessible', async () => {
      const sessions = await windsurfProvider.discoverSessions()
      expect(sessions).toEqual([])
    })

    it('handles missing directory gracefully', async () => {
      const provider = createWindsurfProvider('/non/existent/path')
      const sessions = await provider.discoverSessions()
      expect(sessions).toEqual([])
    })
  })

  describe('session parsing', () => {
    it('creates session parser that yields no results', async () => {
      const source = {
        path: '/non/existent/state.vscdb',
        project: 'test-project',
        provider: 'windsurf'
      }
      const seenKeys = new Set<string>()
      const parser = windsurfProvider.createSessionParser(source, seenKeys)

      const results = []
      for await (const call of parser.parse()) {
        results.push(call)
      }

      expect(results).toEqual([])
    })
  })

  describe('provider factory', () => {
    it('creates provider with default directory', () => {
      const provider = createWindsurfProvider()
      expect(provider.name).toBe('windsurf')
      expect(provider.displayName).toBe('Windsurf')
    })

    it('creates provider with custom directory', () => {
      const customDir = '/custom/windsurf/path'
      const provider = createWindsurfProvider(customDir)
      expect(provider.name).toBe('windsurf')
      expect(provider.displayName).toBe('Windsurf')
    })
  })
})
