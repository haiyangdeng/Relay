import { createHash } from 'crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import AdmZip from 'adm-zip'
import { admitOnlineThemeArchive, themeArchiveMaxBytes } from './theme-admission'

const calls = vi.hoisted(() => ({ inflated: [] as string[], parsed: 0 }))
vi.mock('adm-zip', async (original) => {
  const Original = (await original<{ default: typeof AdmZip }>()).default
  return {
    default: function (bytes?: Buffer) {
      const zip = new Original(bytes)
      const entries = zip.getEntries.bind(zip)
      const wrapped = new WeakSet<AdmZip.IZipEntry>()
      zip.getEntries = () => {
        calls.parsed++
        return entries().map((entry) => {
          if (!wrapped.has(entry)) {
            wrapped.add(entry)
            const get = entry.getData.bind(entry)
            entry.getData = () => {
              calls.inflated.push(entry.entryName)
              return get()
            }
          }
          return entry
        })
      }
      return zip
    }
  }
})

function archive(files: Record<string, string | Buffer>): Buffer {
  const zip = new AdmZip()
  for (const [name, value] of Object.entries(files)) zip.addFile(name, Buffer.from(value))
  return zip.toBuffer()
}
// Mutate only synthetic writer-produced ZIP bytes; shipping admission still
// delegates ZIP parsing/decompression/CRC entirely to AdmZip.
function central(bytes: Buffer, name: string): number {
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02])
  let offset = bytes.indexOf(signature)
  while (offset >= 0) {
    const length = bytes.readUInt16LE(offset + 28)
    if (bytes.subarray(offset + 46, offset + 46 + length).toString() === name) return offset
    offset = bytes.indexOf(signature, offset + 46 + length)
  }
  throw new Error('Missing synthetic central entry')
}
function rename(bytes: Buffer, from: string, to: string): Buffer {
  const out = Buffer.from(bytes),
    source = Buffer.from(from),
    target = Buffer.from(to)
  if (source.length !== target.length) throw new Error('Fixture names must have equal byte lengths')
  for (let at = out.indexOf(source); at >= 0; at = out.indexOf(source, at + target.length))
    target.copy(out, at)
  return out
}
beforeEach(() => {
  calls.parsed = 0
  calls.inflated = []
})

