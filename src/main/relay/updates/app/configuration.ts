import { createHash } from 'node:crypto'
import { isIP } from 'node:net'

export interface AppReleaseConfiguration {
  feedURLs: Readonly<Record<'arm64' | 'x64', string>>
  downloadOrigins: readonly string[]
  applicationIdentifier: string
  applicationBundleName: string
  packageIdentifier: string
  publisherTeamID: string
  approvedInstallerScriptSHA256: readonly string[]
  maximumPackageBytes: number
}

// Publisher release inputs have not been supplied. They are build-owned values,
// never renderer preferences, and never fall back to Clash Party's release feed.
export const relayAppReleaseConfiguration: AppReleaseConfiguration | null = null

export function appUpdateURL(raw: string, origins: readonly string[], query = false): string {
  if (typeof raw !== 'string' || raw.length > 8192) throw new Error('应用更新来源无效。')
  const url = new URL(raw)
  const host = url.hostname.replace(/\.$/u, '')
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    (!query && url.search) ||
    host.startsWith('[') ||
    isIP(host) ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    !origins.includes(url.origin)
  )
    throw new Error('应用更新来源不在发布清单中。')
  return url.href
}
export function appReleaseConfiguration(raw: AppReleaseConfiguration | null): {
  value: Readonly<AppReleaseConfiguration>
  revision: string
} {
  if (!raw) throw new Error('Relay 独立发布来源和公开签名身份尚未配置。')
  if (
    raw.applicationIdentifier !== 'local.relay.network.preview' ||
    raw.applicationBundleName !== 'Relay.app' ||
    !/^[A-Za-z0-9][A-Za-z0-9.-]{2,254}$/u.test(raw.packageIdentifier) ||
    !/^[A-Z0-9]{10}$/u.test(raw.publisherTeamID) ||
    !Number.isSafeInteger(raw.maximumPackageBytes) ||
    raw.maximumPackageBytes < 1 ||
    raw.maximumPackageBytes > 1024 * 1024 * 1024 ||
    raw.downloadOrigins.length < 1 ||
    raw.downloadOrigins.length > 8 ||
    new Set(raw.downloadOrigins).size !== raw.downloadOrigins.length ||
    raw.approvedInstallerScriptSHA256.length > 32 ||
    raw.approvedInstallerScriptSHA256.some((value) => !/^[a-f0-9]{64}$/u.test(value))
  )
    throw new Error('应用发布身份或资源策略不完整。')
  for (const origin of raw.downloadOrigins) {
    const parsed = new URL(origin)
    if (parsed.origin !== origin || parsed.pathname !== '/') throw new Error('更新域名策略无效。')
    appUpdateURL(origin, raw.downloadOrigins)
  }
  for (const arch of ['arm64', 'x64'] as const)
    appUpdateURL(raw.feedURLs[arch], raw.downloadOrigins)
  const value = structuredClone(raw)
  return {
    value,
    revision: createHash('sha256')
      .update(
        JSON.stringify({
          applicationIdentifier: value.applicationIdentifier,
          applicationBundleName: value.applicationBundleName,
          packageIdentifier: value.packageIdentifier,
          publisherTeamID: value.publisherTeamID
        })
      )
      .digest('hex')
  }
}
