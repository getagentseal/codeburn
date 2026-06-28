// ============================================================================
// Display constants
// ============================================================================

export const ORANGE = '#FF8C42'
export const DIM = '#666666'
export const GOLD = '#FFD700'
export const CYAN = '#5BF5E0'
export const GREEN = '#5BF5A0'
export const RED = '#F55B5B'

// ============================================================================
// Token estimation constants
// ============================================================================

export const AVG_TOKENS_PER_READ = 600
export const TOKENS_PER_MCP_TOOL = 400
export const TOOLS_PER_MCP_SERVER = 5
export const TOKENS_PER_AGENT_DEF = 80
export const TOKENS_PER_SKILL_DEF = 80
export const TOKENS_PER_COMMAND_DEF = 60
export const CLAUDEMD_TOKENS_PER_LINE = 13
export const BASH_TOKENS_PER_CHAR = 0.25

// ============================================================================
// Detector thresholds
// ============================================================================

export const CLAUDEMD_HEALTHY_LINES = 200
export const CLAUDEMD_HIGH_THRESHOLD_LINES = 400
export const MIN_JUNK_READS_TO_FLAG = 3
export const JUNK_READS_HIGH_THRESHOLD = 20
export const JUNK_READS_MEDIUM_THRESHOLD = 5
export const MIN_DUPLICATE_READS_TO_FLAG = 5
export const DUPLICATE_READS_HIGH_THRESHOLD = 30
export const DUPLICATE_READS_MEDIUM_THRESHOLD = 10
export const MIN_EDITS_FOR_RATIO = 10
export const HEALTHY_READ_EDIT_RATIO = 4
export const LOW_RATIO_HIGH_THRESHOLD = 2
export const LOW_RATIO_MEDIUM_THRESHOLD = 3
export const MIN_API_CALLS_FOR_CACHE = 10
export const CACHE_EXCESS_HIGH_THRESHOLD = 15000
export const UNUSED_MCP_HIGH_THRESHOLD = 3
// MCP tool coverage detector thresholds. A server only earns a finding when
// every condition holds: the inventory is large enough to matter, real-world
// usage is poor, and we observed it in enough sessions to trust the signal.
export const MCP_COVERAGE_MIN_TOOLS = 10
export const MCP_COVERAGE_MIN_SESSIONS = 2
export const MCP_COVERAGE_LOW_THRESHOLD = 0.20
export const MCP_COVERAGE_HIGH_IMPACT_TOKENS = 200_000
// Anthropic prices cache writes at 125% of base input and cache reads at
// roughly 10% of base input. We use these to keep overhead estimates honest:
// most MCP schema bytes live in the cached prefix and only get charged at
// the discount rate after the first turn of a session.
export const CACHE_WRITE_MULTIPLIER = 1.25
export const CACHE_READ_DISCOUNT = 0.10
export const GHOST_AGENTS_HIGH_THRESHOLD = 5
export const GHOST_AGENTS_MEDIUM_THRESHOLD = 2
export const GHOST_SKILLS_HIGH_THRESHOLD = 10
export const GHOST_SKILLS_MEDIUM_THRESHOLD = 5
export const GHOST_COMMANDS_MEDIUM_THRESHOLD = 10
export const MCP_NEW_CONFIG_GRACE_MS = 24 * 60 * 60 * 1000
export const BASH_DEFAULT_LIMIT = 30000
export const BASH_RECOMMENDED_LIMIT = 15000
export const MIN_SESSIONS_FOR_OUTLIER = 3
export const SESSION_OUTLIER_MULTIPLIER = 2
export const MIN_SESSION_OUTLIER_COST_USD = 1
export const SESSION_OUTLIER_PREVIEW = 5
export const CONTEXT_BLOAT_MIN_INPUT_TOKENS = 75_000
export const CONTEXT_BLOAT_MIN_RATIO = 25
export const CONTEXT_BLOAT_TARGET_RATIO = 15
export const CONTEXT_BLOAT_PREVIEW = 5
export const CONTEXT_BLOAT_LOW_INPUT_TOKENS = 200_000
export const CONTEXT_BLOAT_HIGH_INPUT_TOKENS = 500_000
export const CONTEXT_BLOAT_LOW_MAX_CANDIDATES = 2
export const CONTEXT_BLOAT_HIGH_MIN_CANDIDATES = 10
export const CONTEXT_BLOAT_GROWTH_RATIO = 2
export const CONTEXT_BLOAT_GROWTH_MAX_GAP_MS = 7 * 24 * 60 * 60 * 1000
export const CONTEXT_BLOAT_RATIO_DISPLAY_CAP = 1000
export const WORTH_IT_MIN_COST_USD = 2
export const WORTH_IT_NO_EDIT_MIN_COST_USD = 3
export const WORTH_IT_MIN_RETRIES = 3
export const WORTH_IT_RETRY_WITH_EDIT_MIN_RETRIES = 2
export const WORTH_IT_PREVIEW = 5
export const WORTH_IT_LOW_MAX_CANDIDATES = 2
export const WORTH_IT_LOW_MAX_TOTAL_COST_USD = 10
export const WORTH_IT_HIGH_MIN_CANDIDATES = 10
export const WORTH_IT_HIGH_TOTAL_COST_USD = 50

