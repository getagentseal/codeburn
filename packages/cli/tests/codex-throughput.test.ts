import { appendFile, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexThroughputReader, readCodexThroughput, renderCodexThroughput } from '../src/codex-throughput.js'

describe('Codex throughput prototype', () => {
  it('estimates generated tokens/sec between token_count checkpoints', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-tps-'))
    const path = join(dir, 'rollout.jsonl')
    await writeFile(path, [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-07-25T00:00:00.000Z', payload: { model: 'gpt-5.6-sol' } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-07-25T00:00:00.000Z', payload: { type: 'task_started' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-07-25T00:00:02.000Z', payload: { type: 'function_call', call_id: 'tool-1' } }),
      JSON.stringify({ type: 'response_item', timestamp: '2026-07-25T00:00:05.000Z', payload: { type: 'function_call_output', call_id: 'tool-1' } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-07-25T00:00:05.000Z', payload: { type: 'mcp_tool_call_end', duration: { secs: 3, nanos: 0 } } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-07-25T00:00:10.000Z', payload: { type: 'token_count', info: { last_token_usage: { output_tokens: 80, reasoning_output_tokens: 20 }, total_token_usage: { total_tokens: 100, output_tokens: 80, reasoning_output_tokens: 20 } } } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-07-25T00:00:15.000Z', payload: { type: 'token_count', info: { last_token_usage: { output_tokens: 40, reasoning_output_tokens: 10 }, total_token_usage: { total_tokens: 150, output_tokens: 120, reasoning_output_tokens: 30 } } } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-07-25T00:00:16.000Z', payload: { type: 'task_complete', duration_ms: 10000 } }),
    ].join('\n'))

    const points = await readCodexThroughput(path)
    expect(points).toHaveLength(2)
    expect(points[1]).toMatchObject({ generatedTokens: 50, elapsedSeconds: 5, generatedTokensPerSecond: 10, activeDurationSeconds: 7, activeGeneratedTokensPerSecond: 21.428571428571427, toolWaitSeconds: 3, model: 'gpt-5.6-sol' })
    expect(renderCodexThroughput(points, path)).toContain('21.4 generated tokens/sec')
  })

  it('parses only appended complete lines while watching a growing rollout', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-tps-watch-'))
    const path = join(dir, 'rollout.jsonl')
    const first = JSON.stringify({ type: 'event_msg', timestamp: '2026-07-25T00:00:00.000Z', payload: { type: 'token_count', info: { last_token_usage: { output_tokens: 8, reasoning_output_tokens: 2 }, total_token_usage: { total_tokens: 10, output_tokens: 8, reasoning_output_tokens: 2 } } } })
    const second = JSON.stringify({ type: 'event_msg', timestamp: '2026-07-25T00:00:01.000Z', payload: { type: 'token_count', info: { last_token_usage: { output_tokens: 4, reasoning_output_tokens: 1 }, total_token_usage: { total_tokens: 15, output_tokens: 12, reasoning_output_tokens: 3 } } } })
    await writeFile(path, first.slice(0, 40))
    const reader = new CodexThroughputReader()
    expect(await reader.update(path)).toEqual([])
    await appendFile(path, first.slice(40) + '\n' + second + '\n')
    const points = await reader.update(path)
    expect(points).toHaveLength(2)
    expect(points[1]).toMatchObject({ generatedTokens: 5, generatedTokensPerSecond: 5 })
  })

  it('ignores replayed pre-fork checkpoints before estimating new work', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-tps-fork-'))
    const path = join(dir, 'rollout.jsonl')
    const line = (timestamp: string, payload: Record<string, unknown>) => JSON.stringify({ type: 'event_msg', timestamp, payload })
    await writeFile(path, [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-07-25T00:00:00.000Z', payload: { model: 'gpt-5.6-sol', forked_from_id: 'parent' } }),
      line('2026-07-25T00:00:01.000Z', { type: 'task_started' }),
      line('2026-07-25T00:00:02.000Z', { type: 'token_count', info: { last_token_usage: { output_tokens: 100 }, total_token_usage: { total_tokens: 100, output_tokens: 100 } } }),
      line('2026-07-25T00:00:03.000Z', { type: 'task_complete', duration_ms: 1000 }),
      line('2026-07-25T00:00:06.000Z', { type: 'task_started' }),
      line('2026-07-25T00:00:08.000Z', { type: 'token_count', info: { last_token_usage: { output_tokens: 20 }, total_token_usage: { total_tokens: 20, output_tokens: 20 } } }),
      line('2026-07-25T00:00:10.000Z', { type: 'task_complete', duration_ms: 4000 }),
    ].join('\n'))

    const points = await readCodexThroughput(path)
    expect(points).toHaveLength(1)
    expect(points[0]).toMatchObject({ generatedTokens: 20, activeGeneratedTokensPerSecond: 5 })
  })

  it('keeps oversized rollout lines bounded while extracting token usage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-tps-large-'))
    const path = join(dir, 'rollout.jsonl')
    const largeResult = JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-07-25T00:00:01.000Z',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { output_tokens: 12 }, total_token_usage: { total_tokens: 12, output_tokens: 12 } },
        result: 'x'.repeat(5 * 1024 * 1024),
      },
    })
    await writeFile(path, largeResult)
    const points = await readCodexThroughput(path)
    expect(points).toHaveLength(1)
    expect(points[0]?.generatedTokens).toBe(12)
  })

  it('keeps MCP duration when arguments and result surround the middle field', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-tps-mcp-large-'))
    const path = join(dir, 'rollout.jsonl')
    const mcp = JSON.stringify({
      type: 'event_msg', timestamp: '2026-07-25T00:00:05.000Z',
      payload: {
        type: 'mcp_tool_call_end',
        invocation: { server: 'github', tool: 'get_issue', arguments: { body: 'x'.repeat(5 * 1024 * 1024) } },
        duration: { secs: 3, nanos: 0 },
        result: { duration: '9s', text: 'x'.repeat(5 * 1024 * 1024) },
      },
    })
    await writeFile(path, [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-07-25T00:00:00.000Z', payload: { model: 'gpt-5.6-sol' } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-07-25T00:00:00.000Z', payload: { type: 'task_started' } }),
      mcp,
      JSON.stringify({ type: 'event_msg', timestamp: '2026-07-25T00:00:08.000Z', payload: { type: 'token_count', info: { last_token_usage: { output_tokens: 100 }, total_token_usage: { total_tokens: 100, output_tokens: 100 } } } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-07-25T00:00:10.000Z', payload: { type: 'task_complete', duration_ms: 10000 } }),
    ].join('\n'))
    const points = await readCodexThroughput(path)
    expect(points[0]).toMatchObject({ toolWaitSeconds: 3, activeDurationSeconds: 7, activeGeneratedTokensPerSecond: 100 / 7 })
  })

  it('keeps a streamed string MCP duration when arguments and result surround the middle field', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codeburn-tps-mcp-string-large-'))
    const path = join(dir, 'rollout.jsonl')
    const mcp = JSON.stringify({
      type: 'event_msg', timestamp: '2026-07-25T00:00:05.000Z',
      payload: {
        type: 'mcp_tool_call_end',
        invocation: { server: 'github', tool: 'get_issue', arguments: { body: 'x'.repeat(5 * 1024 * 1024) } },
        duration: '3s',
        result: { duration: '9s', text: 'x'.repeat(5 * 1024 * 1024) },
      },
    })
    await writeFile(path, [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-07-25T00:00:00.000Z', payload: { model: 'gpt-5.6-sol' } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-07-25T00:00:00.000Z', payload: { type: 'task_started' } }),
      mcp,
      JSON.stringify({ type: 'event_msg', timestamp: '2026-07-25T00:00:08.000Z', payload: { type: 'token_count', info: { last_token_usage: { output_tokens: 100 }, total_token_usage: { total_tokens: 100, output_tokens: 100 } } } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-07-25T00:00:10.000Z', payload: { type: 'task_complete', duration_ms: 10000 } }),
    ].join('\n'))
    const points = await readCodexThroughput(path)
    expect(points[0]).toMatchObject({ toolWaitSeconds: 3, activeDurationSeconds: 7, activeGeneratedTokensPerSecond: 100 / 7 })
  })
})
