import { createHash, randomUUID } from 'crypto'
import {
  backupAccountMetadata,
  backupAccountRuntimeRequest,
  backupAccountSelection,
  type RelayBackupAccount
} from '../../../shared/relay/backup-accounts'
import {
  RUNTIME_GIST_FILENAME,
  runtimeGistRequest,
  sameRuntimeGistSource,
  type RelayRuntimeGistSource
} from '../../../shared/relay/runtime-gist'
import type {
  RelayRuntimeGistSyncScope,
  RelayRuntimeGistSyncState,
  RuntimeGistSyncSnapshotInfo,
  RuntimeGistSyncStopReason,
  RuntimeGistSyncResult
} from '../../../shared/relay/runtime-gist-sync'
import type { requestOnce } from '../../resolve/plugin/http-client'
import { encryptAgeContent } from '../../utils/age'
import type { RelayBackupAccountsStore } from './accounts-store'
import {
  createRuntimeGistWriter,
  validateRuntimeGistSnapshot,
  RUNTIME_GIST_PAYLOAD_LIMIT,
  RuntimeGistWriteGuardError,
  type RuntimeGistSnapshot
} from './runtime-gist-writer'

// Main-only receipt issued by the actual local-proxy owner. It must contain a
// real active-at-capture body; prepared candidates or synthetic old runtimes
// must never be substituted to satisfy freshness checks.
export interface RuntimeGistSyncCapture {
  snapshot: RuntimeGistSnapshot
  capturedAt: number
  isCurrent(): boolean
  isOwnerLive(): boolean
  assertOwner(signal: AbortSignal): Promise<void>
}
export type RuntimeGistSyncCaptureResult =
  | { status: 'captured'; capture: RuntimeGistSyncCapture }
  | { status: 'busy' }
  | { status: 'unavailable' }
  | { status: 'unsupported' }
export interface RuntimeGistSyncPermit {
  permission: RelayRuntimeGistSyncScope
  isLive(): boolean
  credential(signal: AbortSignal): Promise<{ account: RelayBackupAccount; secret: string }>
  revoke(): void
}
interface Grant {
  scope: RelayRuntimeGistSyncScope
  owner: RuntimeGistSyncCapture
  permit: RuntimeGistSyncPermit
  epoch: number
}
const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')
const json = (value: unknown): string => JSON.stringify(value)
function observed(check: () => boolean): boolean {
  try {
    return check() === true
  } catch {
    return false
  }
}
function checkedAccount(value: RelayBackupAccount): RelayBackupAccount {
  const { revision, ...metadata } = value,
    selection = backupAccountSelection({ id: value.id, revision })
  return { ...backupAccountMetadata(metadata), revision: selection.revision }
}
export function matchesRuntimeGistSyncAccount(
  account: RelayBackupAccount,
  scope: RelayRuntimeGistSyncScope
): boolean {
  return (
    account.id === scope.id &&
    account.revision === scope.revision &&
    account.provider === 'gist' &&
    account.state === 'active' &&
    account.name === scope.name &&
    account.proxyPort === scope.proxyPort &&
    account.recipient === scope.recipient
  )
}
function captureData(capture: RuntimeGistSyncCapture): {
  source: RuntimeGistSnapshot
  info: RuntimeGistSyncSnapshotInfo
} {
  const source = validateRuntimeGistSnapshot(capture.snapshot)
  if (!Number.isSafeInteger(capture.capturedAt) || capture.capturedAt < 0)
    throw new Error('运行捕获时间无效。')
  return {
    source,
    info: {
      revision: source.revision,
      configurationSHA256: sha(source.configuration),
      bytes: Buffer.byteLength(source.configuration),
      capturedAt: capture.capturedAt
    }
  }
}

