import { createHash } from 'crypto'
import AdmZip from 'adm-zip'
import { shellCSS, shellThemeLibrary } from '../../../shared/relay/shell'

export const themeArchiveMaxBytes = 8 * 1024 * 1024
export const themeArchiveMaxEntries = 64
const cssMaxBytes = 8192
const candidateMaxBytes = themeArchiveMaxEntries * cssMaxBytes
const shapeID = '00000000-0000-0000-0000-000000000000'
const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

function parsedLocalHeader(header: AdmZip.IZipEntry['header']): {
  flags: number
  method: number
  crc: number
  size: number
  compressedSize: number
  fnameLen: number
  extraLen: number
} {
  // Locked AdmZip0.6.1 exposes parsed localHeader. The older installed @types
  // calls it dataHeader; validate the runtime value rather than casting it.
  const raw: unknown = Reflect.get(header, 'localHeader')
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error()
  const { flags, method, crc, size, compressedSize, fnameLen, extraLen } = raw as Record<
    string,
    unknown
  >
  if (
    typeof flags !== 'number' ||
    !Number.isSafeInteger(flags) ||
    flags < 0 ||
    flags > 0xffff ||
    typeof method !== 'number' ||
    !Number.isSafeInteger(method) ||
    method < 0 ||
    typeof crc !== 'number' ||
    !Number.isSafeInteger(crc) ||
    crc < 0 ||
    crc > 0xffffffff ||
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    typeof compressedSize !== 'number' ||
    !Number.isSafeInteger(compressedSize) ||
    compressedSize < 0 ||
    typeof fnameLen !== 'number' ||
    !Number.isSafeInteger(fnameLen) ||
    fnameLen < 0 ||
    typeof extraLen !== 'number' ||
    !Number.isSafeInteger(extraLen) ||
    extraLen < 0 ||
    extraLen > 0xffff
  )
    throw new Error()
  return { flags, method, crc, size, compressedSize, fnameLen, extraLen }
}

export interface OnlineThemeCandidate {
  readonly path: string
  readonly name: string
  readonly css: string
  readonly size: number
  readonly sha256: string
}
export interface UnsupportedOnlineTheme {
  readonly path: string
  readonly declaredSize: number
  readonly reason: 'css-too-large' | 'invalid-theme-text' | 'name-conflict'
  readonly crcAndLengthVerified: boolean
  readonly utf8AndCSSVerified: boolean
}
export interface OnlineThemeAdmission {
  readonly archiveSHA256: string
  readonly archiveSize: number
  readonly candidates: readonly OnlineThemeCandidate[]
  readonly unsupported: readonly UnsupportedOnlineTheme[]
}

