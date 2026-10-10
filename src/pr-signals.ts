// A subagent description names its PR with a `PR` prefix or a /pull/N URL.
// A bare `#22` is too often an issue or a worker number to count.
const NAMED_PR_RE = /\bPR\s*#?(\d{1,6})\b|github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/g

export type NamedPr = { number: number; repo?: string }

/// The single PR a subagent description names, 'multi' when it names more than one
/// (or lists "PRs 1689-1692"), null when it names none.
export function namedPr(prompt: string): NamedPr | 'multi' | null {
  if (/\bPRs\s*#?\d/.test(prompt)) return 'multi'
  const numbers = new Set<number>()
  let repo: string | undefined
  for (const m of prompt.matchAll(NAMED_PR_RE)) {
    numbers.add(Number(m[1] ?? m[4]))
    if (m[2]) repo = `${m[2]}/${m[3]}`
  }
  if (numbers.size > 1) return 'multi'
  const [number] = numbers
  return number === undefined ? null : { number, ...(repo ? { repo } : {}) }
}
