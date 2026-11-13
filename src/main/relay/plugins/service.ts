import { createHash, randomUUID } from 'crypto'
import {
  pluginId,
  pluginRoute,
  type RelayPluginPreview,
  type RelayPluginRecord,
  type RelayPluginResult,
  type RelayPluginState,
  type RelayPluginRoute,
  type RelayPluginRemotePreview
} from '../../../shared/relay/plugins'
import type { RelayStoredProfile } from '../../../shared/relay/profiles'
import { parseDescriptor } from '../../resolve/plugin/descriptor'
import { discoverGateway } from '../../resolve/plugin/discovery'
import { parseSigned, checkSeq } from '../../resolve/plugin/discovery-sig'
import { generateDevice } from '../../resolve/plugin/device'
import { browserLogin, CLIENT_ID, type OAuthResult } from '../../resolve/plugin/oauth'
import {
  enroll,
  fetchConfig,
  revoke,
  GatewayError,
  type ConfigResult,
  type GatewayTarget
} from '../../resolve/plugin/gateway'
import type { OperationContext, RetryPolicy } from '../../resolve/plugin/operation'
import {
  RelayPluginStorageUncertain,
  pluginTargetKey,
  type RelayPluginStore,
  type RelayPluginEntry,
  type RelayPluginCredential
} from './store'
import type { PluginSchedulePermit } from './scheduler'
import { descriptorSource, type DescriptorSource } from './descriptor-source'

interface ScheduleAuthority {
  verify(signal: AbortSignal, entry?: RelayPluginEntry): Promise<RelayPluginEntry>
  accept(entry: RelayPluginEntry): void
  changed(): never
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']'
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => JSON.stringify(key) + ':' + stable(child))
        .join(',') +
      '}'
    )
  return JSON.stringify(value)
}

export interface RelayPluginPermission {
  action:
    | 'install'
    | 'login'
    | 'update'
    | 'gateways'
    | 'remove'
    | 'save-profile'
    | 'preview-remote'
    | 'rediscover'
  record?: RelayPluginRecord
  preview?: RelayPluginPreview
  origins: string[]
  localOnly?: boolean
  route?: RelayPluginRoute
}
function preview(raw: unknown): RelayPluginPreview {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 1024 * 1024)
    throw new Error('插件描述文件必须为不超过1MiB的JSON。')
  const descriptor = parseDescriptor(raw)
  if (
    descriptor.provider.name.length > 120 ||
    Array.from(descriptor.provider.name).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    throw new Error('插件名称过长或含控制字符。')
  return {
    descriptor,
    origins: [
      ...new Set([new URL(descriptor.loginUrl).origin, ...(descriptor.discoveryUrls ?? [])])
    ],
    sha256: createHash('sha256').update(raw).digest('hex')
  }
}

