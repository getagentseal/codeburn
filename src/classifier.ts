import type { ClassifiedTurn, ParsedTurn, TaskCategory } from './types.js'

const TEST_PATTERNS = /\b(test|pytest|vitest|jest|mocha|spec|coverage|npm\s+test|npx\s+vitest|npx\s+jest)\b/i
const GIT_PATTERNS = /\bgit\s+(push|pull|commit|merge|rebase|checkout|branch|stash|log|diff|status|add|reset|cherry-pick|tag)\b/i
const BUILD_PATTERNS = /\b(npm\s+run\s+build|npm\s+publish|pip\s+install|docker|deploy|make\s+build|npm\s+run\s+dev|npm\s+start|pm2|systemctl|brew|cargo\s+build)\b/i
const INSTALL_PATTERNS = /\b(npm\s+install|pip\s+install|brew\s+install|apt\s+install|cargo\s+add)\b/i

const DEBUG_KEYWORDS = /\b(fix|bug|error|broken|failing|crash|issue|debug|traceback|exception|stack\s*trace|not\s+working|wrong|unexpected|status\s+code|404|500|401|403)\b/i
const FEATURE_KEYWORDS = /\b(add|create|implement|new|build|feature|introduce|set\s*up|scaffold|generate|make\s+(?:a|me|the)|write\s+(?:a|me|the))\b/i
const REFACTOR_KEYWORDS = /\b(refactor|clean\s*up|rename|reorganize|simplify|extract|restructure|move|migrate|split)\b/i
const BRAINSTORM_KEYWORDS = /\b(brainstorm|idea|what\s+if|explore|think\s+about|approach|strategy|design|consider|how\s+should|what\s+would|opinion|suggest|recommend)\b/i
const RESEARCH_KEYWORDS = /\b(research|investigate|look\s+into|find\s+out|check|search|analyze|review|understand|explain|how\s+does|what\s+is|show\s+me|list|compare)\b/i

const FILE_PATTERNS = /\.(py|js|ts|tsx|jsx|json|yaml|yml|toml|sql|sh|go|rs|java|rb|php|css|html|md|csv|xml)\b/i
const SCRIPT_PATTERNS = /\b(run\s+\S+\.\w+|execute|scrip?t|curl|api\s+\S+|endpoint|request\s+url|fetch\s+\S+|query|database|db\s+\S+)\b/i
const URL_PATTERN = /https?:\/\/\S+/i

const EDIT_TOOLS = new Set(['Edit', 'Write', 'FileEditTool', 'FileWriteTool', 'NotebookEdit', 'cursor:edit'])
const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'FileReadTool', 'GrepTool', 'GlobTool'])
export const BASH_TOOLS = new Set(['Bash', 'BashTool', 'PowerShellTool'])
const TASK_TOOLS = new Set(['TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskStop', 'TodoWrite'])
const SEARCH_TOOLS = new Set(['WebSearch', 'WebFetch', 'ToolSearch'])

function hasEditTools(tools: string[]): boolean {
  return tools.some(t => EDIT_TOOLS.has(t))
}

function hasReadTools(tools: string[]): boolean {
  return tools.some(t => READ_TOOLS.has(t))
}

function hasBashTool(tools: string[]): boolean {
  return tools.some(t => BASH_TOOLS.has(t))
}

function hasTaskTools(tools: string[]): boolean {
  return tools.some(t => TASK_TOOLS.has(t))
}

function hasSearchTools(tools: string[]): boolean {
  return tools.some(t => SEARCH_TOOLS.has(t))
}

function hasMcpTools(tools: string[]): boolean {
  return tools.some(t => t.startsWith('mcp__'))
}

function hasSkillTool(tools: string[]): boolean {
  return tools.some(t => t === 'Skill')
}

function getAllTools(turn: ParsedTurn): string[] {
  return turn.assistantCalls.flatMap(c => c.tools)
}

function getAllSkills(turn: ParsedTurn): string[] {
  return turn.assistantCalls.flatMap(c => c.skills ?? [])
}

function classifyByToolPattern(turn: ParsedTurn): TaskCategory | null {
  const tools = getAllTools(turn)
  if (tools.length === 0) return null

  if (turn.assistantCalls.some(c => c.hasPlanMode)) return 'planning'
  if (turn.assistantCalls.some(c => c.hasAgentSpawn)) return 'delegation'

  const hasEdits = hasEditTools(tools)
  const hasReads = hasReadTools(tools)
  const hasBash = hasBashTool(tools)
  const hasTasks = hasTaskTools(tools)
  const hasSearch = hasSearchTools(tools)
  const hasMcp = hasMcpTools(tools)
  const hasSkill = hasSkillTool(tools)

  if (hasBash && !hasEdits) {
    const userMsg = turn.userMessage
    if (TEST_PATTERNS.test(userMsg)) return 'testing'
    if (GIT_PATTERNS.test(userMsg)) return 'git'
    if (BUILD_PATTERNS.test(userMsg)) return 'build/deploy'
    if (INSTALL_PATTERNS.test(userMsg)) return 'build/deploy'
  }

  if (hasEdits) return 'coding'

  if (hasBash && hasReads) return 'exploration'
  if (hasBash) return 'coding'

  if (hasSearch || hasMcp) return 'exploration'
  if (hasReads && !hasEdits) return 'exploration'
  if (hasTasks && !hasEdits) return 'planning'
  if (hasSkill) return 'general'

  return null
}