// Reuses v2.0.4 gistApi.ts's 300ms debounce, serial queue and plaintext-hash
// suppression. Authority is new and session-only. The shared writer preserves
// manual strict-current behavior while this controller lets a genuinely active
// captured body finish readback across ordinary commits of the same live owner.
export function createRuntimeGistSyncService(adapters: {
  accounts: Pick<RelayBackupAccountsStore, 'read'>
  captureRuntime(
    signal: AbortSignal,
    source: RelayRuntimeGistSource | undefined,
    expectedProxyPort: number
  ): Promise<RuntimeGistSyncCaptureResult>
  authorize(scope: RelayRuntimeGistSyncScope): Promise<RuntimeGistSyncPermit | undefined>
  canRun(): boolean
  request?: typeof requestOnce
  notify?(): void
  now?(): number
}) {
  const now = adapters.now ?? Date.now,
    writer = createRuntimeGistWriter(adapters.request),
    waiters: Array<() => void> = [],
    sessionId = randomUUID()
  let data: RelayRuntimeGistSyncState = {
      enabled: false,
      pending: false,
      phase: 'idle',
      dirty: false
    },
    grant: Grant | undefined,
    epoch = 0,
    arming = false,
    working = false,
    closing = false,
    timer: ReturnType<typeof setTimeout> | undefined,
    controller: AbortController | undefined,
    changeEpoch = 0,
    lastEventAt = 0,
    lastWriteAt = -Infinity,
    expectedRemoteSHA256: string | undefined,
    stopPromise: Promise<RelayRuntimeGistSyncState> | undefined
  const busy = (): boolean => arming || working || closing
  const changed = (): void => {
    if (!arming && !working) waiters.splice(0).forEach((resolve) => resolve())
    try {
      adapters.notify?.()
    } catch {
      /* Closed renderers cannot retain authority. */
    }
  }
  const canRun = (): boolean => {
    try {
      return adapters.canRun() === true
    } catch {
      return false
    }
  }
  const waitForWork = (): Promise<void> =>
    arming || working ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()
  const revoke = (reason: RuntimeGistSyncStopReason): void => {
    ++epoch
    clearTimeout(timer)
    timer = undefined
    data.enabled = false
    data.dirty = false
    data.stopReason = reason
    const previous = grant
    grant = undefined
    try {
      previous?.permit.revoke()
    } catch {
      /* Epoch/signal remain authoritative. */
    }
    controller?.abort()
    data.phase = arming || working ? 'stopping' : 'idle'
  }
  const sweep = (): void => {
    const current = grant
    if (!current || !data.enabled) return
    if (!observed(() => current.permit.isLive())) {
      revoke('rendererChanged')
      changed()
    } else if (!observed(() => current.owner.isOwnerLive())) {
      revoke('ownerChanged')
      changed()
    }
  }
  const snapshot = (): RelayRuntimeGistSyncState => {
    sweep()
    return structuredClone({ ...data, pending: busy() })
  }
  const schedule = (defer = 0): void => {
    clearTimeout(timer)
    timer = undefined
    if (!grant || !data.enabled || !data.dirty || closing || arming || working) return
    const due = Math.max(now() + defer, lastEventAt + 300, lastWriteAt + 1000)
    data.phase = 'waiting'
    timer = setTimeout(
      () => {
        timer = undefined
        void run()
      },
      Math.max(1, due - now())
    )
    timer.unref?.()
  }
  const markDirty = (hint = true): void => {
    if (!grant || !data.enabled) return
    if (hint || !data.dirty) {
      ++changeEpoch
      lastEventAt = now()
    }
    data.dirty = true
    schedule()
    changed()
  }
  const live = (current: Grant, signal: AbortSignal): void => {
    if (signal.aborted || grant !== current || epoch !== current.epoch || !data.enabled || closing)
      throw new Error('本次同步已撤权。')
    if (!observed(() => current.permit.isLive())) throw new Error('界面授权已失效。')
    if (!observed(() => current.owner.isOwnerLive())) throw new Error('本次实例已失效。')
    if (json(current.permit.permission) !== json(current.scope))
      throw new Error('私有同步授权范围不符。')
  }
  const run = async (): Promise<void> => {
    sweep()
    const current = grant
    if (!current || !data.enabled || !data.dirty || busy()) return
    if (!canRun()) {
      schedule(1000)
      changed()
      return
    }
    working = true
    controller = new AbortController()
    const signal = controller.signal,
      startChange = changeEpoch
    let capture: RuntimeGistSyncCapture | undefined,
      info: RuntimeGistSyncSnapshotInfo | undefined,
      payload: Buffer | undefined,
      payloadSHA256: string | undefined,
      submitted = false,
      waitingForRuntime = false,
      deferred = false,
      result: RuntimeGistSyncResult = 'failed',
      failureReason: RuntimeGistSyncStopReason | undefined
    data.phase = 'capturing'
    data.lastResult = undefined
    data.lastAttempt = undefined
    changed()
    function stopFailure(reason: RuntimeGistSyncStopReason): never {
      failureReason = reason
      throw new Error('同步范围已失效。')
    }
    const verify = async (): Promise<void> => {
      try {
        live(current, signal)
      } catch {
        if (grant === current && !observed(() => current.permit.isLive()))
          stopFailure('rendererChanged')
        if (grant === current && !observed(() => current.owner.isOwnerLive()))
          stopFailure('ownerChanged')
        throw new Error('同步已取消。')
      }
      let account: RelayBackupAccount
      try {
        account = checkedAccount(
          await adapters.accounts.read({ id: current.scope.id, revision: current.scope.revision })
        )
      } catch {
        stopFailure('accountChanged')
      }
      live(current, signal)
      if (!matchesRuntimeGistSyncAccount(account, current.scope)) stopFailure('accountChanged')
      try {
        await (capture ?? current.owner).assertOwner(signal)
      } catch {
        if (signal.aborted || grant !== current) throw new Error('同步已取消。')
        stopFailure('ownerChanged')
      }
      live(current, signal)
      if (!submitted && !canRun()) {
        deferred = true
        data.dirty = true
        throw new RuntimeGistWriteGuardError('superseded')
      }
      if (capture && !capture.isCurrent()) {
        markDirty(false)
        // Before submission, a busy/newer same-owner runtime is coalesced.
        // After dispatch, only owner/account/lifecycle and immutable payload are
        // checked: a normal committed revision is not a failed network write.
        if (!submitted) throw new RuntimeGistWriteGuardError('superseded')
      }
    }
    try {
      await verify()
      const captured = await adapters.captureRuntime(
        signal,
        current.scope.source,
        current.scope.proxyPort
      )
      live(current, signal)
      if (captured.status === 'busy') {
        waitingForRuntime = true
        data.dirty = true
        result = 'superseded'
        return
      }
      if (captured.status !== 'captured') stopFailure('ownerChanged')
      const capturedReceipt = captured.capture
      capture = capturedReceipt
      const capturedData = captureData(capturedReceipt)
      info = capturedData.info
      if (
        !sameRuntimeGistSource(current.scope.source, capturedData.source.source) ||
        capturedData.source.instanceId !== current.scope.instanceId ||
        capturedData.source.proxyPort !== current.scope.proxyPort ||
        !observed(() => capturedReceipt.isOwnerLive())
      )
        stopFailure('ownerChanged')
      // Validate this receipt before publishing/deduplicating its body. A
      // capture can be superseded between its producer resolving and this await.
      await verify()
      data.latestCaptured = info
      if (changeEpoch === startChange) data.dirty = false
      if (info.configurationSHA256 === data.lastUploaded?.source.configurationSHA256) {
        result = 'unchanged'
        return
      }
      data.phase = 'preparing'
      changed()
      const content = current.scope.recipient
        ? await encryptAgeContent(
            capturedData.source.configuration,
            current.scope.recipient,
            'gist runtime config'
          )
        : capturedData.source.configuration
      live(current, signal)
      payload = Buffer.from(content)
      payloadSHA256 = sha(payload)
      if (payload.length > RUNTIME_GIST_PAYLOAD_LIMIT) throw new Error('正文超过限制。')
      await verify()
      let credential: Awaited<ReturnType<RuntimeGistSyncPermit['credential']>>
      try {
        credential = await current.permit.credential(signal)
      } catch {
        if (signal.aborted || grant !== current) throw new Error('同步已取消。')
        stopFailure('credentials')
      }
      await verify()
      if (!matchesRuntimeGistSyncAccount(checkedAccount(credential.account), current.scope))
        stopFailure('accountChanged')
      const request = runtimeGistRequest({
        token: credential.secret,
        ...(current.scope.source ? { source: current.scope.source } : {}),
        proxyPort: current.scope.proxyPort,
        gistId: current.scope.gistId,
        ...(current.scope.recipient ? { recipient: current.scope.recipient } : {})
      })
      data.uploading = { ...info, payloadSHA256, submitted: false }
      data.phase = 'uploading'
      changed()
      const receipt = capturedReceipt
      const written = await writer.write({ request, payload }, signal, {
        beforeSend: verify,
        beforeDispatch: () => live(current, signal),
        afterResponse: () => live(current, signal),
        beforeWrite: () => {
          live(current, signal)
          if (!canRun()) {
            deferred = true
            data.dirty = true
            throw new RuntimeGistWriteGuardError('superseded')
          }
          if (!receipt.isCurrent()) {
            markDirty(false)
            throw new RuntimeGistWriteGuardError('superseded')
          }
        },
        target: (target) => {
          if (expectedRemoteSHA256 !== undefined && target.contentSHA256 !== expectedRemoteSHA256)
            throw new RuntimeGistWriteGuardError('conflict')
        },
        submitted: () => {
          submitted = true
          lastWriteAt = now()
          if (data.uploading) data.uploading.submitted = true
          changed()
        },
        complete: verify
      })
      if (written.status === 'uploaded') {
        result = 'uploaded'
        expectedRemoteSHA256 = written.payloadSHA256
        data.lastUploaded = { source: info, payloadSHA256: written.payloadSHA256, at: now() }
      } else if (written.status === 'uncertain') {
        result = 'uncertain'
        if (grant === current) revoke(failureReason ?? 'uncertain')
      } else result = 'cancelled'
    } catch (error) {
      if (submitted) {
        result = 'uncertain'
        if (grant === current) revoke(failureReason ?? 'uncertain')
      } else if (signal.aborted || grant !== current) result = 'cancelled'
      else if (error instanceof RuntimeGistWriteGuardError && error.reason === 'superseded') {
        result = 'superseded'
        data.dirty = true
      } else {
        result =
          error instanceof RuntimeGistWriteGuardError && error.reason === 'conflict'
            ? 'conflict'
            : 'failed'
        if (grant === current)
          revoke(failureReason ?? (result === 'conflict' ? 'conflict' : 'failed'))
      }
    } finally {
      payload?.fill(0)
      data.lastResult = result
      data.lastAttempt = {
        ...(info ? { source: info } : {}),
        ...(payloadSHA256 ? { payloadSHA256 } : {}),
        submitted,
        result,
        at: now()
      }
      data.uploading = undefined
      working = false
      controller = undefined
      data.phase = data.enabled ? 'waiting' : 'idle'
      // A local operation end hint will resume a busy capture. If it arrived
      // during this async attempt, preserve it rather than waiting forever.
      if (data.enabled && data.dirty && (!waitingForRuntime || changeEpoch !== startChange))
        schedule(deferred ? 1000 : 0)
      changed()
    }
  }
  return {
    state: snapshot,
    isBusy: busy,
    isBlocking: busy,
    changed: (): void => {
      sweep()
      markDirty()
    },
    async whenIdle(): Promise<void> {
      if (stopPromise) await stopPromise
      else await waitForWork()
    },
    async arm(
      raw: unknown
    ): Promise<{ status: 'armed' | 'cancelled'; state: RelayRuntimeGistSyncState }> {
      const selected = backupAccountRuntimeRequest(raw)
      const gistId = selected.gistId
      if (!gistId) throw new Error('自动同步需要明确的现有专用Gist ID。')
      if (busy() || grant) throw new Error('请先停用当前自动同步，再更改授权范围。')
      if (!canRun()) throw new Error('请先结束其他操作并确认本次代理正在运行。')
      arming = true
      controller = new AbortController()
      const signal = controller.signal,
        at = now(),
        operationEpoch = ++epoch
      let permit: RuntimeGistSyncPermit | undefined,
        installed = false,
        status: 'armed' | 'cancelled' = 'cancelled'
      data = { enabled: false, pending: false, phase: 'authorizing', dirty: false }
      changed()
      const authorize = async (): Promise<'armed' | 'cancelled'> => {
        const account = checkedAccount(
            await adapters.accounts.read({ id: selected.id, revision: selected.revision })
          ),
          captured = await adapters.captureRuntime(signal, selected.source, account.proxyPort)
        if (signal.aborted || epoch !== operationEpoch) return 'cancelled'
        if (
          account.id !== selected.id ||
          account.revision !== selected.revision ||
          account.provider !== 'gist' ||
          account.state !== 'active' ||
          captured.status !== 'captured'
        )
          throw new Error('账号或本次运行来源未就绪。')
        const owner = captured.capture,
          { source, info } = captureData(owner)
        if (
          !sameRuntimeGistSource(selected.source, source.source) ||
          account.proxyPort !== source.proxyPort ||
          !observed(() => owner.isOwnerLive()) ||
          !owner.isCurrent()
        )
          throw new Error('当前自有代理与账号端口不符。')
        const scope: RelayRuntimeGistSyncScope = {
          kind: 'runtime-gist-sync-session',
          ...(selected.source ? { source: selected.source } : {}),
          sessionId,
          id: account.id,
          revision: account.revision,
          name: account.name,
          gistId,
          apiOrigin: 'https://api.github.com',
          filename: RUNTIME_GIST_FILENAME,
          instanceId: source.instanceId,
          proxyPort: source.proxyPort,
          ...(account.recipient ? { recipient: account.recipient } : {}),
          encrypted: !!account.recipient,
          containsSecrets: true,
          initial: info,
          preparedAt: at,
          authorizationExpiresAt: at + 60000,
          sessionOnly: true,
          overwriteDedicatedFile: true,
          atomicRemoteUpdate: false
        }
        data.account = { id: account.id, revision: account.revision, name: account.name }
        data.target = {
          gistId,
          url: 'https://gist.github.com/' + gistId,
          filename: RUNTIME_GIST_FILENAME
        }
        data.owner = {
          instanceId: source.instanceId,
          proxyPort: source.proxyPort,
          ...(selected.source ? { source: selected.source } : {})
        }
        data.encrypted = scope.encrypted
        data.latestCaptured = info
        permit = await adapters.authorize(structuredClone(scope))
        const consentLive = (): boolean =>
          !!permit &&
          observed(() => permit?.isLive() ?? false) &&
          !signal.aborted &&
          epoch === operationEpoch &&
          now() >= at &&
          now() < scope.authorizationExpiresAt
        if (!permit || !consentLive()) return 'cancelled'
        if (json(permit.permission) !== json(scope)) throw new Error('自动同步私有授权范围不符。')
        const current = checkedAccount(
          await adapters.accounts.read({ id: scope.id, revision: scope.revision })
        )
        if (
          !consentLive() ||
          !matchesRuntimeGistSyncAccount(current, scope) ||
          !owner.isCurrent() ||
          !observed(() => owner.isOwnerLive())
        )
          return 'cancelled'
        grant = { scope, owner, permit, epoch: operationEpoch }
        installed = true
        expectedRemoteSHA256 = undefined
        data.enabled = true
        data.phase = 'waiting'
        data.dirty = true
        data.lastResult = 'armed'
        lastEventAt = now()
        ++changeEpoch
        return 'armed'
      }
      try {
        status = await authorize()
        if (!installed) data.lastResult = 'cancelled'
      } catch {
        data.lastResult = 'failed'
        data.stopReason = 'failed'
        throw new Error('自动Gist同步授权未通过，请核对账号、目标与本次运行实例。')
      } finally {
        if (!installed) {
          try {
            permit?.revoke()
          } catch {
            /* No timer will be installed. */
          }
        }
        arming = false
        controller = undefined
        data.phase = installed ? 'waiting' : 'idle'
        if (installed) schedule()
        changed()
      }
      return { status, state: snapshot() }
    },
    stop(reason: RuntimeGistSyncStopReason = 'stopped'): Promise<RelayRuntimeGistSyncState> {
      revoke(reason)
      changed()
      if (stopPromise) return stopPromise
      closing = true
      stopPromise = waitForWork().then(() => {
        closing = false
        stopPromise = undefined
        changed()
        return snapshot()
      })
      return stopPromise
    }
  }
}
