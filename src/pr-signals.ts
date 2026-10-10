// Local PR signals read from cached Bash commands and subagent descriptions.
// Only a command is cached, never its result, so a failed push or merge still
// counts.

// A description names its PR with a `PR` prefix or a /pull/N URL. A bare `#22`
// is too often an issue, a worker number, or the PR a fix grew out of.
const NAMED_PR_RE = /\bPR\s*#?(\d{1,6})\b|github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/g

export type NamedPr = { number: number; repo?: string }

/// The single PR a subagent description names, 'multi' when it names more
/// than one (or lists "PRs 1689-1692"), null when it names none.
export function namedPr(text: string): NamedPr | 'multi' | null {
  if (/\bPRs\s*#?\d/.test(text)) return 'multi'
  const numbers = new Set<number>()
  let repo: string | undefined
  for (const m of text.matchAll(NAMED_PR_RE)) {
    numbers.add(Number(m[1] ?? m[4]))
    if (m[2]) repo = `${m[2]}/${m[3]}`
  }
  if (numbers.size > 1) return 'multi'
  const [number] = numbers
  return number === undefined ? null : { number, ...(repo ? { repo } : {}) }
}

export function namedPrNumber(text: string): number | null {
  const n = namedPr(text)
  return n && n !== 'multi' ? n.number : null
}

// Command position only: `gh`/`git` inside a quoted string (a script or test
// being written) is not a command that ran.
const AT_CMD = String.raw`(?:^|[\s;&|(\`])`
const GIT = String.raw`${AT_CMD}git(?:\s+-[Cc]\s+\S+)*\s+`
const PUSH_RE = new RegExp(`${GIT}push\\b([^|;&\\n]*)`, 'g')
const COMMIT_RE = new RegExp(`${GIT}commit\\b`)
const GIT_DIFF_RE = new RegExp(`${GIT}diff\\b`)
const GH_PR_RE = new RegExp(String.raw`${AT_CMD}gh\s+pr\s+([a-z-]+)([^|;&\n]*)`, 'g')
const PR_ARG_VERBS = new Set(['view', 'diff', 'checkout', 'checks', 'merge', 'review', 'edit', 'comment', 'close', 'reopen', 'ready'])
const READ_VERBS = new Set(['view', 'diff', 'checkout', 'review'])
const PR_URL_RE = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/
const API_PR_RE = /\/pulls?\/(\d+)\b/g

const unquote = (s: string): string => s.replace(/"[^"]*"|'[^']*'/g, ' ')

export const isPush = (cmd: string): boolean => pushes(cmd).length > 0
export const isCommit = (cmd: string): boolean => cmd.includes('commit') && COMMIT_RE.test(cmd)
export const readsCode = (cmd: string): boolean => (cmd.includes('diff') && GIT_DIFF_RE.test(cmd)) || ghPrCommands(cmd).some(c => READ_VERBS.has(c.verb))

/// Each `git push` in a command line with the branches it names (the refspec
/// destination, `HEAD:fix/x` -> `fix/x`); [] for a bare `git push`. A branch
/// delete is not a push.
export function pushes(cmd: string): string[][] {
  const out: string[][] = []
  if (!cmd.includes('push')) return out
  for (const m of cmd.matchAll(PUSH_RE)) {
    const tokens = unquote(m[1]!).trim().split(/\s+/).filter(t => t && !/[<>]/.test(t))
    if (tokens.some(t => t === '--delete' || t === '-d')) continue
    const [, ...refspecs] = tokens.filter(t => !t.startsWith('-'))
    out.push(refspecs
      .map(r => r.replace(/^\+/, '').split(':').pop()!.replace(/^refs\/heads\//, ''))
      .filter(b => b && b !== 'HEAD' && !b.startsWith('$')))
  }
  return out
}

export type GhPrCommand = { verb: string; number?: number; repo?: string; args: string }

/// Every `gh pr <verb>` in a command line, with the PR it names (a number or a
/// PR URL) and its -R/--repo. Quoted text is dropped first so a body's digits
/// never read as a PR number.
export function ghPrCommands(cmd: string): GhPrCommand[] {
  const out: GhPrCommand[] = []
  if (!cmd.includes('gh pr')) return out
  for (const m of cmd.matchAll(GH_PR_RE)) {
    const args = unquote(m[2]!)
    const url = PR_URL_RE.exec(args)
    const num = PR_ARG_VERBS.has(m[1]!) ? /(?:^|\s)#?(\d{1,6})(?=\s|$)/.exec(args) : null
    const repo = url ? `${url[1]}/${url[2]}` : /(?:^|\s)(?:-R|--repo)[\s=]+([^\s/$]+\/[^\s/]+)/.exec(args)?.[1]
    const number = url ? Number(url[3]) : num ? Number(num[1]) : undefined
    out.push({ verb: m[1]!, args, ...(number !== undefined ? { number } : {}), ...(repo ? { repo } : {}) })
  }
  return out
}

/// The `--head` branch of a `gh pr create`, unless it is a shell variable.
export function createHead(args: string): string | undefined {
  const head = /(?:^|\s)(?:--head|-H)[\s=]+(\S+)/.exec(args)?.[1]
  return head && !head.startsWith('-') && !head.startsWith('$') ? head : undefined
}

/// PR numbers a command names: `gh pr <verb> N`, a PR URL, or an API path.
export function prNumbersIn(cmd: string): Set<number> {
  const out = new Set<number>()
  for (const c of ghPrCommands(cmd)) if (c.number !== undefined) out.add(c.number)
  if (!cmd.includes('/pull')) return out
  for (const m of cmd.matchAll(API_PR_RE)) out.add(Number(m[1]))
  for (const m of cmd.matchAll(new RegExp(PR_URL_RE.source, 'g'))) out.add(Number(m[3]))
  return out
}

/// PR numbers a command reads by number (gh pr view/diff/checkout/review N).
export function readPrNumbers(cmd: string): number[] {
  return ghPrCommands(cmd).filter(c => READ_VERBS.has(c.verb) && c.number !== undefined).map(c => c.number!)
}

export function reviewVerdict(args: string): 'approve' | 'request-changes' | 'comment' | 'review' {
  if (/(?:^|\s)(?:--approve|-a)\b/.test(args)) return 'approve'
  if (/(?:^|\s)(?:--request-changes|-r)\b/.test(args)) return 'request-changes'
  if (/(?:^|\s)(?:--comment|-c)\b/.test(args)) return 'comment'
  return 'review'
}

export const FOLLOW_UP_GAP_MS = 10 * 60 * 1000

/// Start of each follow-up round: pushes more than 10 minutes apart start a new one.
export function roundStarts(pushMs: number[]): number[] {
  const out: number[] = []
  let last = -Infinity
  for (const ms of [...pushMs].sort((a, b) => a - b)) {
    if (ms - last > FOLLOW_UP_GAP_MS) out.push(ms)
    last = ms
  }
  return out
}

export const rounds = (pushMs: number[]): number => roundStarts(pushMs).length

export function callCommands(call: { toolSequence?: Array<Array<{ command?: string }>> }): string[] {
  const out: string[] = []
  for (const step of call.toolSequence ?? []) for (const t of step) if (t.command) out.push(t.command)
  return out
}