// In-memory admission only. AdmZip owns ZIP parsing, bounded synchronous
// decompression and CRC. No filesystem extraction, theme activation or fetch.
export function admitOnlineThemeArchive(input: Buffer): OnlineThemeAdmission {
  if (!Buffer.isBuffer(input) || !input.length || input.length > themeArchiveMaxBytes)
    throw new Error('在线主题压缩包超过有界读取范围。')
  const bytes = Buffer.from(input)
  try {
    const archive = new AdmZip(bytes)
    // Read the mature parser's declared count before it allocates entry objects.
    const count = archive.getEntryCount()
    if (!Number.isSafeInteger(count) || count < 1 || count > themeArchiveMaxEntries)
      throw new Error()
    const entries = archive.getEntries()
    if (entries.length !== count) throw new Error()
    if (!entries.length || entries.length > themeArchiveMaxEntries) throw new Error()
    const names = new Set<string>()
    // Check the complete namespace/type/central metadata before any inflation.
    for (const entry of entries) {
      const name = entry.entryName,
        folded = name.normalize('NFC').toLocaleLowerCase('en-US'),
        mode = (entry.attr >>> 16) & 0o170000,
        rawName = new TextDecoder('utf-8', { fatal: true }).decode(entry.rawEntryName)
      if (
        !name ||
        name.length > 1024 ||
        name.startsWith('.') ||
        name.includes('/') ||
        name.includes('\\') ||
        !name.endsWith('.css') ||
        [...name].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
        rawName !== name ||
        names.has(folded) ||
        entry.isDirectory ||
        (mode !== 0 && mode !== 0o100000) ||
        entry.header.flags & ~0x080e ||
        ![0, 8].includes(entry.header.method) ||
        !Number.isSafeInteger(entry.header.size) ||
        entry.header.size < 0 ||
        !Number.isSafeInteger(entry.header.compressedSize) ||
        entry.header.compressedSize < 0 ||
        entry.header.compressedSize > bytes.length ||
        (entry.header.method === 0 && entry.header.size !== entry.header.compressedSize) ||
        (entry.header.compressedSize === 0 && (entry.header.size !== 0 || entry.header.crc !== 0))
      )
        throw new Error()
      names.add(folded)
    }
    // The library validates local-header extents even for oversized entries
    // whose compressed bytes we deliberately do not inflate or claim as CRC checked.
    const ranges: { start: number; end: number }[] = []
    for (const entry of entries) {
      const compressed = entry.getCompressedData(),
        local = parsedLocalHeader(entry.header),
        start = entry.header.offset,
        dataStart = entry.header.realDataOffset,
        end = dataStart + entry.header.compressedSize,
        localNameStart = dataStart - local.extraLen - local.fnameLen,
        localNameEnd = localNameStart + local.fnameLen
      if (
        compressed.length !== entry.header.compressedSize ||
        (local.flags & ~8) !== (entry.header.flags & ~8) ||
        local.method !== entry.header.method ||
        local.fnameLen !== entry.rawEntryName.length ||
        (!((local.flags | entry.header.flags) & 8)
          ? local.crc !== entry.header.crc ||
            local.size !== entry.header.size ||
            local.compressedSize !== entry.header.compressedSize
          : (local.crc !== 0 && local.crc !== entry.header.crc) ||
            (local.size !== 0 && local.size !== entry.header.size) ||
            (local.compressedSize !== 0 && local.compressedSize !== entry.header.compressedSize)) ||
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(dataStart) ||
        !Number.isSafeInteger(end) ||
        start < 0 ||
        dataStart < start ||
        end > bytes.length ||
        !Number.isSafeInteger(localNameStart) ||
        !Number.isSafeInteger(localNameEnd) ||
        localNameStart < start ||
        localNameEnd > dataStart ||
        localNameEnd > bytes.length ||
        !bytes.subarray(localNameStart, localNameEnd).equals(entry.rawEntryName) ||
        ranges.some((range) => start < range.end && end > range.start)
      )
        throw new Error()
      ranges.push({ start, end })
    }
    let total = 0
    const candidates: OnlineThemeCandidate[] = [],
      unsupported: UnsupportedOnlineTheme[] = []
    for (const entry of entries) {
      if (entry.header.size > cssMaxBytes) {
        unsupported.push(
          Object.freeze({
            path: entry.entryName,
            declaredSize: entry.header.size,
            reason: 'css-too-large',
            crcAndLengthVerified: false,
            utf8AndCSSVerified: false
          })
        )
        continue
      }
      const content = entry.getData()
      if (content.length !== entry.header.size) throw new Error()
      total += content.length
      if (total > candidateMaxBytes) throw new Error()
      try {
        // Preserve a BOM and the exact CSS bytes, as the existing legacy theme
        // importer does. Names come from its same first-comment convention.
        const css = shellCSS(
          new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content)
        )
        const name = css.startsWith('/*')
          ? css.split('\n')[0].replace('/*', '').replace('*/', '').trim() || entry.entryName
          : entry.entryName
        const [validated] = shellThemeLibrary([{ id: shapeID, name, css }])
        candidates.push(
          Object.freeze({
            path: entry.entryName,
            name: validated.name,
            css: validated.css,
            size: content.length,
            sha256: hash(content)
          })
        )
      } catch {
        unsupported.push(
          Object.freeze({
            path: entry.entryName,
            declaredSize: entry.header.size,
            reason: 'invalid-theme-text',
            crcAndLengthVerified: true,
            utf8AndCSSVerified: false
          })
        )
      }
    }
    const counts = new Map<string, number>()
    const identity = (name: string): string => name.normalize('NFC').toLocaleLowerCase('en-US')
    for (const item of candidates)
      counts.set(identity(item.name), (counts.get(identity(item.name)) ?? 0) + 1)
    const admitted = candidates.filter((item) => {
      if (counts.get(identity(item.name)) === 1) return true
      unsupported.push(
        Object.freeze({
          path: item.path,
          declaredSize: item.size,
          reason: 'name-conflict',
          crcAndLengthVerified: true,
          utf8AndCSSVerified: true
        })
      )
      return false
    })
    const compare = (a: { path: string }, b: { path: string }): number =>
      a.path.localeCompare(b.path, 'en')
    return Object.freeze({
      archiveSHA256: hash(bytes),
      archiveSize: bytes.length,
      candidates: Object.freeze(admitted.sort(compare)),
      unsupported: Object.freeze(unsupported.sort(compare))
    })
  } catch {
    throw new Error('在线主题包的路径、类型、压缩元数据或正文未通过校验；未写入或启用。')
  }
}
