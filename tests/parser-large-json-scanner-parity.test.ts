import { describe, expect, it } from 'vitest'

import { parseJsonlLine, shouldSkipLine } from '../src/parser.js'

const LARGE_PADDING = 'x'.repeat(40_000)

function withUnicodeEscapes(line: string): string {
  return line.replaceAll('☃', '\\u2603')
}

function jsonStringContent(value: string): string {
  return JSON.stringify(value).slice(1, -1)
}

function largeUserLine(rawJsonContent: string, prefix = ''): string {
  return `${prefix}{"type":"user","sessionId":"parity-edge","timestamp":"2026-05-01T00:00:00Z","message":{"role":"user","content":"${rawJsonContent}"},"padding":"${LARGE_PADDING}"}`
}

function largeUserArrayLine(rawJsonText: string): string {
  return `{"type":"user","sessionId":"parity-edge","message":{"role":"user","content":[{"type":"text","text":"${rawJsonText}"}]},"padding":"${LARGE_PADDING}"}`
}

function expectStringBufferParity(line: string): void {
  expect(parseJsonlLine(Buffer.from(line))).toEqual(parseJsonlLine(line))
}

function userLine(): { line: string; expected: ReturnType<typeof parseJsonlLine> } {
  const text = `escaped "quotes" and \\slashes\\; unicode ☃; nested {"brace":[1,2]} ${LARGE_PADDING}`
  const line = withUnicodeEscapes(JSON.stringify({
    type: 'user',
    sessionId: 'parity-user',
    timestamp: '2026-05-01T00:00:00Z',
    cwd: '/repo',
    message: { role: 'user', content: [{ type: 'text', text }] },
  }))
  return {
    line,
    expected: {
      type: 'user',
      sessionId: 'parity-user',
      timestamp: '2026-05-01T00:00:00Z',
      cwd: '/repo',
      message: { role: 'user', content: text.slice(0, 2000) },
    },
  }
}

function assistantLine(): { line: string; expected: ReturnType<typeof parseJsonlLine> } {
  const command = `printf '{"brace":[1,2]}' \\tmp\\file ☃ ${LARGE_PADDING}`
  const line = withUnicodeEscapes(JSON.stringify({
    type: 'assistant',
    sessionId: 'parity-assistant',
    timestamp: '2026-05-01T00:00:01Z',
    cwd: '/repo',
    message: {
      id: 'message-☃',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [
        { type: 'tool_use', id: 'tool-☃', name: 'Bash', input: { command, ignored: { nested: ['value'] } } },
      ],
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 300 },
    },
  }))
  return {
    line,
    expected: {
      type: 'assistant',
      sessionId: 'parity-assistant',
      timestamp: '2026-05-01T00:00:01Z',
      cwd: '/repo',
      message: {
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        id: 'message-☃',
        content: [{ type: 'tool_use', id: 'tool-☃', name: 'Bash', input: { command: command.slice(0, 2000) } }],
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 300 },
      },
    },
  }
}

function attachmentLine(): { line: string; expected: ReturnType<typeof parseJsonlLine> } {
  const line = withUnicodeEscapes(JSON.stringify({
    type: 'attachment',
    sessionId: 'parity-attachment',
    timestamp: '2026-05-01T00:00:02Z',
    cwd: '/repo',
    padding: LARGE_PADDING,
    attachment: { type: 'deferred_tools_delta', addedNames: ['mcp__svc__tool', 'tool-☃\\path'] },
  }))
  return {
    line,
    expected: {
      type: 'attachment',
      sessionId: 'parity-attachment',
      timestamp: '2026-05-01T00:00:02Z',
      cwd: '/repo',
      attachment: { type: 'deferred_tools_delta', addedNames: ['mcp__svc__tool', 'tool-☃\\path'] },
    },
  }
}

