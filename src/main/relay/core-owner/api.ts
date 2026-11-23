import { request } from 'http'
import { lstat, realpath } from 'fs/promises'
import { mihomoPathSegment } from '../core/mihomo-path'
import type { OwnedCoreRequestGuards } from '../core/owned-runtime'

// Minimal adaptation of owned-runtime.ts's existing bounded private Unix API.
// This adapter grants GET and explicit group selection only, without generic
// endpoint/method, reload, cache, mode, rule or arbitrary path capabilities.
export function createCoreOwnerAPI(options: {
  directory: string
  socket: string
  inspect(): Promise<void>
  live(): void
}) {
  let socketIdentity: { dev: number; ino: number } | undefined
  const exchange = async (
    path: string,
    body?: string,
    guards?: OwnedCoreRequestGuards
  ): Promise<Record<string, unknown>> => {
    const live = (): void => {
      options.live()
      guards?.assertLive()
      options.live()
    }
    live()
    await options.inspect()
    live()
    const directory = await lstat(options.directory),
      socket = await lstat(options.socket)
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      directory.uid !== process.getuid?.() ||
      (directory.mode & 0o7777) !== 0o700 ||
      (await realpath(options.directory)) !== options.directory ||
      !socket.isSocket() ||
      socket.isSymbolicLink() ||
      socket.uid !== process.getuid?.() ||
      (socketIdentity && (socket.dev !== socketIdentity.dev || socket.ino !== socketIdentity.ino))
    )
      throw new Error('持久代理私有接口身份改变。')
    socketIdentity ??= { dev: socket.dev, ino: socket.ino }
    live()
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const req = request(
        {
          socketPath: options.socket,
          path,
          method: body === undefined ? 'GET' : 'PUT',
          agent: false,
          signal: AbortSignal.timeout(1500),
          maxHeaderSize: 4096,
          headers:
            body === undefined
              ? {}
              : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
        },
        (response) => {
          let bytes = 0,
            ended = false
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length
            if (bytes > 2 * 1024 * 1024) req.destroy(new Error('response limit'))
            else chunks.push(chunk)
          })
          response.on('error', () => reject(new Error('持久代理接口响应未确认。')))
          response.on('aborted', () => reject(new Error('持久代理接口响应提前中断。')))
          response.on('close', () => {
            if (!ended) reject(new Error('持久代理接口在完整响应前关闭。'))
          })
          response.on('end', () => {
            ended = true
            try {
              live()
              if (body !== undefined && response.statusCode === 204) {
                resolve({})
                return
              }
              if (response.statusCode !== 200) throw new Error()
              const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
              resolve(value as Record<string, unknown>)
            } catch {
              reject(new Error('持久代理接口状态或格式未确认。'))
            }
          })
        }
      )
      req.on('error', () => reject(new Error('持久代理接口请求未确认；没有重试。')))
      if (body !== undefined) req.end(body)
      else req.end()
    })
    await options.inspect()
    live()
    const after = await lstat(options.socket)
    if (
      after.dev !== socket.dev ||
      after.ino !== socket.ino ||
      !after.isSocket() ||
      after.isSymbolicLink() ||
      after.uid !== socket.uid
    )
      throw new Error('持久代理接口已变化。')
    return result
  }
  const name = (value: string): string => {
    if (
      !value ||
      value.length > 256 ||
      Array.from(value).some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
      )
    )
      throw new Error('组或成员名称无效。')
    return mihomoPathSegment(value)
  }
  return {
    read(
      endpoint:
        | 'version'
        | 'configs'
        | 'proxies'
        | 'providers/rules'
        | 'providers/proxies'
        | 'rules'
        | 'connections',
      guards?: OwnedCoreRequestGuards
    ): Promise<Record<string, unknown>> {
      if (
        ![
          'version',
          'configs',
          'proxies',
          'providers/rules',
          'providers/proxies',
          'rules',
          'connections'
        ].includes(endpoint)
      )
        throw new Error('持久代理只允许固定读接口。')
      return exchange('/' + endpoint, undefined, guards)
    },
    group: (group: string) => exchange('/proxies/' + name(group)),
    select: async (group: string, member: string): Promise<void> => {
      name(member)
      await exchange('/proxies/' + name(group), JSON.stringify({ name: member }))
    }
  }
}
