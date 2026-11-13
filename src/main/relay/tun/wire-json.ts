export const tunHostFrameByteLimit = 8192
export const tunHostJSONDepthLimit = 16

// JSON.parse alone silently accepts repeated fields. Scan the JSON grammar
// before decoding so every object rejects duplicate decoded keys, including
// aliases written with Unicode escapes. No configuration content enters errors.
export function parseTunHostFrame(bytes: Uint8Array, byteLimit = tunHostFrameByteLimit): unknown {
  const invalid = (): Error => new Error('TUN宿主JSON帧无效。')
  if (
    !Number.isSafeInteger(byteLimit) ||
    byteLimit < 1 ||
    byteLimit > 2 * 1024 * 1024 + tunHostFrameByteLimit ||
    !bytes.byteLength ||
    bytes.byteLength > byteLimit
  )
    throw invalid()
  let text: string
  try {
    // Keep a leading BOM visible to the grammar instead of silently stripping
    // it; frames must contain strict UTF-8 JSON bytes.
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw invalid()
  }
  let position = 0
  const space = (): void => {
    while ([' ', '\t', '\r', '\n'].includes(text[position])) ++position
  }
  const digit = (value: string): boolean => value >= '0' && value <= '9'
  const string = (): string => {
    const start = position
    if (text[position++] !== '"') throw invalid()
    while (position < text.length) {
      const character = text[position++]
      if (character === '"') return JSON.parse(text.slice(start, position)) as string
      if (character.charCodeAt(0) < 0x20) throw invalid()
      if (character !== '\\') continue
      const escaped = text[position++]
      if (escaped === 'u') {
        if (!/^[a-fA-F0-9]{4}$/u.test(text.slice(position, position + 4))) throw invalid()
        position += 4
      } else if (!['"', '\\', '/', 'b', 'f', 'n', 'r', 't'].includes(escaped)) throw invalid()
    }
    throw invalid()
  }
  const number = (): void => {
    if (text[position] === '-') ++position
    if (text[position] === '0') ++position
    else {
      if (text[position] < '1' || text[position] > '9' || position >= text.length) throw invalid()
      do ++position
      while (digit(text[position]))
    }
    if (text[position] === '.') {
      ++position
      if (!digit(text[position])) throw invalid()
      while (digit(text[position])) ++position
    }
    if (text[position] === 'e' || text[position] === 'E') {
      ++position
      if (text[position] === '+' || text[position] === '-') ++position
      if (!digit(text[position])) throw invalid()
      while (digit(text[position])) ++position
    }
  }
  const literal = (value: string): void => {
    if (text.slice(position, position + value.length) !== value) throw invalid()
    position += value.length
  }
  const value = (depth: number): void => {
    space()
    const marker = text[position]
    if (marker === '"') {
      string()
      return
    }
    if (marker === 't' || marker === 'f' || marker === 'n') {
      literal(marker === 't' ? 'true' : marker === 'f' ? 'false' : 'null')
      return
    }
    if (marker !== '{' && marker !== '[') {
      number()
      return
    }
    if (depth >= tunHostJSONDepthLimit) throw invalid()
    ++position
    space()
    const end = marker === '{' ? '}' : ']'
    if (text[position] === end) {
      ++position
      return
    }
    const keys = new Set<string>()
    while (true) {
      if (marker === '{') {
        space()
        const key = string()
        if (keys.has(key)) throw invalid()
        keys.add(key)
        space()
        if (text[position++] !== ':') throw invalid()
      }
      value(depth + 1)
      space()
      if (text[position] === end) {
        ++position
        return
      }
      if (text[position++] !== ',') throw invalid()
    }
  }
  try {
    value(0)
    space()
    if (position !== text.length) throw invalid()
    return JSON.parse(text) as unknown
  } catch {
    throw invalid()
  }
}