describe('large JSONL scanner string/Buffer parity', () => {
  it('keeps nasty strings, nested delimiters, unicode escapes, and truncation identical', () => {
    const completeCases = [userLine(), assistantLine(), attachmentLine()]

    for (const { line, expected } of completeCases) {
      const stringResult = parseJsonlLine(line)
      const bufferResult = parseJsonlLine(Buffer.from(line))
      expect(stringResult).toEqual(expected)
      expect(bufferResult).toEqual(expected)
      expect(bufferResult).toEqual(stringResult)
    }

    const truncatedLine = userLine().line.slice(0, -1)
    expect(parseJsonlLine(truncatedLine)).toBeNull()
    expect(parseJsonlLine(Buffer.from(truncatedLine))).toBeNull()
  })

  it('accepts leading JSON whitespace through both entry paths', () => {
    const line = `  ${userLine().line}`
    expect(parseJsonlLine(line)).toEqual(parseJsonlLine(userLine().line))
    expect(parseJsonlLine(Buffer.from(line))).toEqual(parseJsonlLine(line))
  })

  it('preserves escaped Unicode followed by multibyte text at the output cap', () => {
    const expectedContent = '☃'.repeat(700) + '亜'.repeat(1300)
    const rawJsonContent = '\\u2603'.repeat(700) + '亜'.repeat(5000)
    const line = largeUserLine(rawJsonContent)
    const arrayLine = largeUserArrayLine(rawJsonContent)
    const expected = {
      type: 'user',
      sessionId: 'parity-edge',
      timestamp: '2026-05-01T00:00:00Z',
      message: { role: 'user', content: expectedContent },
    }

    expect(parseJsonlLine(line)).toEqual(expected)
    expect(parseJsonlLine(Buffer.from(line))).toEqual(expected)
    const expectedArray = {
      type: 'user',
      sessionId: 'parity-edge',
      message: { role: 'user', content: expectedContent },
    }
    expect(parseJsonlLine(arrayLine)).toEqual(expectedArray)
    expect(parseJsonlLine(Buffer.from(arrayLine))).toEqual(parseJsonlLine(arrayLine))
  })

  it('keeps raw emoji cap truncation identical across UTF-16 and UTF-8', () => {
    const rawText = '😀'.repeat(3000)
    const line = largeUserLine(jsonStringContent(rawText))
    const expectedContent = rawText.slice(0, 2000)
    const expected = {
      type: 'user',
      sessionId: 'parity-edge',
      timestamp: '2026-05-01T00:00:00Z',
      message: { role: 'user', content: expectedContent },
    }

    expect(parseJsonlLine(line)).toEqual(expected)
    expect(parseJsonlLine(Buffer.from(line))).toEqual(expected)
  })

  it('keeps parity when a large line truncates mid-string or mid-escape', () => {
    const midString = largeUserLine('y'.repeat(40_000)).slice(0, -LARGE_PADDING.length - 4)
    const midEscape = largeUserLine(`${'y'.repeat(2_000)}\\u26`)

    expect(parseJsonlLine(midString)).toBeNull()
    expect(parseJsonlLine(Buffer.from(midString))).toBeNull()
    expectStringBufferParity(midEscape)
  })

  it('keeps parity when a Buffer contains a truncated UTF-8 sequence', () => {
    const line = largeUserLine(jsonStringContent('亜'.repeat(12_000)))
    const encoded = Buffer.from(line)
    const characterStart = encoded.indexOf(Buffer.from('亜'))
    const truncated = Buffer.concat([encoded.subarray(0, characterStart + 1), encoded.subarray(characterStart + 3)])

    expect(parseJsonlLine(truncated)).toEqual(parseJsonlLine(truncated.toString('utf-8')))
  })

  it('keeps the string skip filter equivalent to JSON parsing', () => {
    const before = ` {"type":"user","timestamp":"2026-04-30T23:59:59Z","padding":"${LARGE_PADDING}"}`
    const after = ` {"type":"user","timestamp":"2026-05-01T00:00:01Z","padding":"${LARGE_PADDING}"}`
    const unrelated = ` {"type":"attachment","timestamp":"2026-04-30T00:00:00Z","padding":"${LARGE_PADDING}"}`
    const threshold = '2026-05-01T00:00:00Z'

    for (const [line, expected] of [[before, true], [after, false], [unrelated, false]] as const) {
      expect(parseJsonlLine(Buffer.from(line))).toEqual(parseJsonlLine(line))
      expect(shouldSkipLine(line, threshold)).toBe(expected)
    }
  })
})