describe('private online theme in-memory ZIP admission', () => {
  it('admits a flat CSS archive without writing, enabling or changing its bytes', () => {
    const bytes = archive({ 'blue.css': '/* Blue */\nbody{color:blue}' }),
      before = Buffer.from(bytes)
    const result = admitOnlineThemeArchive(bytes)
    expect(result.candidates).toEqual([
      {
        path: 'blue.css',
        name: 'Blue',
        css: '/* Blue */\nbody{color:blue}',
        size: 27,
        sha256: createHash('sha256').update('/* Blue */\nbody{color:blue}').digest('hex')
      }
    ])
    expect(result.unsupported).toEqual([])
    expect(result.archiveSHA256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(bytes).toEqual(before)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.candidates)).toBe(true)
    expect(Object.isFrozen(result.candidates[0])).toBe(true)
  })

  it.each([Buffer.alloc(0), Buffer.alloc(themeArchiveMaxBytes + 1), Buffer.from('not a zip')])(
    'rejects invalid archive size/content %#',
    (bytes) => {
      expect(() => admitOnlineThemeArchive(bytes)).toThrow()
      expect(calls.inflated).toEqual([])
    }
  )
  it('rejects an empty ZIP and a namespace with65 entries before inflation', () => {
    expect(() => admitOnlineThemeArchive(new AdmZip().toBuffer())).toThrow()
    expect(() =>
      admitOnlineThemeArchive(
        archive(Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`theme${i}.css`, 'x'])))
      )
    ).toThrow()
    expect(calls.inflated).toEqual([])
    expect(calls.parsed).toBe(0)
  })
  it('admits64 exact8KiB candidates in the bounded512KiB pool', () => {
    const bytes = archive(
      Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`theme${i}.css`, 'x'.repeat(8192)]))
    )
    const result = admitOnlineThemeArchive(bytes)
    expect(result.candidates).toHaveLength(64)
    expect(result.candidates.reduce((sum, item) => sum + item.size, 0)).toBe(512 * 1024)
  })
  it.each(['../a.css', '/bad.css', 'dir/a.css', '.bad.css', 'bad\\css', 'bad.html'])(
    'rejects unsafe/unsupported namespace %s before inflating a valid earlier entry',
    (name) => {
      const safe = 'z'.repeat(Buffer.byteLength(name) - 4) + '.css'
      const bytes = rename(archive({ 'a.css': 'body{}', [safe]: 'bad' }), safe, name)
      expect(() => admitOnlineThemeArchive(bytes)).toThrow()
      expect(calls.inflated).toEqual([])
    }
  )
  it('rejects path collisions by NFC/case before decompression', () => {
    for (const pair of [
      ['A.css', 'a.css'],
      ['é.css', 'e\u0301.css']
    ]) {
      expect(() =>
        admitOnlineThemeArchive(archive(Object.fromEntries(pair.map((name) => [name, 'x']))))
      ).toThrow()
    }
    expect(calls.inflated).toEqual([])
  })
  it('rejects directories and symlink/special Unix entries before decompression', () => {
    const directory = new AdmZip()
    directory.addFile('dir/', Buffer.alloc(0))
    expect(() => admitOnlineThemeArchive(directory.toBuffer())).toThrow()
    for (const mode of [0o120777, 0o020600, 0o010600]) {
      const bytes = archive({ 'a.css': 'x' }),
        at = central(bytes, 'a.css')
      bytes.writeUInt32LE((mode * 65536) >>> 0, at + 38)
      expect(() => admitOnlineThemeArchive(bytes)).toThrow()
    }
    expect(calls.inflated).toEqual([])
  })
  it.each([1, 0x40, 0x2000])(
    'rejects encryption/unsupported flag %s in the complete namespace',
    (flag) => {
      const bytes = archive({ 'a.css': 'x', 'z.css': 'y' }),
        at = central(bytes, 'z.css')
      bytes.writeUInt16LE(bytes.readUInt16LE(at + 8) | flag, at + 8)
      expect(() => admitOnlineThemeArchive(bytes)).toThrow()
      expect(calls.inflated).toEqual([])
    }
  )
  it('rejects unsupported compression and truncated local extents before inflation', () => {
    const bytes = archive({ 'a.css': 'x' }),
      at = central(bytes, 'a.css')
    const method = Buffer.from(bytes)
    method.writeUInt16LE(99, at + 10)
    expect(() => admitOnlineThemeArchive(method)).toThrow()
    const offset = Buffer.from(bytes)
    offset.writeUInt32LE(bytes.length - 1, at + 42)
    expect(() => admitOnlineThemeArchive(offset)).toThrow()
    expect(calls.inflated).toEqual([])
  })
  it('rejects central/local CRC disagreement before inflating data', () => {
    const bytes = archive({ 'a.css': 'body{}' }),
      at = central(bytes, 'a.css')
    bytes.writeUInt32LE((bytes.readUInt32LE(at + 16) ^ 1) >>> 0, at + 16)
    expect(() => admitOnlineThemeArchive(bytes)).toThrow()
    expect(calls.inflated).toEqual([])
  })

  it('still delegates matching-but-false CRC body verification to AdmZip', () => {
    const bytes = archive({ 'a.css': 'body{}' }),
      at = central(bytes, 'a.css')
    const local = bytes.readUInt32LE(at + 42),
      crc = (bytes.readUInt32LE(at + 16) ^ 1) >>> 0
    bytes.writeUInt32LE(crc, at + 16)
    bytes.writeUInt32LE(crc, local + 14)
    expect(() => admitOnlineThemeArchive(bytes)).toThrow()
    expect(calls.inflated).toContain('a.css')
  })

  it('rejects encryption hidden only in the local header before inflation', () => {
    const bytes = archive({ 'a.css': 'body{}' }),
      at = central(bytes, 'a.css'),
      local = bytes.readUInt32LE(at + 42)
    bytes.writeUInt16LE(bytes.readUInt16LE(local + 6) | 1, local + 6)
    expect(() => admitOnlineThemeArchive(bytes)).toThrow()
    expect(calls.inflated).toEqual([])
  })

  it.each(['../..', 'b.css'])(
    'rejects a same-length local filename disagreement %s before inflation',
    (localName) => {
      const bytes = archive({ 'a.css': 'body{}' }),
        at = central(bytes, 'a.css'),
        local = bytes.readUInt32LE(at + 42)
      Buffer.from(localName).copy(bytes, local + 30)
      expect(() => admitOnlineThemeArchive(bytes)).toThrow()
      expect(calls.inflated).toEqual([])
    }
  )
  it('derives the local filename correctly when only the local header carries an extra field', () => {
    const original = archive({ 'a.css': 'body{}' }),
      at = central(original, 'a.css'),
      local = original.readUInt32LE(at + 42),
      nameEnd = local + 30 + original.readUInt16LE(local + 26),
      extra = Buffer.from([0xfe, 0xca, 4, 0, 1, 2, 3, 4]),
      bytes = Buffer.concat([original.subarray(0, nameEnd), extra, original.subarray(nameEnd)]),
      eocd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    bytes.writeUInt16LE(extra.length, local + 28)
    bytes.writeUInt32LE(at + extra.length, eocd + 16)
    const result = admitOnlineThemeArchive(bytes)
    expect(result.candidates).toMatchObject([{ path: 'a.css', css: 'body{}' }])
    expect(calls.inflated).toEqual(['a.css'])
  })

  it('accepts mature descriptor placeholders without weakening central CRC verification', () => {
    const bytes = archive({ 'a.css': 'body{}' }),
      at = central(bytes, 'a.css'),
      local = bytes.readUInt32LE(at + 42)
    bytes.writeUInt16LE(bytes.readUInt16LE(at + 8) | 8, at + 8)
    bytes.writeUInt16LE(bytes.readUInt16LE(local + 6) | 8, local + 6)
    bytes.writeUInt32LE(0, local + 14)
    bytes.writeUInt32LE(0, local + 18)
    bytes.writeUInt32LE(0, local + 22)
    expect(admitOnlineThemeArchive(bytes).candidates).toHaveLength(1)
  })
  it('rejects an empty entry with a false CRC before calling the empty-data shortcut', () => {
    const bytes = archive({ 'a.css': '' }),
      at = central(bytes, 'a.css')
    bytes.writeUInt32LE(1, at + 16)
    expect(() => admitOnlineThemeArchive(bytes)).toThrow()
    expect(calls.inflated).toEqual([])
  })
  it('uses the mature bounded inflater when central size lies below the actual deflated output', () => {
    const bytes = archive({ 'a.css': 'x'.repeat(16384) }),
      at = central(bytes, 'a.css')
    bytes.writeUInt32LE(1, at + 24)
    bytes.writeUInt32LE(1, bytes.readUInt32LE(at + 42) + 22)
    expect(() => admitOnlineThemeArchive(bytes)).toThrow()
    expect(calls.inflated).toContain('a.css')
  })
  it('marks an oversized theme metadata-only without inflating it or rejecting another valid theme', () => {
    const result = admitOnlineThemeArchive(
      archive({ 'small.css': 'body{}', 'large.css': 'x'.repeat(8193) })
    )
    expect(result.candidates.map((item) => item.path)).toEqual(['small.css'])
    expect(result.unsupported).toEqual([
      {
        path: 'large.css',
        declaredSize: 8193,
        reason: 'css-too-large',
        crcAndLengthVerified: false,
        utf8AndCSSVerified: false
      }
    ])
    expect(calls.inflated).toEqual(['small.css'])
  })
  it('does not claim CRC or text validation for a corrupted oversize unsupported body', () => {
    const bytes = archive({ 'large.css': 'x'.repeat(8193) }),
      at = central(bytes, 'large.css')
    bytes.writeUInt32LE((bytes.readUInt32LE(at + 16) ^ 1) >>> 0, at + 16)
    bytes.writeUInt32LE(bytes.readUInt32LE(at + 16), bytes.readUInt32LE(at + 42) + 14)
    const result = admitOnlineThemeArchive(bytes)
    expect(result.unsupported[0]).toMatchObject({
      crcAndLengthVerified: false,
      utf8AndCSSVerified: false
    })
    expect(calls.inflated).toEqual([])
  })
  it.each([
    Buffer.from([0xc3, 0x28]),
    Buffer.from('x\0y'),
    Buffer.from('/* ' + 'x'.repeat(81) + ' */\nx')
  ])('retains invalid text/name metadata without making it a candidate %#', (css) => {
    const result = admitOnlineThemeArchive(archive({ 'a.css': css, 'b.css': 'good' }))
    expect(result.candidates.map((item) => item.path)).toEqual(['b.css'])
    expect(result.unsupported[0]).toMatchObject({
      path: 'a.css',
      reason: 'invalid-theme-text',
      crcAndLengthVerified: true,
      utf8AndCSSVerified: false
    })
  })
  it('preserves a CSS BOM and uses filename fallback exactly as the existing legacy importer', () => {
    const css = '\uFEFF/* Comment */\nbody{}'
    const result = admitOnlineThemeArchive(archive({ 'a.css': css, 'b.css': '/* */\nx' }))
    expect(result.candidates).toMatchObject([
      { path: 'a.css', name: 'a.css', css },
      { path: 'b.css', name: 'b.css' }
    ])
  })
  it('marks all conflicting comment names unsupported rather than picking one', () => {
    const result = admitOnlineThemeArchive(
      archive({ 'a.css': '/* Same */\nx', 'b.css': '/* same */\ny' })
    )
    expect(result.candidates).toEqual([])
    expect(result.unsupported).toHaveLength(2)
    for (const item of result.unsupported)
      expect(item).toMatchObject({
        reason: 'name-conflict',
        crcAndLengthVerified: true,
        utf8AndCSSVerified: true
      })
  })
  it('supports the observed24 source-size layout as synthetic18 candidates and6 unsupported, without actual upstream CSS payloads', () => {
    const sizes = [
      2569, 109208, 3002, 877, 3924, 6175, 3881, 660, 3931, 3923, 3890, 9504, 1698196, 6110, 5661,
      564, 14087, 22657, 6898, 8113, 2996, 557, 931, 9475
    ]
    const files = Object.fromEntries(
      sizes.map((size, index) => [`theme${index}.css`, 'x'.repeat(size)])
    )
    const result = admitOnlineThemeArchive(archive(files))
    expect(result.candidates).toHaveLength(18)
    expect(result.unsupported).toHaveLength(6)
    expect(calls.inflated).toHaveLength(18)
  })
})
