import { createHash } from 'node:crypto'
import { parseDocument } from 'yaml'
import { compare, prerelease, valid } from '../vendor/semver-7.8.5.mjs'
import type { RelayAppUpdateRelease } from '../../../../shared/relay/app-updates'
import { appUpdateURL, type AppReleaseConfiguration } from './configuration'

export interface TrustedAppRelease extends RelayAppUpdateRelease {
  url: string
  metadataSHA256: string
  trustRevision: string
}
export function appVersion(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length > 128 || valid(raw) !== raw)
    throw new Error('应用版本不是规范语义版本。')
  return raw
}
export function newerAppVersion(next: string, current: string): boolean {
  appVersion(next)
  appVersion(current)
  // Stable publication never silently migrates to an alpha/prerelease channel.
  return prerelease(next) === null && compare(next, current) > 0
}
export function publicAppRelease(release: TrustedAppRelease): RelayAppUpdateRelease {
  return {
    version: release.version,
    architecture: release.architecture,
    bytes: release.bytes,
    sha512: release.sha512,
    releasedAt: release.releasedAt
  }
}
export function parseAppRelease(
  bytes: Buffer,
  config: Readonly<AppReleaseConfiguration>,
  trustRevision: string,
  architecture: 'arm64' | 'x64',
  currentVersion: string
): TrustedAppRelease | null {
  if (!bytes.length || bytes.length > 256 * 1024) throw new Error('应用更新索引大小无效。')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  // Standard electron-builder latest-mac.yml; no executable tags, YAML aliases
  // or fallback to a different release channel are accepted.
  const document = parseDocument(text, { strict: true, uniqueKeys: true, merge: false })
  if (document.errors.length) throw new Error('应用更新索引格式无效。')
  const raw: unknown = document.toJS({ maxAliasCount: 0 })
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('应用更新索引无效。')
  const value = raw as Record<string, unknown>,
    version = appVersion(value.version)
  if (
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > 16 ||
    typeof value.releaseDate !== 'string' ||
    value.releaseDate.length > 64 ||
    !Number.isFinite(Date.parse(value.releaseDate))
  )
    throw new Error('应用发布元数据不完整。')
  const candidates: TrustedAppRelease[] = []
  for (const file of value.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('应用资产无效。')
    const item = file as Record<string, unknown>
    if (typeof item.url !== 'string') throw new Error('应用资产地址无效。')
    const parsed = new URL(item.url, config.feedURLs[architecture])
    if (!parsed.pathname.toLowerCase().endsWith('.pkg')) continue
    const url = appUpdateURL(parsed.href, config.downloadOrigins)
    if (
      typeof item.sha512 !== 'string' ||
      !/^[A-Za-z0-9+/]{86}==$/u.test(item.sha512) ||
      Buffer.from(item.sha512, 'base64').length !== 64 ||
      Buffer.from(item.sha512, 'base64').toString('base64') !== item.sha512 ||
      !Number.isSafeInteger(item.size) ||
      Number(item.size) < 1 ||
      Number(item.size) > config.maximumPackageBytes
    )
      throw new Error('应用资产大小或SHA-512无效。')
    candidates.push({
      version,
      architecture,
      bytes: Number(item.size),
      sha512: item.sha512,
      releasedAt: value.releaseDate,
      url,
      trustRevision,
      metadataSHA256: createHash('sha256').update(bytes).digest('hex')
    })
  }
  if (candidates.length !== 1) throw new Error('本架构更新索引必须恰好提供一个PKG。')
  return newerAppVersion(version, currentVersion) ? candidates[0] : null
}
