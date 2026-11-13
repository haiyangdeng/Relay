import { createHash } from 'crypto'
import { requestOnce, type PluginRequestOptions } from '../../resolve/plugin/http-client'
import {
  RUNTIME_GIST_FILENAME,
  RUNTIME_GIST_MAX_BYTES,
  runtimeGistRequest,
  runtimeGistSource,
  type RelayRuntimeGistSource,
  type RelayRuntimeGistRequest
} from '../../../shared/relay/runtime-gist'

export const RUNTIME_GIST_PAYLOAD_LIMIT = 1024 * 1024
export interface RuntimeGistSnapshot {
  source?: RelayRuntimeGistSource
  instanceId: string
  revision: string
  configuration: string
  proxyPort: number
}
const api = 'https://api.github.com/gists'
const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
export function validateRuntimeGistSnapshot(value: RuntimeGistSnapshot): RuntimeGistSnapshot {
  if (
    !value ||
    typeof value.instanceId !== 'string' ||
    !value.instanceId ||
    value.instanceId.length > 128 ||
    [...value.instanceId].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    !Number.isInteger(value.proxyPort) ||
    value.proxyPort < 1024 ||
    value.proxyPort > 65535 ||
    typeof value.revision !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.revision) ||
    typeof value.configuration !== 'string' ||
    !value.configuration.trim() ||
    value.configuration.includes('\0') ||
    Buffer.byteLength(value.configuration) > RUNTIME_GIST_MAX_BYTES ||
    Buffer.from(value.configuration).toString('utf8') !== value.configuration
  )
    throw new Error('本次自有运行配置快照无效或超过512KiB。')
  const source = runtimeGistSource(value.source)
  if (source?.kind === 'tun-managed' && source.sessionId !== value.instanceId)
    throw new Error('TUN运行配置与本次会话不符。')
  return { ...value, ...(source ? { source } : {}) }
}
function gist(bytes: Buffer, expectedId?: string): { id: string; content: Buffer } {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 2 * 1024 * 1024)
    throw new Error('Gist响应大小无效。')
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (
    !object(value) ||
    value.public !== false ||
    value.truncated === true ||
    typeof value.id !== 'string' ||
    !/^[a-f0-9]{5,64}$/u.test(value.id) ||
    (expectedId && value.id !== expectedId) ||
    !object(value.files) ||
    Object.keys(value.files).join(',') !== RUNTIME_GIST_FILENAME
  )
    throw new Error('目标必须是指定的非公开单文件运行配置Gist。')
  const file = value.files[RUNTIME_GIST_FILENAME]
  if (
    !object(file) ||
    file.filename !== RUNTIME_GIST_FILENAME ||
    file.truncated !== false ||
    typeof file.content !== 'string' ||
    !file.content.length ||
    Buffer.byteLength(file.content) > RUNTIME_GIST_PAYLOAD_LIMIT ||
    Buffer.from(file.content).toString('utf8') !== file.content ||
    (file.size !== undefined && file.size !== Buffer.byteLength(file.content))
  )
    throw new Error('Gist正文无效、截断或超过限制。')
  return { id: value.id, content: Buffer.from(file.content) }
}
export class RuntimeGistWriteGuardError extends Error {
  constructor(readonly reason: 'superseded' | 'conflict') {
    super(reason)
  }
}
export interface RuntimeGistWriterGuards {
  beforeSend(): Promise<void>
  afterResponse?(): void
  beforeDispatch?(): void
  beforeWrite?(): void
  target?(value: { id: string; contentSHA256: string }): Promise<void> | void
  submitted?(): void
  complete?(): Promise<void>
  remainingMs?(): number
}
export type RuntimeGistWriterResult =
  | { status: 'uploaded'; gistId: string; url: string; payloadSHA256: string }
  | { status: 'uncertain'; gistId?: string }
  | { status: 'cancelled' }

