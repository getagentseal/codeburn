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

/// Take a bounded prefix of a string as a FLAT copy.
///
/// `String.prototype.slice` returns a V8 SlicedString — a view object that
/// retains a reference to its ENTIRE parent string. Session files routinely
/// carry 100KB+ message strings (agent-injected system prompts, tool
/// results); storing a short `.slice()` of each in a long-lived structure
/// (the session cache) pins every parent buffer for the life of the process.
/// Across thousands of session files this balloons a cold parse of a few GB
/// of JSONL into an out-of-memory crash (~5.5GB peak observed), while a warm
/// run — whose strings were flattened by the cache's JSON round-trip — needs
/// only ~300MB for the same data.
///
/// Round-tripping through a Buffer forces a fresh flat string with no parent
/// reference. This always runs, even when `s` is already within `max`:
/// callers may pass an already-sliced view (provider adapters pre-truncate
/// with `.slice(0, 500)` before the cache-site call), and that view is
/// itself a SlicedString pinning its own large parent.
export function flatSlice(s: string, max: number): string {
  return Buffer.from(s.slice(0, max), 'utf16le').toString('utf16le')
}

/// Force a FLAT copy of a string regardless of length.
///
/// Companion to `flatSlice` for strings that are ALREADY short but were
/// produced as views over a large parent — regex match groups
/// (`match[1]` retains the entire subject string) and `trim()` results
/// both come back as V8 SlicedStrings. Use this when storing such values
/// in long-lived structures; use `flatSlice` when also bounding length.
export function flatString(s: string): string {
  return Buffer.from(s, 'utf16le').toString('utf16le')
}
 /// Flatten every string token in a decoded JSON graph IN PLACE (see
 /// `flatString`, including object keys) and return the same graph.
 ///
 /// The streaming decoders hand values whose strings are slices of
 /// multi-hundred-MB input chunks; structures memoized long-term must not pin
 /// those chunks. The decoded graph is decoder-owned (fresh containers per
 /// record, discarded by the pipeline after the callback), so mutating it is
 /// safe — and unlike a deep copy it adds no parallel-graph transient.
 /// Re-keying deletes and re-inserts every key in snapshot order, so relative
 /// key order is unchanged; duplicate-flattened keys cannot occur (object
 /// keys are already unique by content).
 export function flattenJsonStrings<T>(value: T): T {
   if (Array.isArray(value)) {
     for (let i = 0; i < value.length; i++) {
       const element: unknown = value[i]
       value[i] = typeof element === 'string' ? flatString(element) : flattenJsonStrings(element)
     }
     return value
   }
   if (value !== null && typeof value === 'object') {
     const record = value as Record<string, unknown>
     for (const key of Object.keys(record)) {
       const field: unknown = record[key]
       const flatField = typeof field === 'string' ? flatString(field) : flattenJsonStrings(field)
       const flatKey = flatString(key)
       delete record[key]
       // `__proto__` assignment would invoke the prototype setter (losing the
       // own key and changing the prototype); valid JSON can carry it as an
       // own key (JSON.parse preserves it), so reinsert declaratively.
       if (flatKey === '__proto__') {
         Object.defineProperty(record, '__proto__', {
           value: flatField,
           enumerable: true,
           writable: true,
           configurable: true,
         })
       } else {
         record[flatKey] = flatField
       }
     }
     return value
   }
   return typeof value === 'string' ? (flatString(value) as T) : value
 }
