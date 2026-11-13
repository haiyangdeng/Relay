import { describe, expect, it } from 'vitest'
import { parseTunHostFrame, tunHostFrameByteLimit, tunHostJSONDepthLimit } from './wire-json'

const parse = (text: string): unknown => parseTunHostFrame(Buffer.from(text))

describe('TUN bounded strict JSON frames', () => {
  it('decodes strict JSON and compares decoded keys within each object only', () => {
    const text =
      ' { "a": [true, false, null, -12.5e+2, {"b":"quote \\" / \\\\ \\u4e2d"}], "c":{"b":0} } '
    expect(parse(text)).toEqual(JSON.parse(text))
    expect(parse('{"x":{"name":1},"y":{"name":2}}')).toEqual({
      x: { name: 1 },
      y: { name: 2 }
    })
    expect(parse('{"__proto__":1,"constructor":2,"toString":3}')).toEqual(
      JSON.parse('{"__proto__":1,"constructor":2,"toString":3}')
    )
  })

  it.each([
    '{"id":1,"id":2}',
    '{"id":1,"\\u0069d":2}',
    '{"outer":{"version":1,"version":1}}',
    '[{"x":1,"x":2}]',
    '{"x":[{"id":1,"\\u0069\\u0064":2}]}',
    '{"中":1,"\\u4e2d":2}',
    '{"😀":1,"\\ud83d\\ude00":2}',
    '{"a\\nb":1,"a\\u000ab":2}',
    '{"__proto__":1,"__proto__":2}'
  ])('rejects duplicate decoded keys at every depth: %s', (text) => {
    expect(() => parse(text)).toThrow('JSON帧无效')
  })

  it('does not confuse key-like content, escaped slashes or distinct Unicode keys', () => {
    const object = {
      a: '"id":1,"id":2',
      'a/b': 1,
      'a\\b': 2,
      é: 3,
      'e\u0301': 4
    }
    expect(parse(JSON.stringify(object))).toEqual(object)
    expect(parse('{"a/b":1,"a\\/c":2}')).toEqual({ 'a/b': 1, 'a/c': 2 })
  })

  it.each([
    '',
    ' ',
    '{',
    '[',
    '{"a":}',
    '{"a":1,}',
    '[1,]',
    '{a:1}',
    "{'a':1}",
    '{"a" 1}',
    '{"a":1 "b":2}',
    '[true false]',
    '{}{}',
    'null false',
    'undefined',
    'NaN',
    'Infinity',
    '-Infinity',
    '+1',
    '01',
    '-01',
    '1.',
    '.1',
    '1e',
    '1e+',
    '-',
    '0x10',
    '"unterminated',
    '"\\x41"',
    '"\\u123"',
    '"\\u12g4"',
    '"raw\nnewline"',
    '"raw\tcontrol"',
    '\u000b{}',
    '\ufeff{}',
    '//comment\n{}',
    '{"a":/*comment*/1}'
  ])('rejects malformed or non-JSON input %#', (text) => {
    expect(() => parse(text)).toThrow('JSON帧无效')
  })

  it('allows JSON numeric grammar and literals without accepting trailing tokens', () => {
    for (const text of ['0', '-0', '1', '-1', '1.25', '-1E-2', '0e+10', 'true', 'false', 'null'])
      expect(parse(text)).toEqual(JSON.parse(text))
  })

  it('uses the byte limit for multibyte input and accepts an exact limit frame', () => {
    expect(parse('"' + 'a'.repeat(tunHostFrameByteLimit - 2) + '"')).toHaveLength(
      tunHostFrameByteLimit - 2
    )
    expect(() => parse('"' + 'a'.repeat(tunHostFrameByteLimit - 1) + '"')).toThrow()
    const multibyte = '"' + '中'.repeat(Math.floor(tunHostFrameByteLimit / 3) + 1) + '"'
    expect(multibyte.length).toBeLessThan(tunHostFrameByteLimit)
    expect(Buffer.byteLength(multibyte)).toBeGreaterThan(tunHostFrameByteLimit)
    expect(() => parse(multibyte)).toThrow()
  })

  it('bounds object, array and mixed container nesting before JSON.parse', () => {
    const array = (depth: number) => '['.repeat(depth) + '0' + ']'.repeat(depth),
      object = (depth: number) => '{"x":'.repeat(depth) + '0' + '}'.repeat(depth),
      mixed = (depth: number): string =>
        depth === 0
          ? 'null'
          : depth % 2
            ? '[' + mixed(depth - 1) + ']'
            : '{"x":' + mixed(depth - 1) + '}'
    for (const build of [array, object, mixed]) {
      expect(parse(build(tunHostJSONDepthLimit))).toEqual(JSON.parse(build(tunHostJSONDepthLimit)))
      expect(() => parse(build(tunHostJSONDepthLimit + 1))).toThrow()
    }
    expect(() => parse('['.repeat(tunHostFrameByteLimit))).toThrow()
  })

  it.each(
    [
      [0xff],
      [0xc0, 0xaf],
      [0xe2, 0x82],
      [0xed, 0xa0, 0x80],
      [0xf4, 0x90, 0x80, 0x80],
      [0xef, 0xbb, 0xbf, 0x7b, 0x7d]
    ].map((bytes) => ({ bytes }))
  )('rejects invalid UTF-8 or a BOM without leaking payload bytes: $bytes', ({ bytes }) => {
    expect(() => parseTunHostFrame(Buffer.from(bytes))).toThrow('TUN宿主JSON帧无效。')
  })

  it('emits only a fixed error for private malformed content', () => {
    expect(() => parse('{"secret":"PRIVATE","secret":"PRIVATE"}')).toThrow(
      new Error('TUN宿主JSON帧无效。')
    )
  })
})