// Extracted from the existing manual runtime-Gist path. This writer owns only
// bounded fixed-file API requests/readback, not runtime freshness or consent.
// Manual callers keep strict current-body guards; automatic callers supply a
// genuine active-at-capture receipt and owner-only guards after submission.
export function createRuntimeGistWriter(request: typeof requestOnce = requestOnce) {
  return {
    async write(
      input: { request: RelayRuntimeGistRequest; payload: Buffer },
      signal: AbortSignal,
      guards: RuntimeGistWriterGuards
    ): Promise<RuntimeGistWriterResult> {
      const selected = runtimeGistRequest(input.request),
        payload = Buffer.from(input.payload),
        payloadSHA256 = sha(payload)
      let submitted = false,
        gistId = selected.gistId,
        body: Buffer | undefined
      const send = async (
        url: string,
        method: PluginRequestOptions['method'],
        writing = false
      ): Promise<Buffer> => {
        await guards.beforeSend()
        if (signal.aborted) throw new Error('已取消。')
        if (
          process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0' ||
          !(url === api || /^https:\/\/api\.github\.com\/gists\/[a-f0-9]{5,64}$/u.test(url)) ||
          sha(payload) !== payloadSHA256
        )
          throw new Error('Gist传输边界未通过。')
        const remaining = guards.remainingMs?.() ?? 60000
        if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('Gist操作已过期。')
        // No await after the final current-receipt check and before dispatch.
        // Ordinary commits after this point are queued, not compared to body.
        if (writing) guards.beforeWrite?.()
        guards.beforeDispatch?.()
        if (writing) submitted = true
        let submissionObserverFailed = false
        let responsePromise: ReturnType<typeof request>
        try {
          responsePromise = request(url, {
            method,
            headers: {
              Authorization: `Bearer ${selected.token}`,
              Accept: 'application/vnd.github+json',
              'X-GitHub-Api-Version': '2022-11-28',
              'User-Agent': 'Relay-Runtime-Gist',
              ...(writing
                ? { 'Content-Type': 'application/json' }
                : { 'Cache-Control': 'no-cache' })
            },
            ...(writing ? { body } : {}),
            timeout: Math.max(1, Math.min(60000, remaining)),
            maxBytes: 2 * 1024 * 1024,
            proxy: { host: '127.0.0.1', port: selected.proxyPort },
            signal,
            binary: true,
            captureRedirects: true
          })
        } finally {
          // Observers may synchronously revoke authority. Publish submission
          // only after dispatch, and keep waiting for an already sent request.
          if (writing) {
            try {
              guards.submitted?.()
            } catch {
              submissionObserverFailed = true
            }
          }
        }
        const response = await responsePromise
        if (submissionObserverFailed) throw new Error('Gist提交状态观察未确认。')
        guards.afterResponse?.()
        if (
          signal.aborted ||
          response.status !== (method === 'POST' ? 201 : 200) ||
          !Buffer.isBuffer(response.bytes)
        )
          throw new Error('Gist请求未确认。')
        return response.bytes
      }
      try {
        if (
          !payload.length ||
          payload.length > RUNTIME_GIST_PAYLOAD_LIMIT ||
          Buffer.from(payload.toString('utf8')).compare(payload) !== 0
        )
          throw new Error('Gist正文无效。')
        if (gistId) {
          const target = gist(await send(api + '/' + gistId, 'GET'), gistId)
          try {
            await guards.target?.({ id: target.id, contentSHA256: sha(target.content) })
          } finally {
            target.content.fill(0)
          }
        }
        body = Buffer.from(
          JSON.stringify({
            ...(!gistId
              ? { description: 'Auto Synced Clash Party Runtime Config', public: false }
              : {}),
            files: { [RUNTIME_GIST_FILENAME]: { content: payload.toString('utf8') } }
          })
        )
        const written = gist(
          await send(api + (gistId ? '/' + gistId : ''), gistId ? 'PATCH' : 'POST', true),
          gistId
        )
        gistId = written.id
        try {
          if (!written.content.equals(payload)) throw new Error('Gist写回正文不符。')
        } finally {
          written.content.fill(0)
        }
        const verified = gist(await send(api + '/' + gistId, 'GET'), gistId)
        try {
          if (!verified.content.equals(payload)) throw new Error('Gist读回正文不符。')
        } finally {
          verified.content.fill(0)
        }
        await guards.complete?.()
        return {
          status: 'uploaded',
          gistId,
          url: 'https://gist.github.com/' + gistId,
          payloadSHA256
        }
      } catch (error) {
        if (submitted) return { status: 'uncertain', ...(gistId ? { gistId } : {}) }
        if (signal.aborted) return { status: 'cancelled' }
        if (error instanceof RuntimeGistWriteGuardError) throw error
        throw new Error('运行配置Gist写入前复核未通过。')
      } finally {
        payload.fill(0)
        body?.fill(0)
      }
    }
  }
}
