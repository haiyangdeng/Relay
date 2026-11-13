import { constants } from 'fs'
import { open, realpath, lstat } from 'fs/promises'
import { isAbsolute } from 'path'
import { createHash } from 'crypto'
import { requestOnce } from '../../resolve/plugin/http-client'
import { subscriptionRequest } from '../../../shared/relay/subscription'
import { providerHeaders } from '../subscriptions/transfer'

export const RESOURCE_BYTE_LIMIT = 128 * 1024 * 1024
export const resourceHash = (bytes: Uint8Array): string =>
  createHash('sha256').update(bytes).digest('hex')
export async function readBinaryResource(
  path: string,
  privateCopy = false,
  maximumBytes = RESOURCE_BYTE_LIMIT
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > RESOURCE_BYTE_LIMIT)
    throw new Error('资源读取预算无效。')
  if (!isAbsolute(path) || path.includes('\0') || (await realpath(path)) !== path)
    throw new Error('资源文件路径未确认。')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (
      !before.isFile() ||
      before.size < 1 ||
      before.size > maximumBytes ||
      (privateCopy &&
        (before.uid !== process.getuid?.() ||
          before.nlink !== 1 ||
          (before.mode & 0o7777) !== 0o600))
    )
      throw new Error('资源文件类型、大小或权限不符。')
    const bytes = Buffer.alloc(before.size + 1)
    let size = 0
    while (size < bytes.length) {
      const part = await file.read(bytes, size, bytes.length - size, size)
      if (!part.bytesRead) break
      size += part.bytesRead
    }
    const after = await file.stat(),
      linked = await lstat(path)
    if (
      size !== before.size ||
      [after, linked].some(
        (value) =>
          value.dev !== before.dev ||
          value.ino !== before.ino ||
          value.size !== before.size ||
          value.mtimeMs !== before.mtimeMs ||
          value.ctimeMs !== before.ctimeMs ||
          value.mode !== before.mode ||
          value.uid !== before.uid ||
          value.nlink !== before.nlink
      )
    )
      throw new Error('资源读取期间发生改变。')
    return bytes.subarray(0, size)
  } finally {
    await file.close()
  }
}
export async function downloadBinaryResource(
  url: string,
  proxyPort: number,
  signal: AbortSignal,
  headers: Record<string, string> = {}
): Promise<Buffer> {
  try {
    const request = subscriptionRequest({ name: 'Resource', url, proxyPort })
    if (signal.aborted) throw new Error()
    if (
      new URL(request.url).protocol === 'https:' &&
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0'
    )
      throw new Error()
    const response = await requestOnce(request.url, {
      method: 'GET',
      headers: {
        'user-agent': 'clash.meta/Relay',
        'accept-encoding': 'identity',
        ...providerHeaders(
          Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, [value]]))
        )
      },
      proxy: { host: '127.0.0.1', port: request.proxyPort },
      signal,
      timeout: 60000,
      maxBytes: RESOURCE_BYTE_LIMIT,
      binary: true
    })
    if (
      signal.aborted ||
      response.status !== 200 ||
      !Buffer.isBuffer(response.bytes) ||
      !response.bytes.length ||
      response.bytes.length > RESOURCE_BYTE_LIMIT ||
      (response.headers['content-encoding'] !== undefined &&
        response.headers['content-encoding'] !== 'identity')
    )
      throw new Error()
    return response.bytes
  } catch {
    throw new Error(
      '资源获取失败：指定代理、TLS、大小、响应或编码未通过；不重试、跟随重定向或回退直连。'
    )
  }
}
