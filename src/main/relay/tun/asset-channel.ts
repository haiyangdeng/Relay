import type { TunSessionBinding } from './service'
import type { TunRuntimeReadIO } from './runtime-channel'
import { parseTunHostFrame } from './wire-json'

export interface TunAssetIO extends TunRuntimeReadIO {
  close(): void
}
export type TunAssetIdentity = TunSessionBinding & {
  launchClientSHA256: string
  installationRevision: string
}
type Action = 'read' | 'replace' | 'cancel' | 'discardBlob'
type FailureStatus =
  'busy' | 'cancelled' | 'uncertain' | 'stale' | 'expired' | 'unsupported' | 'unavailable'
export type TunAssetChannelResult<Snapshot> =
  { status: 'snapshot' | 'updated' | 'unchanged'; snapshot: Snapshot } | { status: FailureStatus }
interface TunAssetReply<Snapshot> {
  status: TunAssetChannelResult<Snapshot>['status'] | 'cancelling' | 'discarded' | 'absent'
  pending: boolean
  snapshot?: Snapshot
}
type Status = TunAssetReply<unknown>['status']
export interface TunAssetProtocol<Snapshot, Mutation, Ticket> {
  capability:
    | 'runtime-resources-v1'
    | 'runtime-rule-providers-v1'
    | 'smart-state-v1'
    | 'runtime-smart-tools-v1'
  frameByteLimit: 8192 | 262144
  label: '地理资源' | '规则提供者' | 'Smart状态' | 'Smart工具'
  mutation(raw: unknown): Mutation
  ticket(raw: unknown): Ticket
  snapshot(raw: unknown, status: 'snapshot' | 'updated' | 'unchanged'): Snapshot
  verifyCommit(snapshot: Snapshot, selected: Mutation, status: 'updated' | 'unchanged'): void
}
export interface TunAssetChannel<Snapshot, Mutation, Ticket> {
  read(signal: AbortSignal, assertUI: () => void): Promise<TunAssetChannelResult<Snapshot>>
  replace(
    input: Mutation,
    signal: AbortSignal,
    assertUI: () => void
  ): Promise<TunAssetChannelResult<Snapshot>>
  discardBlob(ticket: Ticket): Promise<'discarded' | 'absent' | 'busy' | 'unavailable'>
  cancel(): Promise<void>
  invalidate(): void
  isAvailable(): boolean
  isBusy(): boolean
  whenIdle(): Promise<void>
}
interface Work {
  action: 'read' | 'replace' | 'discardBlob'
  deadline: number
  logicalID?: number
  requested: boolean
  cancelled: boolean
  cancelAck?: Promise<TunAssetReply<unknown> | undefined>
  assertUI(): void
  wake(): void
}
const hash = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v),
  uuid = (v: unknown): v is string =>
    typeof v === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(v),
  object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === 'object' && !Array.isArray(v),
  keys = (v: Record<string, unknown>, fields: string): boolean =>
    Object.keys(v).sort().join(',') === fields.split(',').sort().join(','),
  integer = (v: unknown, min: number, max: number): v is number =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max

