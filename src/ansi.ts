/// Removes ANSI escape sequences from strings sourced from session JSONL before they're
/// rendered by the dashboard / CLI / JSON export. The regex below covers CSI (`ESC [`),
/// OSC (`ESC ]`), and other 7-bit / 8-bit control sequences as defined by ECMA-48 — same
/// shape used by the well-known `ansi-regex` package, kept inline here to avoid a direct
/// dependency. Any non-string input is passed through unchanged.

const ANSI_PATTERN = new RegExp(
  [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-ntqry=><~]))',
  ].join('|'),
  'g',
)

export function stripAnsi(input: string): string {
  return input.replace(ANSI_PATTERN, '')
}
