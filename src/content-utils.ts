/// Normalize a message's `content` into an array of content blocks.
///
/// Most agent session formats write `content` as an array of typed blocks
/// (`{ type: 'text' | 'tool_use' | ... }`), and the parsers filter over that
/// array. But some agents (Pi, and others for programmatically injected turns)
/// legitimately write `content` as a plain **string**. A raw string reaching
/// `.filter`/`.some` throws a TypeError mid-parse — and because the 365-day
/// daily-cache backfill swallows parse errors, that single bad record silently
/// wipes the entire trend/history (issue #441).
///
/// This coerces defensively: arrays pass through, a string becomes one text
/// block, and anything else (null/undefined/number/object) becomes empty.
export function normalizeContentBlocks<T extends { type?: string; text?: string }>(
  content: T[] | string | null | undefined,
): T[] {
  if (Array.isArray(content)) {
    // A clean array (the overwhelming common case) is returned by reference — no
    // copy. Only when an element is a non-object (null/undefined/primitive) do we
    // filter, since the call sites read `.type` on each element and a null would
    // throw — the same crash class this helper exists to prevent, one level down.
    const isBlock = (b: T): boolean => b != null && typeof b === 'object'
    return content.every(isBlock) ? content : content.filter(isBlock)
  }
  if (typeof content === 'string') return [{ type: 'text', text: content } as T]
  return []
}
