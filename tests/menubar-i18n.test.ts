import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { applyLanguage, formatTemplate, normalizeLocale, t } from '../windows/src/i18n/index'

function parseStrings(file: string): Record<string, string> {
  const text = readFileSync(file, 'utf8')
  const map: Record<string, string> = {}
  const re = /"((?:\\.|[^"\\])*)"\s*=\s*"((?:\\.|[^"\\])*)"\s*;/g
  const unescape = (s: string) => s.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  let match: RegExpExecArray | null
  while ((match = re.exec(text))) map[unescape(match[1]!)] = unescape(match[2]!)
  return map
}

describe('menubar locale', () => {
  it('maps Chinese OS tags the way the macOS app does', () => {
    expect(normalizeLocale('zh-CN')).toBe('zh-Hans')
    expect(normalizeLocale('zh_TW.UTF-8')).toBe('zh-Hant')
    expect(normalizeLocale('zh-HK')).toBe('zh-Hant')
    expect(normalizeLocale('fr-CA')).toBe('fr')
    expect(normalizeLocale('de-DE')).toBeNull()
  })

  it('fills positional and sequential placeholders', () => {
    expect(formatTemplate('%1$@ · %2$lld', ['今天', 2])).toBe('今天 · 2')
    expect(formatTemplate('%lld sessions', [3])).toBe('3 sessions')
    expect(formatTemplate('100%%', [])).toBe('100%')
  })

  it('renders the popover in simplified Chinese', () => {
    applyLanguage('zh-Hans', 'en-US')
    expect(t('Your AI Bill, Itemized')).toBe('你的 AI 账单，逐项明细')
    expect(t('Open Full Report')).toBe('打开完整报告')
    expect(t('Today')).toBe('今天')
    expect(t('%lld sessions', 3)).toBe('3 个会话')
    applyLanguage('en', 'en-US')
    expect(t('Open Full Report')).toBe('Open Full Report')
  })

  it('keeps the generated mac catalog in step with Localizable.strings', () => {
    const generated = JSON.parse(readFileSync('windows/src/i18n/mac-catalog.json', 'utf8')) as Record<string, Record<string, string>>
    const zh = parseStrings('mac/Sources/CodeBurnMenubar/Resources/zh-Hans.lproj/Localizable.strings')
    expect(generated['zh-Hans']).toEqual(zh)
  })
})