/// Picks the category whose keyword pattern matches earliest in the message.
/// On a tie (same start index) the candidate listed first in `candidates` wins,
/// so callers control tie-break priority by ordering. Returns null when no
/// pattern matches. The first-match heuristic fixes the long-standing problem
/// where "add error handling" was tagged Debugging because the DEBUG regex was
/// checked before FEATURE; now FEATURE wins because "add" appears before
/// "error". Issue #196.
function firstMatchingCategory(
  text: string,
  candidates: ReadonlyArray<{ regex: RegExp; category: TaskCategory }>,
): TaskCategory | null {
  let best: { index: number; order: number; category: TaskCategory } | null = null
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]!
    const m = c.regex.exec(text)
    if (!m) continue
    if (!best || m.index < best.index || (m.index === best.index && i < best.order)) {
      best = { index: m.index, order: i, category: c.category }
    }
  }
  return best?.category ?? null
}

function refineByKeywords(category: TaskCategory, userMessage: string): TaskCategory {
  if (category === 'coding') {
    // Tie-break order (when two keywords match at the same index): refactoring
    // first because its words are the most specific, then feature, then debug.
    return firstMatchingCategory(userMessage, [
      { regex: REFACTOR_KEYWORDS, category: 'refactoring' },
      { regex: FEATURE_KEYWORDS, category: 'feature' },
      { regex: DEBUG_KEYWORDS, category: 'debugging' },
    ]) ?? 'coding'
  }

  if (category === 'exploration') {
    if (RESEARCH_KEYWORDS.test(userMessage)) return 'exploration'
    if (DEBUG_KEYWORDS.test(userMessage)) return 'debugging'
    return 'exploration'
  }

  return category
}

function classifyConversation(userMessage: string): TaskCategory {
  if (BRAINSTORM_KEYWORDS.test(userMessage)) return 'brainstorming'
  if (RESEARCH_KEYWORDS.test(userMessage)) return 'exploration'
  // Same first-match-wins logic as refineByKeywords so a chat-only message
  // starting with a feature verb does not flip to debugging because of an
  // incidental "error" or "fix" word later in the same sentence.
  const debugOrFeature = firstMatchingCategory(userMessage, [
    { regex: FEATURE_KEYWORDS, category: 'feature' },
    { regex: DEBUG_KEYWORDS, category: 'debugging' },
  ])
  if (debugOrFeature) return debugOrFeature
  if (FILE_PATTERNS.test(userMessage)) return 'coding'
  if (SCRIPT_PATTERNS.test(userMessage)) return 'coding'
  if (URL_PATTERN.test(userMessage)) return 'exploration'
  return 'conversation'
}

function countRetries(turn: ParsedTurn): number {
  let sawEditBeforeBash = false
  let sawBashAfterEdit = false
  let retries = 0

  for (const call of turn.assistantCalls) {
    const hasEdit = call.tools.some(t => EDIT_TOOLS.has(t))
    const hasBash = call.tools.some(t => BASH_TOOLS.has(t))

    if (hasEdit) {
      if (sawBashAfterEdit) retries++
      sawEditBeforeBash = true
      sawBashAfterEdit = false
    }
    if (hasBash && sawEditBeforeBash) {
      sawBashAfterEdit = true
    }
  }

  return retries
}

function turnHasEdits(turn: ParsedTurn): boolean {
  return turn.assistantCalls.some(c => c.tools.some(t => EDIT_TOOLS.has(t)))
}

export function classifyTurn(turn: ParsedTurn): ClassifiedTurn {
  const tools = getAllTools(turn)

  let category: TaskCategory

  if (tools.length === 0) {
    category = classifyConversation(turn.userMessage)
  } else {
    const toolCategory = classifyByToolPattern(turn)
    if (toolCategory) {
      category = refineByKeywords(toolCategory, turn.userMessage)
    } else {
      category = classifyConversation(turn.userMessage)
    }
  }

  const result: ClassifiedTurn = { ...turn, category, retries: countRetries(turn), hasEdits: turnHasEdits(turn) }

  if (category === 'general') {
    const skills = getAllSkills(turn)
    if (skills.length > 0) result.subCategory = skills[0]
  }

  return result
}
