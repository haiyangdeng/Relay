import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { requestOnce } from '../../../resolve/plugin/http-client'
import { appUpdateURL, type AppReleaseConfiguration } from './configuration'

export interface AppUpdateProxyLease {
  instanceId: string
  configurationRevision: string
  pid: number
  port: number
}
export interface AppUpdateNetwork {
  acquire(): Promise<AppUpdateProxyLease>
  assertCurrent(lease: AppUpdateProxyLease): Promise<void>
}

// Same requestOnce CONNECT/TLS/cancellation primitives as the admitted resource
// downloader. All redirects share one budget and the same owned-proxy lease.
export async function fetchAppUpdateBytes(
  initialURL: string,
  maximumBytes: number,
  config: Readonly<AppReleaseConfiguration>,
  network: AppUpdateNetwork,
  lease: AppUpdateProxyLease,
  signal: AbortSignal,
  integrity?: { sha512: string; bytes: number }
): Promise<Buffer> {
  if (
    process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    maximumBytes > config.maximumPackageBytes ||
    !Number.isSafeInteger(lease.pid) ||
    lease.pid < 1 ||
    !Number.isSafeInteger(lease.port) ||
    lease.port < 1024 ||
    lease.port > 65535 ||
    !lease.instanceId ||
    !lease.configurationRevision
  )
    throw new Error('应用更新要求已确认的自有HTTP代理和TLS校验。')
  const startedWall = Date.now(),
    startedMono = performance.now()
  let lastWall = startedWall,
    lastMono = startedMono
  const remaining = (): number => {
    const wall = Date.now(),
      mono = performance.now()
    if (
      signal.aborted ||
      ![startedWall, startedMono, wall, mono].every(Number.isFinite) ||
      wall < lastWall ||
      mono < lastMono ||
      wall - startedWall >= 60000 ||
      mono - startedMono >= 60000
    )
      throw new Error('应用更新请求取消、过期或时钟不可信。')
    lastWall = wall
    lastMono = mono
    return Math.max(1, Math.ceil(60000 - Math.max(wall - startedWall, mono - startedMono)))
  }
  let url = appUpdateURL(initialURL, config.downloadOrigins)
  for (let redirect = 0; redirect <= 3; redirect++) {
    remaining()
    await network.assertCurrent(lease)
    remaining()
    const response = await requestOnce(url, {
      method: 'GET',
      proxy: { host: '127.0.0.1', port: lease.port },
      signal,
      timeout: remaining(),
      maxBytes: maximumBytes,
      captureRedirects: true,
      binary: true,
      headers: { 'user-agent': 'Relay', 'accept-encoding': 'identity' }
    })
    remaining()
    await network.assertCurrent(lease)
    remaining()
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (typeof response.headers.location !== 'string') throw new Error('应用更新跳转无效。')
      url = appUpdateURL(new URL(response.headers.location, url).href, config.downloadOrigins, true)
      continue
    }
    if (
      response.status !== 200 ||
      !Buffer.isBuffer(response.bytes) ||
      !response.bytes.length ||
      response.bytes.length > maximumBytes ||
      (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')
    )
      throw new Error('应用更新响应未通过检查。')
    if (
      integrity &&
      (response.bytes.length !== integrity.bytes ||
        createHash('sha512').update(response.bytes).digest('base64') !== integrity.sha512)
    )
      throw new Error('应用包正文完整性校验失败。')
    remaining()
    return response.bytes
  }
  throw new Error('应用更新跳转次数超限。')
}
