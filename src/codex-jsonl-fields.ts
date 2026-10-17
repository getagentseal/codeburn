export type RawJsonFieldBounds = { keyStart: number; valueStart: number }

/** Find a direct property in a JSON object without decoding its values. */
export function findRawObjectField(source: Buffer, objectStart: number, field: string): RawJsonFieldBounds | undefined {
  const fieldBytes = Buffer.from(field, 'utf-8')
  let depth = 0
  let rootStarted = false
  let inString = false
  let escaped = false
  for (let i = objectStart; i < source.length; i++) {
    const byte = source[i]!
    if (!rootStarted) {
      if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue
      if (byte !== 0x7b) return undefined // {
      rootStarted = true
      depth = 1
      continue
    }
    if (inString) {
      if (escaped) escaped = false
      else if (byte === 0x5c) escaped = true // \\
      else if (byte === 0x22) inString = false // "
      continue
    }
    if (byte === 0x22) {
      const keyStart = i + 1
      let keyEnd = keyStart
      let keyEscaped = false
      for (; keyEnd < source.length; keyEnd++) {
        const keyByte = source[keyEnd]!
        if (keyEscaped) { keyEscaped = false; continue }
        if (keyByte === 0x5c) { keyEscaped = true; continue }
        if (keyByte === 0x22) break
      }
      if (depth === 1 && keyEnd < source.length) {
        // Most strings at depth 1 are values, including potentially huge
        // image results. Check the key/value delimiter and exact short-key
        // length before comparing bytes so scanning never materializes them.
        let colon = keyEnd + 1
        while (colon < source.length && (source[colon] === 0x20 || source[colon] === 0x09 || source[colon] === 0x0a || source[colon] === 0x0d)) colon++
        if (source[colon] === 0x3a && keyEnd - keyStart === fieldBytes.length && source.subarray(keyStart, keyEnd).equals(fieldBytes)) {
          let valueStart = colon + 1
          while (valueStart < source.length && (source[valueStart] === 0x20 || source[valueStart] === 0x09 || source[valueStart] === 0x0a || source[valueStart] === 0x0d)) valueStart++
          return { keyStart: i, valueStart }
        }
      }
      i = keyEnd
      inString = false
      continue
    }
    if (byte === 0x7b || byte === 0x5b) depth++ // { or [
    else if (byte === 0x7d || byte === 0x5d) depth-- // } or ]
    if (depth <= 0) break
  }
  return undefined
}

export function getRawObjectFieldWindow(source: Buffer, objectStart: number, field: string, windowBytes = 4096): string | undefined {
  const bounds = findRawObjectField(source, objectStart, field)
  return bounds ? source.subarray(bounds.keyStart, Math.min(source.length, bounds.keyStart + windowBytes)).toString('utf-8') : undefined
}

/** Read a short direct string property while bounding how much is decoded. */
export function getRawJsonStringFieldAtObject(source: Buffer, objectStart: number, field: string, maxBytes = 4096): string | undefined {
  const bounds = findRawObjectField(source, objectStart, field)
  if (!bounds || source[bounds.valueStart] !== 0x22) return undefined

  let escaped = false
  const valueEndLimit = Math.min(source.length, bounds.valueStart + maxBytes + 1)
  for (let i = bounds.valueStart + 1; i < valueEndLimit; i++) {
    const byte = source[i]!
    if (escaped) escaped = false
    else if (byte === 0x5c) escaped = true
    else if (byte === 0x22) {
      try {
        return JSON.parse(source.subarray(bounds.valueStart, i + 1).toString('utf-8')) as string
      } catch {
        return undefined
      }
    }
  }
  return undefined
}
