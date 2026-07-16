export const CHARS_PER_TOKEN = 4

export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}