// ============================================================================
// Scoring constants
// ============================================================================

export const HEALTH_WEIGHT_HIGH = 15
export const HEALTH_WEIGHT_MEDIUM = 7
export const HEALTH_WEIGHT_LOW = 3
export const HEALTH_MAX_PENALTY = 80
export const GRADE_A_MIN = 90
export const GRADE_B_MIN = 75
export const GRADE_C_MIN = 55
export const GRADE_D_MIN = 30
// Rebalanced so a high-impact finding with zero observed tokens (e.g.
// detectGhostAgents firing on five files but tokensSaved=400) cannot
// outrank a medium-impact finding with many millions of tokens.
// Old: 0.7/0.3 → high+0 = 0.70, medium+1B = 0.65 (high+0 won).
// New: 0.5/0.5 → high+0 = 0.50, medium+1B = 0.75 (medium+1B wins).
// Token normalize lifted to 5M so the rank scales over a realistic range.
export const URGENCY_IMPACT_WEIGHT = 0.5
export const URGENCY_TOKEN_WEIGHT = 0.5
export const URGENCY_TOKEN_NORMALIZE = 5_000_000

// ============================================================================
// File system constants
// ============================================================================

export const MAX_IMPORT_DEPTH = 5
export const IMPORT_PATTERN = /^@(\.\.?\/[^\s]+|\/[^\s]+)/gm
export const COMMAND_PATTERN = /<command-name>([^<]+)<\/command-name>|(?:^|\s)\/([a-zA-Z][\w-]*)/gm

export const JUNK_DIRS = [
  'node_modules', '.git', 'dist', 'build', '__pycache__', '.next',
  '.nuxt', '.output', 'coverage', '.cache', '.tsbuildinfo',
  '.venv', 'venv', '.svn', '.hg',
]
export const JUNK_PATTERN = new RegExp(`/(?:${JUNK_DIRS.join('|')})/`)

export const SHELL_PROFILES = ['.zshrc', '.bashrc', '.bash_profile', '.profile']

export const TOP_ITEMS_PREVIEW = 3
export const GHOST_NAMES_PREVIEW = 5
export const GHOST_CLEANUP_COMMANDS_LIMIT = 10

// ============================================================================
// JSONL scanner
// ============================================================================

export const FILE_READ_CONCURRENCY = 16
export const RESULT_CACHE_TTL_MS = 60_000
export const RECENT_WINDOW_HOURS = 48
export const RECENT_WINDOW_MS = RECENT_WINDOW_HOURS * 60 * 60 * 1000
export const DEFAULT_TREND_PERIOD_DAYS = 30
export const DEFAULT_TREND_PERIOD_MS = DEFAULT_TREND_PERIOD_DAYS * 24 * 60 * 60 * 1000
export const IMPROVING_THRESHOLD = 0.5

// ============================================================================
// Cache bloat detector constants
// ============================================================================

export const DEFAULT_CACHE_BASELINE_TOKENS = 50_000
export const CACHE_BASELINE_QUANTILE = 0.25
export const CACHE_BLOAT_MULTIPLIER = 1.4
export const CACHE_VERSION_MIN_SAMPLES = 5
export const CACHE_VERSION_DIFF_THRESHOLD = 10_000

// ============================================================================
// Read/edit tool name sets
// ============================================================================

export const READ_TOOL_NAMES = new Set(['Read', 'Grep', 'Glob', 'FileReadTool', 'GrepTool', 'GlobTool'])
export const EDIT_TOOL_NAMES = new Set(['Edit', 'Write', 'FileEditTool', 'FileWriteTool', 'NotebookEdit'])

// ============================================================================
// Worth-it / low-worth-session detector helpers
// ============================================================================

// Use (\s|$|--) instead of \b after commit/push so `git commit-tree` and
// `git commit-graph` are not treated as deliveries. The `--` clause keeps
// `git commit --amend` matching as a real delivery command.
export const DELIVERY_COMMAND_PATTERNS = [
  /(?:^|[;&|]\s*)git\s+(?:commit|push)(?=\s|$|--)(?![^;&|]*--dry-run)/,
  /(?:^|[;&|]\s*)gh\s+pr\s+(?:create|merge)(?=\s|$|--)(?![^;&|]*--dry-run)/,
]

// ============================================================================
// Cost estimation
// ============================================================================

export const INPUT_COST_RATIO = 0.7
export const DEFAULT_COST_PER_TOKEN = 0

// ============================================================================
// CLI rendering
// ============================================================================

export const PANEL_WIDTH = 62
export const SEP = '\u2500'
