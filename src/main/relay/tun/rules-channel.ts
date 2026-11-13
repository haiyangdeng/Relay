import type { LocalProxyRule } from '../../../shared/relay/local-proxy'
import type { TunSessionBinding } from './service'
import type { TunRuntimeReadIO } from './runtime-channel'
import { parseTunHostFrame, tunHostFrameByteLimit } from './wire-json'

export interface TunRulesSnapshot {
  configurationRevision: string
  rulesSHA256: string
  rules: LocalProxyRule[]
}
export interface TunRulesMutation {
  configurationRevision: string
  rulesSHA256: string
  index: number
  disabled: boolean
}
export type TunRulesResult =
  | { status: 'snapshot' | 'changed' | 'unchanged'; snapshot: TunRulesSnapshot }
  | {
      status:
        'busy' | 'cancelled' | 'uncertain' | 'stale' | 'expired' | 'unsupported' | 'unavailable'
    }
export interface TunRulesIO extends TunRuntimeReadIO {
  // Only FD5/6 may be closed here, never lifecycle/control/capture pipes.
  close(): void
}
export interface TunRulesChannel {
  read(signal: AbortSignal, assertUI: () => void): Promise<TunRulesResult>
  // Main must finish its independent default-cancel Native confirmation first.
  // The short prepare nonce never leaves this private broker.
  change(
    input: TunRulesMutation,
    signal: AbortSignal,
    assertUI: () => void
  ): Promise<TunRulesResult>
  cancel(): Promise<void>
  invalidate(): void
  isAvailable(): boolean
  isBusy(): boolean
  whenIdle(): Promise<void>
}

const tableLimit = 2 * 1024 * 1024,
  responseLimit = tableLimit + tunHostFrameByteLimit,
  hash = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value),
  uuid = (value: unknown): value is string =>
    typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value),
  object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value),
  keys = (value: Record<string, unknown>, expected: string): boolean =>
    Object.keys(value).sort().join(',') === expected.split(',').sort().join(','),
  integer = (value: unknown, minimum: number, maximum: number): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum

type Action = 'read' | 'prepare' | 'commit' | 'cancel'
type Status = TunRulesResult['status'] | 'prepared' | 'cancelling'
interface Reply {
  status: Status
  pending: boolean
  snapshot?: TunRulesSnapshot
  prepared?: {
    nonce: string
    operationId: number
    leaseMilliseconds: number
    configurationRevision: string
    rulesSHA256: string
    index: number
    disabled: boolean
  }
}
interface Work {
  deadline: number
  logicalID?: number
  nativeRequested: boolean
  commitAttempted: boolean
  cancelled: boolean
  cancelAck?: Promise<Reply | undefined>
  wake(): void
  assertUI(): void
}

function snapshot(raw: unknown): TunRulesSnapshot {
  if (
    !object(raw) ||
    !keys(raw, 'configurationRevision,rulesSHA256,rules') ||
    !hash(raw.configurationRevision) ||
    !hash(raw.rulesSHA256) ||
    !Array.isArray(raw.rules) ||
    raw.rules.length > 10000 ||
    Buffer.byteLength(JSON.stringify(raw.rules)) > tableLimit
  )
    throw new Error('规则表回执无效。')
  const rules = raw.rules.map((row: unknown, index): LocalProxyRule => {
    if (
      !object(row) ||
      !keys(
        row,
        'index,type,payload,proxy' +
          ('size' in row ? ',size' : '') +
          ('disabled' in row ? ',disabled' : '')
      ) ||
      row.index !== index ||
      typeof row.type !== 'string' ||
      !row.type ||
      typeof row.payload !== 'string' ||
      typeof row.proxy !== 'string' ||
      [row.type, row.payload, row.proxy].some((value) => value.length > 65536) ||
      ('size' in row && !integer(row.size, -1, Number.MAX_SAFE_INTEGER)) ||
      ('disabled' in row && typeof row.disabled !== 'boolean')
    )
      throw new Error('规则行回执无效。')
    return {
      index,
      type: row.type,
      payload: row.payload,
      proxy: row.proxy,
      ...('size' in row ? { size: Number(row.size) } : {}),
      ...('disabled' in row ? { disabled: Boolean(row.disabled) } : {})
    }
  })
  // Native owns the digest. Do not recompute it with JS JSON serialization.
  return { configurationRevision: raw.configurationRevision, rulesSHA256: raw.rulesSHA256, rules }
}

