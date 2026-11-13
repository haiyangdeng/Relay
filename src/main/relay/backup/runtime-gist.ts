import { createHash, randomUUID } from 'crypto'
import {
  RUNTIME_GIST_FILENAME,
  runtimeGistRequest,
  sameRuntimeGistSource,
  type RelayRuntimeGistSource,
  type RelayRuntimeGistPlan,
  type RelayRuntimeGistResult
} from '../../../shared/relay/runtime-gist'
import { requestOnce } from '../../resolve/plugin/http-client'
import { encryptAgeContent } from '../../utils/age'
import {
  createRuntimeGistWriter,
  validateRuntimeGistSnapshot as snapshot,
  RUNTIME_GIST_PAYLOAD_LIMIT as payloadLimit,
  type RuntimeGistSnapshot
} from './runtime-gist-writer'
export type { RuntimeGistSnapshot } from './runtime-gist-writer'

const api = 'https://api.github.com/gists'
const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

// Manual counterpart of the fixed upstream gistApi runtime-YAML flow. It uses
// Relay's owned snapshot and existing CONNECT/TLS/AGE helpers, never old app
// settings, core factory, implicit getGistUrl upload or a persisted token.
export function createRuntimeGistService(adapters: {
  readRuntime(
    signal: AbortSignal,
    source: RelayRuntimeGistSource | undefined,
    expectedProxyPort: number
  ): Promise<RuntimeGistSnapshot>
  confirm(plan: RelayRuntimeGistPlan): Promise<boolean>
  assertIdle?(source?: RelayRuntimeGistSource): void
  assertRuntime?(expected: Readonly<RuntimeGistSnapshot>): void
  request?: typeof requestOnce
  now?(): number
}) {
  const now = adapters.now ?? Date.now,
    request = adapters.request ?? requestOnce,
    writer = createRuntimeGistWriter(request),
    waiters: Array<() => void> = []
  let pending = false,
    closing = false,
    generation = 0,
    controller: AbortController | undefined,
    expiry: ReturnType<typeof setTimeout> | undefined
  type Prepared = {
    plan: RelayRuntimeGistPlan
    request: ReturnType<typeof runtimeGistRequest>
    snapshot: RuntimeGistSnapshot
    payload: Buffer
    at: number
    recheck?: () => Promise<void>
    assertContext?: () => void
  }
  let proof: Prepared | undefined
  const clearTimer = (): void => {
    if (expiry) clearTimeout(expiry)
    expiry = undefined
  }
  const discard = (): void => {
    clearTimer()
    proof?.payload.fill(0)
    proof = undefined
  }
  const begin = (source?: RelayRuntimeGistSource) => {
    if (pending || closing) throw new Error('请等待当前运行配置Gist操作结束。')
    adapters.assertIdle?.(source)
    pending = true
    controller = new AbortController()
    const signal = controller.signal,
      epoch = ++generation
    const live = (): void => {
      if (signal.aborted || closing || epoch !== generation)
        throw new Error('运行配置Gist操作已取消。')
    }
    return { signal, live }
  }
  const end = (): void => {
    pending = false
    controller = undefined
    waiters.splice(0).forEach((resolve) => resolve())
  }
  const idle = (): Promise<void> =>
    pending ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()
  const cancel = (): void => {
    ++generation
    discard()
    controller?.abort()
  }
  return {
    isBusy: (): boolean => pending,
    whenIdle: idle,
    cancel,
    async requestClose(): Promise<void> {
      closing = true
      cancel()
      await idle()
      closing = false
    },
    async prepare(
      raw: unknown,
      recheck?: () => Promise<void>,
      assertContext?: () => void
    ): Promise<RelayRuntimeGistPlan> {
      const input = runtimeGistRequest(raw)
      const { signal, live } = begin(input.source)
      discard()
      const contextLive = (): void => {
        live()
        assertContext?.()
      }
      let payload: Buffer | undefined
      try {
        contextLive()
        if (input.source?.kind === 'tun-managed' && !adapters.assertRuntime)
          throw new Error('TUN运行来源缺少同步归属守卫。')
        const source = snapshot(await adapters.readRuntime(signal, input.source, input.proxyPort))
        contextLive()
        if (
          !sameRuntimeGistSource(input.source, source.source) ||
          input.proxyPort !== source.proxyPort
        )
          throw new Error('代理端口不属于本次自有实例。')
        const content = input.recipient
          ? await encryptAgeContent(source.configuration, input.recipient, 'gist runtime config')
          : source.configuration
        contextLive()
        await recheck?.()
        contextLive()
        adapters.assertRuntime?.(source)
        payload = Buffer.from(content)
        if (payload.length > payloadLimit) throw new Error('运行配置Gist正文超过1MiB。')
        const at = now(),
          plan: RelayRuntimeGistPlan = {
            evidenceId: randomUUID(),
            ...(input.source ? { source: input.source } : {}),
            action: input.gistId ? 'update' : 'create',
            endpoint: api + (input.gistId ? '/' + input.gistId : ''),
            filename: RUNTIME_GIST_FILENAME,
            ...(input.gistId ? { gistId: input.gistId } : {}),
            proxyPort: input.proxyPort,
            encrypted: !!input.recipient,
            containsSecrets: true,
            instanceId: source.instanceId,
            configurationRevision: source.revision,
            configurationSHA256: sha(source.configuration),
            configurationBytes: Buffer.byteLength(source.configuration),
            payloadSHA256: sha(payload),
            payloadBytes: payload.length,
            expiresAt: at + 60000
          }
        const prepared = {
          plan,
          request: input,
          snapshot: source,
          payload,
          at,
          ...(recheck ? { recheck } : {}),
          ...(assertContext ? { assertContext } : {})
        }
        proof = prepared
        expiry = setTimeout(() => {
          if (proof === prepared) discard()
        }, 60000)
        expiry.unref?.()
        payload = undefined
        return structuredClone(plan)
      } catch {
        throw new Error(
          signal.aborted
            ? '运行配置Gist准备已取消。'
            : '运行配置Gist准备未通过；请核对本次自有实例、Token、代理和AGE接收者。'
        )
      } finally {
        payload?.fill(0)
        end()
      }
    },
    async execute(raw: unknown): Promise<RelayRuntimeGistResult> {
      if (!object(raw) || Object.keys(raw).join(',') !== 'evidenceId')
        throw new Error('运行配置Gist只接受本次准备凭据。')
      const prepared = proof
      const fresh = (): void => {
        if (!prepared || now() < prepared.at || now() >= prepared.plan.expiresAt)
          throw new Error('运行配置Gist凭据已过期。')
      }
      if (!prepared || raw.evidenceId !== prepared.plan.evidenceId) {
        discard()
        throw new Error('请重新准备本次运行配置Gist。')
      }
      try {
        fresh()
      } catch {
        discard()
        throw new Error('请重新准备本次运行配置Gist。')
      }
      const { signal, live } = begin(prepared.request.source)
      proof = undefined
      clearTimer()
      const assertRuntimeLive = (): void => {
        live()
        prepared.assertContext?.()
        fresh()
        adapters.assertIdle?.(prepared.request.source)
        adapters.assertRuntime?.(prepared.snapshot)
      }
      const verifyRuntime = async (): Promise<void> => {
        live()
        prepared.assertContext?.()
        fresh()
        adapters.assertIdle?.(prepared.request.source)
        const current = snapshot(
          await adapters.readRuntime(signal, prepared.request.source, prepared.request.proxyPort)
        )
        live()
        fresh()
        if (
          !sameRuntimeGistSource(current.source, prepared.snapshot.source) ||
          current.instanceId !== prepared.snapshot.instanceId ||
          current.revision !== prepared.snapshot.revision ||
          current.proxyPort !== prepared.request.proxyPort ||
          current.configuration !== prepared.snapshot.configuration ||
          sha(prepared.payload) !== prepared.plan.payloadSHA256
        )
          throw new Error('确认期间自有运行配置已变化。')
        try {
          await prepared.recheck?.()
        } catch {
          throw new Error('保存的Gist账号已变化或本次授权失效。')
        }
        live()
        fresh()
        adapters.assertIdle?.(prepared.request.source)
        adapters.assertRuntime?.(prepared.snapshot)
        prepared.assertContext?.()
      }
      try {
        assertRuntimeLive()
        if (!(await adapters.confirm(structuredClone(prepared.plan))))
          return { status: 'cancelled' }
        await verifyRuntime()
        const result = await writer.write(
          { request: prepared.request, payload: prepared.payload },
          signal,
          {
            beforeSend: verifyRuntime,
            beforeDispatch: assertRuntimeLive,
            afterResponse: assertRuntimeLive,
            complete: verifyRuntime,
            remainingMs: () => prepared.plan.expiresAt - now()
          }
        )
        return result.status === 'uploaded'
          ? { status: 'uploaded', gistId: result.gistId, url: result.url }
          : result
      } catch {
        if (signal.aborted || closing) return { status: 'cancelled' }
        throw new Error('运行配置Gist同步未确认；未自动重试或修改本地配置。')
      } finally {
        prepared.payload.fill(0)
        end()
      }
    }
  }
}
