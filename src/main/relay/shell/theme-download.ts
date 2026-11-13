import { performance } from 'perf_hooks'
import { requestOnce } from '../../resolve/plugin/http-client'
import { officialThemeURL } from '../../../shared/relay/shell-themes'
import { themeArchiveMaxBytes } from './theme-admission'

// Minimal adaptation of SubStore's fixed GitHub asset redirect transport.
// Latest is mutable: record its actual digest after admission, never a fake pin.
export async function downloadOnlineThemes(
  proxyPort: number,
  signal: AbortSignal
): Promise<Buffer> {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('主题下载要求TLS校验。')
  if (!Number.isInteger(proxyPort) || proxyPort < 1024 || proxyPort > 65535)
    throw new Error('本次自有HTTP端口未确认。')
  const deadline = performance.now() + 60000
  let url = officialThemeURL
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (signal.aborted || performance.now() >= deadline) throw new Error('主题获取已取消或超时。')
    const parsed = new URL(url)
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.port ||
      ![
        'github.com',
        'release-assets.githubusercontent.com',
        'objects.githubusercontent.com',
        'github-releases.githubusercontent.com'
      ].includes(parsed.hostname)
    )
      throw new Error('主题包重定向来源未通过校验。')
    const response = await requestOnce(url, {
      method: 'GET',
      proxy: { host: '127.0.0.1', port: proxyPort },
      signal,
      timeout: Math.max(1, Math.ceil(deadline - performance.now())),
      maxBytes: themeArchiveMaxBytes,
      binary: true,
      captureRedirects: true,
      headers: { 'user-agent': 'Relay', 'accept-encoding': 'identity' }
    })
    if (signal.aborted || performance.now() >= deadline) throw new Error('主题获取已取消或超时。')
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (redirects === 3 || typeof response.headers.location !== 'string')
        throw new Error('主题包重定向次数或地址无效。')
      url = new URL(response.headers.location, url).href
      continue
    }
    if (
      response.status !== 200 ||
      !Buffer.isBuffer(response.bytes) ||
      !response.bytes.length ||
      response.bytes.length > themeArchiveMaxBytes ||
      (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')
    )
      throw new Error('主题包未返回有界的完整响应。')
    return response.bytes
  }
  throw new Error('主题包获取未确认；没有自动重试或回退直连。')
}