export function createTunRulesChannel(
  io: TunRulesIO,
  identity: TunSessionBinding & { launchClientSHA256: string; installationRevision: string },
  timeout = 3000
): TunRulesChannel {
  const binding = {
    sessionId: identity.sessionId,
    evidenceSHA256: identity.evidenceSHA256,
    runtimeConfigurationSHA256: identity.runtimeConfigurationSHA256
  }
  const clientSHA256 = identity.launchClientSHA256,
    installationRevision = identity.installationRevision
  if (
    !uuid(binding.sessionId) ||
    !hash(binding.evidenceSHA256) ||
    !hash(binding.runtimeConfigurationSHA256) ||
    !hash(clientSHA256) ||
    !hash(installationRevision) ||
    !integer(timeout, 1, 3000)
  )
    throw new Error('规则通道身份或期限无效。')
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
    helloTimer = setTimeout(() => fail(), timeout)
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
      // Failure is isolated to this capability even if the adapter close fails.
    }
  }
  const bound = (raw: Record<string, unknown>): boolean =>
    raw.version === 1 &&
    raw.sessionId === binding.sessionId &&
    raw.evidenceSHA256 === binding.evidenceSHA256 &&
    raw.runtimeConfigurationSHA256 === binding.runtimeConfigurationSHA256
  const check = (work: Work): void => {
    try {
      work.assertUI()
    } catch {
      work.cancelled = true
    }
    // Pure checks follow the callback: no observer or await after this guard.
    if (failed || work.cancelled || performance.now() >= work.deadline)
      throw new Error('规则操作已失效。')
  }
  const send = (
    work: Work,
    action: Action,
    fields: Record<string, string | number | boolean> = {}
  ): Promise<Reply> => {
    if (nextID === 0x7fffffff) fail()
    if (failed) return Promise.reject(new Error('规则通道已失效。'))
    const id = ++nextID,
      frame = JSON.stringify({ version: 1, id, action, ...binding, ...fields }) + '\n'
    if (Buffer.byteLength(frame) - 1 > tunHostFrameByteLimit)
      return Promise.reject(new Error('规则请求超限。'))
    return new Promise<Reply>((resolve, reject) => {
      pending.set(id, { action, resolve, reject: () => reject(new Error('规则管道已结束。')) })
      try {
        if (action === 'cancel') {
          if (failed || performance.now() >= work.deadline) throw new Error('规则操作已到期。')
        } else check(work)
        if (action === 'read' || action === 'prepare') {
          work.logicalID = id
          work.nativeRequested = true
        }
        if (action === 'commit') work.commitAttempted = true
        io.write(frame)
      } catch (error) {
        pending.delete(id)
        reject(error)
        if (work.commitAttempted || (!work.cancelled && work.nativeRequested)) fail()
      }
    })
  }
  const cancelWork = (work: Work): void => {
    work.cancelled = true
    work.wake()
    if (work.logicalID && work.nativeRequested && !work.cancelAck && !failed)
      work.cancelAck = send(work, 'cancel', { operationId: work.logicalID }).catch(() => undefined)
  }
  const receive = (bytes: Buffer): void => {
    const raw = parseTunHostFrame(bytes, responseLimit)
    if (!object(raw) || !bound(raw)) throw new Error('规则响应身份无效。')
    if (!available) {
      if (
        failed ||
        !keys(
          raw,
          'version,kind,capability,sessionId,evidenceSHA256,runtimeConfigurationSHA256,launchClientSHA256,installationRevision'
        ) ||
        raw.kind !== 'hello' ||
        raw.capability !== 'runtime-rules-v1' ||
        raw.launchClientSHA256 !== clientSHA256 ||
        raw.installationRevision !== installationRevision
      )
        throw new Error('规则能力未确认。')
      available = true
      clearTimeout(helloTimer)
      helloDone(true)
      return
    }
    if (!integer(raw.id, 1, 0x7fffffff)) throw new Error('规则响应ID无效。')
    const waiter = pending.get(raw.id)
    if (!waiter || raw.action !== waiter.action || typeof raw.pending !== 'boolean')
      throw new Error('规则响应不匹配。')
    const withSnapshot =
        raw.status === 'snapshot' || raw.status === 'changed' || raw.status === 'unchanged',
      withPrepared = raw.status === 'prepared'
    if (
      !keys(
        raw,
        'version,id,action,sessionId,evidenceSHA256,runtimeConfigurationSHA256,status,pending' +
          (withSnapshot ? ',snapshot' : '') +
          (withPrepared ? ',prepared' : '')
      )
    )
      throw new Error('规则响应字段无效。')
    const allowed: Record<Action, readonly string[]> = {
      read: ['snapshot', 'cancelled', 'stale', 'expired', 'unavailable', 'busy'],
      prepare: ['prepared', 'unchanged', 'cancelled', 'stale', 'expired', 'unavailable', 'busy'],
      commit: ['changed', 'cancelled', 'uncertain', 'stale', 'expired', 'unavailable', 'busy'],
      cancel: ['cancelled', 'cancelling', 'uncertain', 'stale', 'unavailable']
    }
    if (
      typeof raw.status !== 'string' ||
      !allowed[waiter.action].includes(raw.status) ||
      (waiter.action !== 'cancel' && raw.status !== 'busy' && raw.pending) ||
      (raw.status === 'cancelling' && !raw.pending) ||
      (waiter.action === 'cancel' && raw.status === 'uncertain' && !raw.pending)
    )
      throw new Error('规则响应状态无效。')
    const reply: Reply = { status: raw.status as Status, pending: raw.pending }
    if (withSnapshot) reply.snapshot = snapshot(raw.snapshot)
    if (withPrepared) {
      const value = raw.prepared
      if (
        !object(value) ||
        !keys(
          value,
          'nonce,operationId,leaseMilliseconds,configurationRevision,rulesSHA256,index,disabled'
        ) ||
        !uuid(value.nonce) ||
        !integer(value.operationId, 1, 0x7fffffff) ||
        !integer(value.leaseMilliseconds, 0, 3000) ||
        !hash(value.configurationRevision) ||
        !hash(value.rulesSHA256) ||
        !integer(value.index, 0, 9999) ||
        typeof value.disabled !== 'boolean'
      )
        throw new Error('规则准备回执无效。')
      reply.prepared = {
        nonce: value.nonce,
        operationId: value.operationId,
        leaseMilliseconds: value.leaseMilliseconds,
        configurationRevision: value.configurationRevision,
        rulesSHA256: value.rulesSHA256,
        index: value.index,
        disabled: value.disabled
      }
    }
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
        if (buffer.length + part.length > responseLimit) throw new Error('规则响应超限。')
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
    active ? new Promise<void>((resolve) => idle.push(resolve)) : Promise.resolve()
  const run = async (
    input: TunRulesMutation | undefined,
    signal: AbortSignal,
    assertUI: () => void
  ): Promise<TunRulesResult> => {
    if (active) return { status: 'busy' }
    if (signal.aborted) return { status: 'cancelled' }
    let value: TunRulesMutation | undefined
    if (input) {
      if (
        !object(input) ||
        !keys(input, 'configurationRevision,rulesSHA256,index,disabled') ||
        !hash(input.configurationRevision) ||
        !hash(input.rulesSHA256) ||
        !integer(input.index, 0, 9999) ||
        typeof input.disabled !== 'boolean'
      )
        return { status: 'unavailable' }
      value = {
        configurationRevision: input.configurationRevision,
        rulesSHA256: input.rulesSHA256,
        index: input.index,
        disabled: input.disabled
      }
    }
    let wake!: () => void, timer: ReturnType<typeof setTimeout> | undefined
    const cancelled = new Promise<boolean>((resolve) => (wake = () => resolve(false))),
      work: Work = {
        deadline: performance.now() + timeout,
        nativeRequested: false,
        commitAttempted: false,
        cancelled: false,
        wake,
        assertUI
      },
      abort = (): void => cancelWork(work)
    timer = setTimeout(fail, timeout)
    active = work
    signal.addEventListener('abort', abort, { once: true })
    try {
      if (!(await Promise.race([hello, cancelled])))
        return { status: work.cancelled ? 'cancelled' : 'unsupported' }
      check(work)
      const reply = await send(work, value ? 'prepare' : 'read', value ? { ...value } : undefined)
      if (work.cancelled) {
        await work.cancelAck
        return { status: 'cancelled' }
      }
      check(work)
      if (!value) {
        if (reply.status === 'snapshot' && reply.snapshot)
          return { status: 'snapshot', snapshot: reply.snapshot }
        return {
          status: reply.status as Exclude<
            TunRulesResult['status'],
            'snapshot' | 'changed' | 'unchanged'
          >
        }
      }
      if (reply.status === 'unchanged' && reply.snapshot) {
        if (
          reply.snapshot.configurationRevision !== value.configurationRevision ||
          reply.snapshot.rulesSHA256 !== value.rulesSHA256 ||
          reply.snapshot.rules[value.index]?.disabled !== value.disabled
        )
          throw new Error('规则未变化回执不匹配。')
        return { status: 'unchanged', snapshot: reply.snapshot }
      }
      if (reply.status !== 'prepared' || !reply.prepared)
        return {
          status: reply.status as Exclude<
            TunRulesResult['status'],
            'snapshot' | 'changed' | 'unchanged'
          >
        }
      const prepared = reply.prepared
      if (
        prepared.operationId !== work.logicalID ||
        prepared.configurationRevision !== value.configurationRevision ||
        prepared.rulesSHA256 !== value.rulesSHA256 ||
        prepared.index !== value.index ||
        prepared.disabled !== value.disabled
      )
        throw new Error('规则准备范围不匹配。')
      work.deadline = Math.min(work.deadline, performance.now() + prepared.leaseMilliseconds)
      clearTimeout(timer)
      timer = setTimeout(fail, Math.max(0, work.deadline - performance.now()))
      check(work)
      const committed = await send(work, 'commit', { nonce: prepared.nonce })
      if (work.cancelled) {
        await work.cancelAck
        return { status: 'uncertain' }
      }
      check(work)
      if (committed.status === 'changed' && committed.snapshot) {
        if (
          committed.snapshot.configurationRevision !== value.configurationRevision ||
          committed.snapshot.rules[value.index]?.disabled !== value.disabled
        )
          throw new Error('规则提交回执不匹配。')
        return { status: 'changed', snapshot: committed.snapshot }
      }
      return {
        status: committed.status as Exclude<
          TunRulesResult['status'],
          'snapshot' | 'changed' | 'unchanged'
        >
      }
    } catch {
      const expired = performance.now() >= work.deadline
      if (!failed) {
        cancelWork(work)
        await work.cancelAck
      }
      return {
        status: work.commitAttempted
          ? 'uncertain'
          : expired
            ? 'expired'
            : work.cancelled
              ? 'cancelled'
              : 'unavailable'
      }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      if (active === work) active = undefined
      for (const resolve of idle.splice(0)) resolve()
    }
  }
  return {
    read: (signal, assertUI) => run(undefined, signal, assertUI),
    change: (input, signal, assertUI) =>
      object(input) ? run(input, signal, assertUI) : Promise.resolve({ status: 'unavailable' }),
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