export function createRelayPluginService(adapters: {
  store: RelayPluginStore
  confirm(permission: RelayPluginPermission): Promise<boolean>
  context(record: RelayPluginRecord, signal: AbortSignal): OperationContext
  openBrowser(url: string): Promise<unknown>
  oauth?(url: string, signal: AbortSignal): Promise<OAuthResult>
  saveProfile(name: string, text: string): Promise<RelayStoredProfile>
  notify?(): void
  now?(): number
  downloadDescriptor?(source: DescriptorSource, signal: AbortSignal): Promise<string>
  pickDescriptor?(): Promise<string | undefined>
  readOpenedDescriptor?(): Promise<string | undefined>
}) {
  let pending = false,
    uncertain = false,
    operation: RelayPluginState['operation'],
    operationId: string | undefined,
    controller: AbortController | undefined,
    warnings: string[] = []
  const waiters: (() => void)[] = [],
    permits = new Set<() => void>(),
    activePermits = new Set<() => void>(),
    now = adapters.now ?? Date.now
  const check = (signal: AbortSignal): void => {
    if (signal.aborted) throw new Error('插件操作已取消。')
  }
  const grant = async (
    entry: RelayPluginEntry,
    signal: AbortSignal,
    authority?: ScheduleAuthority
  ): Promise<RelayPluginEntry | undefined> => {
    const candidate = entry.record.discovery
    if (!candidate) throw new Error('插件尚未完成网关发现。')
    const origins = [
      ...new Set([
        ...candidate.gateways,
        new URL(candidate.loginUrl ?? entry.record.descriptor.loginUrl).origin,
        ...(candidate.discoveryUrls ?? entry.record.descriptor.discoveryUrls ?? [])
      ])
    ]
    const missing = origins.filter((origin) => !entry.record.approvedOrigins.includes(origin))
    if (missing.length) {
      authority?.changed()
      if (!(await adapters.confirm({ action: 'gateways', record: entry.record, origins: missing })))
        return undefined
      check(signal)
    }
    const descriptor: IPluginDescriptor = {
      ...entry.record.descriptor,
      ...(candidate.loginUrl ? { loginUrl: candidate.loginUrl } : {})
    }
    if (candidate.discoveryUrls) {
      if (candidate.discoveryUrls.length) descriptor.discoveryUrls = candidate.discoveryUrls
      else delete descriptor.discoveryUrls
    }
    if (!missing.length && JSON.stringify(descriptor) === JSON.stringify(entry.record.descriptor))
      return entry
    authority?.changed()
    return adapters.store.save({
      ...entry,
      record: {
        ...entry.record,
        descriptor,
        approvedOrigins: [...new Set([...entry.record.approvedOrigins, ...origins])],
        updatedAt: now()
      }
    })
  }
  const withDiscovery = (
    record: RelayPluginRecord,
    discovery: IDiscoveryCandidate
  ): RelayPluginRecord => {
    const next = { ...record, discovery }
    if (
      next.lastGoodTarget &&
      !discovery.gateways.some(
        (gateway) => pluginTargetKey(discovery, gateway) === next.lastGoodTarget
      )
    )
      delete next.lastGoodTarget
    return next
  }
  const persistDiscovery = async (
    entry: RelayPluginEntry,
    discovery: IDiscoveryCandidate,
    signal: AbortSignal,
    authority?: ScheduleAuthority
  ): Promise<RelayPluginEntry> => {
    check(signal)
    if (stable(discovery) === stable(entry.record.discovery)) return entry
    await authority?.verify(signal, entry)
    const saved = await adapters.store.save(
      { ...entry, record: withDiscovery(entry.record, discovery) },
      authority
        ? {
            signal,
            verify: async () => {
              await authority.verify(signal, entry)
            }
          }
        : undefined
    )
    check(signal)
    // A new signed/source candidate changes the background authorization. Keep
    // its floor, then stop; never prompt or contact its targets in the background.
    authority?.changed()
    return saved
  }
  const recoverGateways = async <T>(
    initial: RelayPluginEntry,
    signal: AbortSignal,
    policy: RetryPolicy,
    rediscover: boolean,
    op: (target: GatewayTarget, requester: OperationContext['requester']) => Promise<T>,
    authority?: ScheduleAuthority
  ): Promise<{ entry: RelayPluginEntry; value: T; targetKey: string } | undefined> => {
    let entry = initial
    if (!entry.record.discovery) throw new Error('插件网关记录缺失。')
    const networkRecord = structuredClone(entry.record),
      base = adapters.context(networkRecord, signal)
    const requester: OperationContext['requester'] = {
      async request(...args) {
        check(signal)
        await authority?.verify(signal, entry)
        const response = await base.requester.request(...args)
        check(signal)
        await authority?.verify(signal, entry)
        return response
      }
    }
    const context: OperationContext = { ...base, requester },
      tried = new Set<string>()
    let last: unknown
    // Reuse fixed ac294's finite gateway policy. Enrollment never switches
    // after a response, timeout or possibly-sent request consumed its OAuth code.
    const switchable = (error: unknown): boolean => {
      if (!(error instanceof GatewayError)) return false
      if (policy === 'pre-send-only')
        return (
          error.kind === 'unreachable' && error.status === undefined && error.phase === 'pre-send'
        )
      return (
        error.kind === 'retired' ||
        (error.kind === 'unreachable' && error.status === undefined) ||
        (error.kind === 'transient' && error.status === undefined)
      )
    }
    const attempt = async (): Promise<
      { entry: RelayPluginEntry; value: T; targetKey: string } | undefined
    > => {
      const candidate = entry.record.discovery
      if (!candidate) throw new Error('插件网关记录缺失。')
      const gateways = [...candidate.gateways].sort(
        (a, b) =>
          Number(pluginTargetKey(candidate, b) === entry.record.lastGoodTarget) -
          Number(pluginTargetKey(candidate, a) === entry.record.lastGoodTarget)
      )
      for (const gateway of gateways) {
        const targetKey = pluginTargetKey(candidate, gateway)
        if (tried.has(targetKey) || !entry.record.approvedOrigins.includes(gateway)) continue
        tried.add(targetKey)
        check(signal)
        try {
          const value = await op({ gateway, endpoints: candidate.endpoints }, requester)
          check(signal)
          return { entry, value, targetKey }
        } catch (error) {
          check(signal)
          if (!switchable(error)) throw error
          last = error
        }
      }
      return undefined
    }
    const first = await attempt()
    if (first) return first
    if (!rediscover) throw last ?? new GatewayError('unreachable', 'all approved gateways failed')
    check(signal)
    const previous = entry.record.discovery
    const candidate = await discoverGateway(
      {
        sources: [
          ...new Set([
            new URL(entry.record.descriptor.loginUrl).origin,
            ...(entry.record.descriptor.discoveryUrls ?? [])
          ])
        ],
        ...(entry.record.descriptor.providerPubKey
          ? {
              signer: {
                pubKeyB64: entry.record.descriptor.providerPubKey,
                minSeq: previous?.seq,
                currentDigest: previous?.digest
              }
            }
          : {})
      },
      context
    )
    check(signal)
    entry = await persistDiscovery(entry, candidate, signal, authority)
    const allowed = await grant(entry, signal, authority)
    if (!allowed) return undefined
    entry = allowed
    // Keep the original context/deadline/route stickiness. Only an acknowledged
    // explicit grant may update this owned requester's allowed origins.
    Object.assign(networkRecord, entry.record)
    const second = await attempt()
    if (second) return second
    throw last ?? new GatewayError('unreachable', 'all gateways failed')
  }
  const fetch = async (
    entry: RelayPluginEntry,
    credential: RelayPluginCredential,
    signal: AbortSignal,
    authority?: ScheduleAuthority
  ): Promise<RelayPluginEntry | undefined> => {
    await authority?.verify(signal, entry)
    const allowed = await grant(entry, signal, authority)
    if (!allowed) return undefined
    entry = allowed
    const candidate = entry.record.discovery
    if (!candidate) throw new Error('插件网关记录缺失。')
    const recovered = await recoverGateways(
      entry,
      signal,
      'safe',
      true,
      (target, requester) =>
        fetchConfig(
          target,
          { deviceId: credential.keys.deviceId, privKeyB64: credential.keys.privKeyB64 },
          requester
        ),
      authority
    )
    if (!recovered) return undefined
    entry = recovered.entry
    const result: ConfigResult = recovered.value
    check(signal)
    if (result.discovery && entry.record.descriptor.providerPubKey) {
      const signed = parseSigned(result.discovery, entry.record.descriptor.providerPubKey),
        verdict = checkSeq(signed.payload.seq, signed.digest, {
          pubKeyB64: entry.record.descriptor.providerPubKey,
          minSeq: entry.record.discovery?.seq,
          currentDigest: entry.record.discovery?.digest
        })
      if (verdict === 'rollback' || verdict === 'equivocation')
        throw new Error('插件网关签名记录拒绝回退。')
      const discovery: IDiscoveryCandidate = {
        gateways: signed.payload.gateways,
        endpoints: signed.payload.endpoints,
        seq: signed.payload.seq,
        digest: signed.digest,
        ...(signed.payload.loginUrl ? { loginUrl: signed.payload.loginUrl } : {}),
        ...(signed.payload.discoveryUrls ? { discoveryUrls: signed.payload.discoveryUrls } : {})
      }
      entry = await persistDiscovery(entry, discovery, signal, authority)
      const next = await grant(entry, signal, authority)
      if (!next) return undefined
      entry = next
    }
    const currentCandidate = entry.record.discovery
    if (
      currentCandidate?.gateways.some(
        (gateway) => pluginTargetKey(currentCandidate, gateway) === recovered.targetKey
      )
    )
      entry = { ...entry, record: { ...entry.record, lastGoodTarget: recovered.targetKey } }
    if (!authority)
      entry = await adapters.store.withCredential(entry, { ...credential, phase: 'active' })
    const saved = await adapters.store.saveSubscription(
      { ...entry, record: { ...entry.record, updatedAt: now(), lastError: undefined } },
      result.yaml,
      authority
        ? {
            signal,
            verify: async () => {
              await authority.verify(signal, entry)
            }
          }
        : undefined
    )
    authority?.accept(saved)
    return saved
  }
  const run = async <T>(
    kind: NonNullable<RelayPluginState['operation']>,
    id: string | undefined,
    fn: (signal: AbortSignal) => Promise<T>,
    parentSignal?: AbortSignal
  ): Promise<T> => {
    if (pending) throw new Error('请先结束当前插件操作。')
    pending = true
    operation = kind
    operationId = id
    uncertain = false
    warnings = []
    controller = new AbortController()
    const active = controller,
      timer = setTimeout(() => active.abort(), kind === 'login' ? 360000 : 120000)
    const abort = (): void => active.abort()
    parentSignal?.addEventListener('abort', abort, { once: true })
    if (parentSignal?.aborted) abort()
    timer.unref?.()
    try {
      return await fn(active.signal)
    } catch (error) {
      if (error instanceof RelayPluginStorageUncertain) uncertain = true
      warnings = [
        error instanceof GatewayError && error.kind === 'revoked'
          ? '服务商已撤销设备；旧订阅保留，需要重新登录。'
          : '插件操作未确认，旧订阅及已有凭据保留；没有启用配置、重载或重启核心。'
      ]
      if (id) {
        try {
          const entry = await adapters.store.read(id)
          if (error instanceof GatewayError && error.kind === 'revoked') {
            await adapters.store.save({
              ...entry,
              encryptedCredential: undefined,
              record: {
                ...entry.record,
                status: 'needs-reauth',
                lastError: 'credentials',
                updatedAt: now()
              }
            })
          } else
            await adapters.store.save({
              ...entry,
              record: {
                ...entry.record,
                lastError: active.signal.aborted
                  ? 'cancelled'
                  : error instanceof RelayPluginStorageUncertain
                    ? 'storage'
                    : 'network',
                updatedAt: now()
              }
            })
        } catch {
          uncertain = true
        }
      }
      throw new Error(
        active.signal.aborted
          ? '插件操作已取消；请读取状态核对。'
          : '插件操作未确认；请读取状态核对。'
      )
    } finally {
      clearTimeout(timer)
      parentSignal?.removeEventListener('abort', abort)
      pending = false
      controller = undefined
      operation = undefined
      operationId = undefined
      waiters.splice(0).forEach((resolve) => resolve())
      adapters.notify?.()
    }
  }
  return {
    preview,
    async previewOpenedFile(): Promise<RelayPluginRemotePreview> {
      return run<RelayPluginRemotePreview>('preview-file', undefined, async (signal) => {
        if (!adapters.readOpenedDescriptor) throw new Error('系统文件入口尚未接通。')
        const text = await adapters.readOpenedDescriptor()
        check(signal)
        return text === undefined
          ? { status: 'cancelled' }
          : { status: 'preview', preview: preview(text), text }
      })
    },
    async previewFile(): Promise<RelayPluginRemotePreview> {
      return run<RelayPluginRemotePreview>('preview-file', undefined, async (signal) => {
        if (!adapters.pickDescriptor) throw new Error('本地描述文件导入尚未接通。')
        const text = await adapters.pickDescriptor()
        check(signal)
        return text === undefined
          ? { status: 'cancelled' }
          : { status: 'preview', preview: preview(text), text }
      })
    },
    async previewRemote(raw: unknown): Promise<RelayPluginRemotePreview> {
      const source = descriptorSource(raw)
      return run<RelayPluginRemotePreview>('preview-remote', undefined, async (signal) => {
        const preparedAt = now()
        if (
          !(await adapters.confirm({
            action: 'preview-remote',
            origins: [new URL(source.url).origin],
            route: source.route
          }))
        )
          return { status: 'cancelled' }
        check(signal)
        if (now() < preparedAt || now() - preparedAt > 60000)
          throw new Error('描述下载确认已过期。')
        if (!adapters.downloadDescriptor) throw new Error('描述下载尚未接通。')
        const text = await adapters.downloadDescriptor(source, signal)
        check(signal)
        return { status: 'preview', preview: preview(text), text }
      })
    },
    // Main-process-only capability: never return this object over IPC.
    async prepareSchedule(raw: unknown): Promise<PluginSchedulePermit> {
      const id = pluginId(raw)
      let bound = await adapters.store.read(id),
        activated = false,
        changed = false,
        credential: RelayPluginCredential | undefined
      if (
        bound.record.status !== 'active' ||
        !bound.record.subscription ||
        !bound.record.discovery ||
        !bound.encryptedCredential
      )
        throw new Error('插件需要先登录并保存有效订阅。')
      const lifetime = new AbortController(),
        fingerprint = (entry: RelayPluginEntry): string =>
          createHash('sha256')
            .update(
              JSON.stringify({
                id: entry.record.id,
                descriptor: entry.record.descriptor,
                route: entry.record.route,
                origins: entry.record.approvedOrigins,
                discovery: entry.record.discovery,
                status: entry.record.status,
                credential: entry.encryptedCredential
              })
            )
            .digest('hex'),
        permissionFingerprint = fingerprint(bound),
        revokePermit = (): void => {
          activated = false
          credential = undefined
          lifetime.abort()
          permits.delete(revokePermit)
          activePermits.delete(revokePermit)
        },
        authority: ScheduleAuthority = {
          changed() {
            changed = true
            throw new Error('插件调度授权对应的记录已改变。')
          },
          async verify(signal, expected) {
            check(signal)
            check(lifetime.signal)
            const current = await adapters.store.read(id)
            if (
              current.revision !== bound.revision ||
              (expected && expected.revision !== bound.revision) ||
              fingerprint(current) !== permissionFingerprint
            )
              return authority.changed()
            check(signal)
            check(lifetime.signal)
            return current
          },
          accept(entry) {
            if (fingerprint(entry) !== permissionFingerprint) authority.changed()
            bound = entry
          }
        }
      permits.add(revokePermit)
      return {
        permission: {
          id,
          name: bound.record.descriptor.provider.name,
          route: bound.record.route,
          origins: [...bound.record.approvedOrigins],
          revision: bound.revision,
          discoveryRevision: createHash('sha256')
            .update(JSON.stringify(bound.record.discovery))
            .digest('hex')
        },
        async activate() {
          if (activated || lifetime.signal.aborted) throw new Error('调度授权已失效。')
          await authority.verify(lifetime.signal)
          credential = await adapters.store.credential(bound)
          if (!credential || credential.phase !== 'active') {
            revokePermit()
            throw new Error('插件凭据需要人工恢复，尚未启动调度。')
          }
          await authority.verify(lifetime.signal)
          activated = true
          activePermits.add(revokePermit)
        },
        async run() {
          if (!activated || !credential || lifetime.signal.aborted) return { status: 'cancelled' }
          const result = await run<Awaited<ReturnType<PluginSchedulePermit['run']>>>(
            'update',
            id,
            async (signal) => {
              try {
                const entry = await authority.verify(signal),
                  keys = credential
                if (!keys) return { status: 'cancelled' }
                await fetch(entry, keys, signal, authority)
                return { status: lifetime.signal.aborted ? 'cancelled' : 'updated' }
              } catch (error) {
                if (changed) return { status: 'changed' }
                if (lifetime.signal.aborted || signal.aborted) return { status: 'cancelled' }
                if (error instanceof RelayPluginStorageUncertain) {
                  uncertain = true
                  warnings = ['插件后台保存未确认，调度已停止；请人工核对，旧订阅快照保留。']
                  return { status: 'uncertain' }
                }
                try {
                  const current = await authority.verify(lifetime.signal),
                    expired =
                      error instanceof GatewayError &&
                      (error.kind === 'revoked' || error.status === 401 || error.status === 403)
                  const saved = await adapters.store.save(
                    {
                      ...current,
                      ...(error instanceof GatewayError && error.kind === 'revoked'
                        ? { encryptedCredential: undefined }
                        : {}),
                      record: {
                        ...current.record,
                        ...(expired ? { status: 'needs-reauth' as const } : {}),
                        lastError: expired ? 'credentials' : 'network',
                        updatedAt: now()
                      }
                    },
                    {
                      signal: lifetime.signal,
                      verify: async () => {
                        await authority.verify(lifetime.signal, current)
                      }
                    }
                  )
                  if (expired) {
                    warnings = ['插件后台凭据已失效，调度已停止；请人工登录，旧订阅快照保留。']
                    return { status: 'credentials' }
                  }
                  authority.accept(saved)
                  warnings = ['插件后台更新失败，保留旧订阅并延后重试。']
                  return { status: 'failed' }
                } catch (failure) {
                  if (changed) return { status: 'changed' }
                  if (lifetime.signal.aborted) return { status: 'cancelled' }
                  uncertain = failure instanceof RelayPluginStorageUncertain
                  return { status: uncertain ? 'uncertain' : 'changed' }
                }
              }
            },
            lifetime.signal
          )
          if (result.status !== 'updated' && result.status !== 'failed') revokePermit()
          return result
        },
        revoke: revokePermit
      }
    },
    isBusy: (): boolean => pending,
    isBlocking: (): boolean => pending,
    whenIdle: (): Promise<void> =>
      pending ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(),
    async state(): Promise<RelayPluginState> {
      const records = await adapters.store.list()
      return {
        pending,
        uncertain,
        operation,
        operationId,
        records,
        warnings: [...warnings],
        automaticUpdatesEnabled: activePermits.size > 0
      }
    },
    cancel(): { status: 'idle' | 'cancelling' } {
      controller?.abort()
      return { status: pending ? 'cancelling' : 'idle' }
    },
    async requestClose(): Promise<void> {
      permits.forEach((revokePermit) => revokePermit())
      controller?.abort()
      if (pending) await new Promise<void>((resolve) => waiters.push(resolve))
    },
    async install(raw: unknown): Promise<RelayPluginResult> {
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        Object.keys(raw).sort().join(',') !== 'route,text'
      )
        throw new Error('插件安装参数无效。')
      const input = raw as Record<string, unknown>,
        plan = preview(input.text),
        route = pluginRoute(input.route)
      return run<RelayPluginResult>('install', undefined, async (signal) => {
        if (
          !(await adapters.confirm({
            action: 'install',
            preview: plan,
            origins: plan.origins,
            route
          }))
        )
          return { status: 'cancelled' }
        check(signal)
        const id = randomUUID()
        await adapters.store.create({
          id,
          descriptor: plan.descriptor,
          route,
          approvedOrigins: plan.origins,
          status: 'needs-login',
          createdAt: now(),
          updatedAt: now()
        })
        return { status: 'installed', id }
      })
    },
    async login(raw: unknown): Promise<RelayPluginResult> {
      const id = pluginId(raw)
      return run<RelayPluginResult>('login', id, async (signal) => {
        let entry = await adapters.store.read(id)
        if (
          !(await adapters.confirm({
            action: 'login',
            record: entry.record,
            origins: entry.record.approvedOrigins
          }))
        )
          return { status: 'cancelled' }
        check(signal)
        await adapters.store.readyForCredentials()
        let credential = await adapters.store.credential(entry)
        if (credential) {
          try {
            const updated = await fetch(entry, credential, signal)
            return updated ? { status: 'updated', id } : { status: 'cancelled' }
          } catch (error) {
            if (!(error instanceof GatewayError) || error.kind !== 'revoked') throw error
            entry = await adapters.store.read(id)
            entry = await adapters.store.save({
              ...entry,
              encryptedCredential: undefined,
              record: { ...entry.record, status: 'needs-reauth' }
            })
            credential = undefined
          }
        }
        if (!entry.record.discovery) {
          const candidate = await discoverGateway(
            {
              sources: [
                new URL(entry.record.descriptor.loginUrl).origin,
                ...(entry.record.descriptor.discoveryUrls ?? [])
              ],
              ...(entry.record.descriptor.providerPubKey
                ? { signer: { pubKeyB64: entry.record.descriptor.providerPubKey } }
                : {})
            },
            adapters.context(entry.record, signal)
          )
          check(signal)
          entry = await adapters.store.save({
            ...entry,
            record: withDiscovery(entry.record, candidate)
          })
        }
        const allowed = await grant(entry, signal)
        if (!allowed) return { status: 'cancelled' }
        entry = allowed
        const oauth = adapters.oauth
          ? await adapters.oauth(entry.record.descriptor.loginUrl, signal)
          : await browserLogin(entry.record.descriptor.loginUrl, {
              open: adapters.openBrowser,
              signal
            })
        check(signal)
        credential = { keys: generateDevice(), phase: 'enrollment-pending' }
        // Save encrypted keys before a request that may have reached the server.
        entry = await adapters.store.withCredential(
          { ...entry, record: { ...entry.record, status: 'uncertain' } },
          credential
        )
        const recovered = await recoverGateways(
          entry,
          signal,
          'pre-send-only',
          true,
          (target, requester) =>
            enroll(
              target,
              {
                code: oauth.code,
                code_verifier: oauth.verifier,
                redirect_uri: oauth.redirectUri,
                client_id: CLIENT_ID,
                devicePubKey: credential.keys.pubKeyB64,
                deviceId: credential.keys.deviceId
              },
              requester
            )
        )
        if (!recovered) return { status: 'cancelled' }
        entry = {
          ...recovered.entry,
          record: { ...recovered.entry.record, lastGoodTarget: recovered.targetKey }
        }
        check(signal)
        entry = await adapters.store.withCredential(
          { ...entry, record: { ...entry.record, status: 'needs-login' } },
          { ...credential, phase: 'active' }
        )
        const updated = await fetch(entry, credential, signal)
        return updated ? { status: 'updated', id } : { status: 'cancelled' }
      })
    },
    async rediscover(raw: unknown): Promise<RelayPluginResult> {
      const id = pluginId(raw)
      return run<RelayPluginResult>('rediscover', id, async (signal) => {
        let entry = await adapters.store.read(id)
        const sources = [
            ...new Set([
              new URL(entry.record.descriptor.loginUrl).origin,
              ...(entry.record.descriptor.discoveryUrls ?? [])
            ])
          ],
          preparedAt = now()
        if (
          !(await adapters.confirm({
            action: 'rediscover',
            record: entry.record,
            origins: sources
          }))
        )
          return { status: 'cancelled' }
        check(signal)
        if (now() < preparedAt || now() - preparedAt > 60000)
          throw new Error('网关发现确认已过期。')
        if ((await adapters.store.read(id)).revision !== entry.revision)
          throw new Error('插件记录已变化。')
        const previous = entry.record.discovery
        const candidate = await discoverGateway(
          {
            sources,
            ...(entry.record.descriptor.providerPubKey
              ? {
                  signer: {
                    pubKeyB64: entry.record.descriptor.providerPubKey,
                    minSeq: previous?.seq,
                    currentDigest: previous?.digest
                  }
                }
              : {})
          },
          adapters.context(entry.record, signal)
        )
        check(signal)
        if (stable(candidate) !== stable(previous) || entry.record.lastError) {
          // Preserve the observed signed floor before requesting new-origin permissions.
          entry = await adapters.store.save({
            ...entry,
            record: {
              ...withDiscovery(entry.record, candidate),
              lastError: undefined,
              updatedAt: now()
            }
          })
        }
        const allowed = await grant(entry, signal)
        return allowed ? { status: 'rediscovered', id } : { status: 'cancelled' }
      })
    },
    async update(raw: unknown): Promise<RelayPluginResult> {
      const id = pluginId(raw)
      return run<RelayPluginResult>('update', id, async (signal) => {
        let entry = await adapters.store.read(id)
        if (
          !(await adapters.confirm({
            action: 'update',
            record: entry.record,
            origins: entry.record.approvedOrigins
          }))
        )
          return { status: 'cancelled' }
        check(signal)
        const allowed = await grant(entry, signal)
        if (!allowed) return { status: 'cancelled' }
        entry = allowed
        const credential = await adapters.store.credential(entry)
        if (!credential) throw new Error('插件需要登录。')
        const updated = await fetch(entry, credential, signal)
        return updated ? { status: 'updated', id } : { status: 'cancelled' }
      })
    },
    async saveProfile(raw: unknown): Promise<RelayPluginResult> {
      const id = pluginId(raw)
      return run<RelayPluginResult>('save-profile', id, async (signal) => {
        const { record, text } = await adapters.store.subscription(id)
        if (!(await adapters.confirm({ action: 'save-profile', record, origins: [] })))
          return { status: 'cancelled' }
        check(signal)
        return {
          status: 'saved-profile',
          id,
          profile: await adapters.saveProfile(record.descriptor.provider.name, text)
        }
      })
    },
    async remove(raw: unknown): Promise<RelayPluginResult> {
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        Object.keys(raw).sort().join(',') !== 'id,localOnly'
      )
        throw new Error('插件移除参数无效。')
      const input = raw as Record<string, unknown>,
        id = pluginId(input.id)
      if (typeof input.localOnly !== 'boolean') throw new Error('移除模式无效。')
      const localOnly = input.localOnly
      return run<RelayPluginResult>('remove', id, async (signal) => {
        let entry = await adapters.store.read(id)
        if (
          !(await adapters.confirm({
            action: 'remove',
            record: entry.record,
            origins: entry.record.approvedOrigins,
            localOnly
          }))
        )
          return { status: 'cancelled' }
        check(signal)
        if (!localOnly) {
          const credential = await adapters.store.credential(entry)
          if (credential) {
            // The removal confirmation authorizes only the current approved
            // list. Do not discover or expand origin grants in this action.
            const recovered = await recoverGateways(
              entry,
              signal,
              'safe',
              false,
              async (target, requester) => {
                try {
                  await revoke(
                    target,
                    { deviceId: credential.keys.deviceId, privKeyB64: credential.keys.privKeyB64 },
                    requester
                  )
                } catch (error) {
                  if (!(error instanceof GatewayError) || error.kind !== 'revoked') throw error
                }
              }
            )
            if (!recovered) return { status: 'cancelled' }
            entry = recovered.entry
            check(signal)
          }
        }
        check(signal)
        await adapters.store.remove(entry)
        return { status: 'removed', id }
      })
    }
  }
}