// Reuse the existing rules broker's bound inherited-pipe framing and guarded
// single-flight lifecycle. Native alone owns Core prepare/commit/readback.
export function createTunAssetChannel<Snapshot, Mutation extends object, Ticket extends object>(
  io: TunAssetIO,
  identity: TunAssetIdentity,
  definition: TunAssetProtocol<Snapshot, Mutation, Ticket>,
  timeout = 30000
): TunAssetChannel<Snapshot, Mutation, Ticket> {
  const protocol = Object.freeze({ ...definition })
  type Reply = TunAssetReply<Snapshot>
  if (
    (protocol.capability !== 'runtime-resources-v1' &&
      protocol.capability !== 'runtime-rule-providers-v1' &&
      protocol.capability !== 'smart-state-v1' &&
      protocol.capability !== 'runtime-smart-tools-v1') ||
    protocol.frameByteLimit !==
      (['runtime-rule-providers-v1', 'runtime-smart-tools-v1'].includes(protocol.capability)
        ? 262144
        : 8192)
  )
    throw new Error('资产通道能力与帧预算不匹配。')
  const smartState = protocol.capability === 'smart-state-v1',
    smartTools = protocol.capability === 'runtime-smart-tools-v1',
    wireAction = (action: Action): string =>
      smartTools && action === 'read'
        ? 'weights'
        : smartTools && action === 'replace'
          ? 'clear-cache'
          : smartState && action === 'read'
            ? 'export'
            : smartState && action === 'replace'
              ? 'ack'
              : action
  const binding = {
      sessionId: identity.sessionId,
      evidenceSHA256: identity.evidenceSHA256,
      runtimeConfigurationSHA256: identity.runtimeConfigurationSHA256
    },
    clientSHA256 = identity.launchClientSHA256,
    installationRevision = identity.installationRevision
  if (
    !uuid(binding.sessionId) ||
    !hash(binding.evidenceSHA256) ||
    !hash(binding.runtimeConfigurationSHA256) ||
    !hash(clientSHA256) ||
    !hash(installationRevision) ||
    !integer(timeout, 1, 120000)
  )
    throw new Error(`${protocol.label}通道身份或期限无效。`)
  let available = false,
    failed = false,
    nextID = 0,
    buffer = Buffer.alloc(0),
    active: Work | undefined
  const pending = new Map<
      number,
      { action: Action; resolve(reply: Reply): void; reject(): void }
    >(),
    idle: (() => void)[] = []
  let helloDone!: (value: boolean) => void
  const hello = new Promise<boolean>((resolve) => (helloDone = resolve)),
    helloTimer = setTimeout(() => fail(), Math.min(timeout, 3000))
  const fail = (): void => {
    if (failed) return
    failed = true
    available = false
    clearTimeout(helloTimer)
    buffer = Buffer.alloc(0)
    helloDone(false)
    for (const waiter of pending.values()) waiter.reject()
    pending.clear()
    try {
      io.close()
    } catch {
      /* No lifecycle or network fallback. */
    }
  }
  const check = (work: Work): void => {
    try {
      work.assertUI()
    } catch {
      work.cancelled = true
    }
    if (failed || active !== work || work.cancelled || performance.now() >= work.deadline)
      throw new Error(`${protocol.label}操作范围已失效。`)
  }
  const send = (work: Work, action: Action, fields: object = {}): Promise<Reply> => {
    if (nextID === 0x7fffffff) fail()
    if (failed) return Promise.reject(new Error(`${protocol.label}管道已失效。`))
    const id = ++nextID,
      frame =
        JSON.stringify({ version: 1, id, action: wireAction(action), ...binding, ...fields }) + '\n'
    if (Buffer.byteLength(frame) - 1 > protocol.frameByteLimit)
      return Promise.reject(new Error(`${protocol.label}请求超限。`))
    return new Promise<Reply>((resolve, reject) => {
      pending.set(id, {
        action,
        resolve,
        reject: () => reject(new Error(`${protocol.label}管道已结束。`))
      })
      try {
        if (action === 'cancel') {
          if (failed || performance.now() >= work.deadline) throw new Error('取消回执期限已到。')
        } else check(work)
        if (action !== 'cancel') {
          work.logicalID = id
          work.requested = true
        }
        io.write(frame)
      } catch (error) {
        pending.delete(id)
        reject(error)
        if (work.requested) fail()
      }
    })
  }
  const cancelWork = (work: Work): void => {
    if (work.action === 'discardBlob') return
    work.cancelled = true
    work.wake()
    if (work.logicalID && work.requested && !work.cancelAck && !failed)
      work.cancelAck = send(work, 'cancel', { operationId: work.logicalID }).catch(() => undefined)
  }
  const receive = (bytes: Buffer): void => {
    const raw = parseTunHostFrame(bytes, protocol.frameByteLimit)
    if (
      !object(raw) ||
      raw.version !== 1 ||
      raw.sessionId !== binding.sessionId ||
      raw.evidenceSHA256 !== binding.evidenceSHA256 ||
      raw.runtimeConfigurationSHA256 !== binding.runtimeConfigurationSHA256
    )
      throw new Error(`${protocol.label}响应身份无效。`)
    if (!available) {
      if (
        failed ||
        !keys(
          raw,
          'version,kind,capability,sessionId,evidenceSHA256,runtimeConfigurationSHA256,launchClientSHA256,installationRevision'
        ) ||
        raw.kind !== 'hello' ||
        raw.capability !== protocol.capability ||
        raw.launchClientSHA256 !== clientSHA256 ||
        raw.installationRevision !== installationRevision
      )
        throw new Error(`${protocol.label}能力未确认。`)
      available = true
      clearTimeout(helloTimer)
      helloDone(true)
      return
    }
    if (!integer(raw.id, 1, 0x7fffffff)) throw new Error(`${protocol.label}响应ID无效。`)
    const waiter = pending.get(raw.id)
    if (!waiter || raw.action !== wireAction(waiter.action) || typeof raw.pending !== 'boolean')
      throw new Error(`${protocol.label}响应不匹配。`)
    const status =
      smartTools && raw.status === 'weights'
        ? 'snapshot'
        : smartTools && raw.status === 'accepted'
          ? 'updated'
          : smartState && raw.status === 'exported'
            ? 'snapshot'
            : smartState && raw.status === 'acknowledged'
              ? 'updated'
              : raw.status
    if (
      (smartState || smartTools) &&
      ['snapshot', 'updated', 'unchanged'].includes(String(raw.status))
    )
      throw new Error('Smart状态响应动作无效。')
    const withSnapshot = status === 'snapshot' || status === 'updated' || status === 'unchanged',
      allowed: Record<Action, readonly string[]> = {
        read: [
          'snapshot',
          'busy',
          'cancelled',
          'uncertain',
          'stale',
          'expired',
          'unsupported',
          'unavailable'
        ],
        replace: [
          'updated',
          'unchanged',
          'busy',
          'cancelled',
          'uncertain',
          'stale',
          'expired',
          'unsupported',
          'unavailable'
        ],
        cancel: ['cancelled', 'cancelling', 'uncertain', 'stale', 'unavailable'],
        discardBlob: ['discarded', 'absent', 'busy', 'unavailable']
      }
    if (
      !keys(
        raw,
        'version,id,action,sessionId,evidenceSHA256,runtimeConfigurationSHA256,status,pending' +
          (withSnapshot ? ',snapshot' : '')
      ) ||
      typeof status !== 'string' ||
      !allowed[waiter.action].includes(status) ||
      (waiter.action !== 'cancel' && status !== 'busy' && raw.pending) ||
      (waiter.action === 'discardBlob' && raw.pending) ||
      (status === 'cancelling' && !raw.pending)
    )
      throw new Error(`${protocol.label}响应字段或状态无效。`)
    const reply: Reply = { status: status as Status, pending: raw.pending }
    if (withSnapshot)
      reply.snapshot = protocol.snapshot(
        raw.snapshot,
        status as 'snapshot' | 'updated' | 'unchanged'
      )
    pending.delete(raw.id)
    waiter.resolve(reply)
  }
  io.onGone(fail)
  io.onFault(fail)
  io.onData((chunk) => {
    if (failed) return
    let offset = 0
    try {
      while (offset < chunk.length) {
        const newline = chunk.indexOf(10, offset),
          end = newline < 0 ? chunk.length : newline,
          part = chunk.subarray(offset, end)
        if (buffer.length + part.length > protocol.frameByteLimit)
          throw new Error(`${protocol.label}响应超限。`)
        buffer = Buffer.concat([buffer, part])
        if (newline < 0) return
        const line = buffer
        buffer = Buffer.alloc(0)
        offset = newline + 1
        receive(line)
      }
    } catch {
      fail()
    }
  })
  const whenIdle = (): Promise<void> =>
    active ? new Promise((resolve) => idle.push(resolve)) : Promise.resolve()
  const run = async (
    action: Work['action'],
    value: Mutation | Ticket | undefined,
    signal: AbortSignal,
    assertUI: () => void
  ): Promise<Reply> => {
    if (active) return { status: 'busy', pending: true }
    if (signal.aborted) return { status: 'cancelled', pending: false }
    let wake!: () => void
    const cancelled = new Promise<boolean>((resolve) => (wake = () => resolve(false))),
      work: Work = {
        action,
        deadline: performance.now() + timeout,
        requested: false,
        cancelled: false,
        assertUI,
        wake
      },
      abort = (): void => cancelWork(work),
      timer = setTimeout(fail, timeout)
    active = work
    signal.addEventListener('abort', abort, { once: true })
    try {
      if (!(await Promise.race([hello, cancelled])))
        return { status: work.cancelled ? 'cancelled' : 'unsupported', pending: false }
      check(work)
      const reply = await send(work, action, value ? { ...value } : undefined)
      if (work.cancelAck) await work.cancelAck
      if (work.cancelled) {
        return {
          status: action === 'replace' && reply.status !== 'cancelled' ? 'uncertain' : 'cancelled',
          pending: false
        }
      }
      check(work)
      if (action === 'replace' && value && reply.snapshot) {
        if (reply.status !== 'updated' && reply.status !== 'unchanged')
          throw new Error('资源提交状态不匹配。')
        try {
          protocol.verifyCommit(reply.snapshot, value as Mutation, reply.status)
        } catch {
          fail()
          throw new Error('资源提交回执范围不匹配。')
        }
        // A newly introduced protocol hook cannot bypass the final UI/lease check.
        check(work)
      }
      return reply
    } catch {
      if (!failed) {
        cancelWork(work)
        await work.cancelAck
      }
      return {
        status:
          action === 'replace' && work.requested
            ? 'uncertain'
            : performance.now() >= work.deadline
              ? 'expired'
              : work.cancelled
                ? 'cancelled'
                : 'unavailable',
        pending: false
      }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (active === work) active = undefined
      for (const resolve of idle.splice(0)) resolve()
    }
  }
  const publicResult = (reply: Reply): TunAssetChannelResult<Snapshot> => {
    if (
      (reply.status === 'snapshot' || reply.status === 'updated' || reply.status === 'unchanged') &&
      reply.snapshot
    )
      return { status: reply.status, snapshot: reply.snapshot }
    if (
      ['busy', 'cancelled', 'uncertain', 'stale', 'expired', 'unsupported', 'unavailable'].includes(
        reply.status
      )
    )
      return {
        status: reply.status as Exclude<
          TunAssetChannelResult<Snapshot>['status'],
          'snapshot' | 'updated' | 'unchanged'
        >
      }
    return { status: 'unavailable' }
  }
  return {
    read: async (signal, assertUI) => publicResult(await run('read', undefined, signal, assertUI)),
    async replace(input, signal, assertUI) {
      let selected: Mutation
      try {
        selected = protocol.mutation(input)
      } catch {
        return { status: 'unavailable' }
      }
      return publicResult(await run('replace', selected, signal, assertUI))
    },
    async discardBlob(input) {
      if (smartState || smartTools) return 'unavailable'
      let selected: Ticket
      try {
        selected = protocol.ticket(input)
      } catch {
        return 'unavailable'
      }
      const reply = await run('discardBlob', selected, new AbortController().signal, () => {})
      return reply.status === 'discarded' || reply.status === 'absent' || reply.status === 'busy'
        ? reply.status
        : 'unavailable'
    },
    async cancel() {
      if (active) cancelWork(active)
      await whenIdle()
    },
    invalidate: fail,
    isAvailable: () => available && !failed,
    isBusy: () => !!active,
    whenIdle
  }
}
