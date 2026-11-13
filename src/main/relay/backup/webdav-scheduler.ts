import { randomUUID } from 'crypto'
import {
  backupAccountMetadata,
  backupAccountSelection,
  type RelayBackupAccount
} from '../../../shared/relay/backup-accounts'
import {
  webdavRetentionPolicy,
  type RelayWebdavBackupArmRequest,
  type RelayWebdavBackupScope,
  type RelayWebdavBackupSchedulerState,
  type RelayWebdavBackupStatus
} from '../../../shared/relay/backup-scheduler'
import { remoteBackupRequest } from '../../../shared/relay/backup-remote'
import { sourceSchedule } from '../subscriptions/source-options'
import { nextSourceRun } from '../subscriptions/source-scheduler'
import type { RelayBackupAccountsStore } from './accounts-store'
import type { RelayBackupStore } from './store'
import { backupHash } from './archive'
import {
  createRemoteBackupTransport,
  encodeRemoteArchive,
  type VerifiedWebdavUpload
} from './remote'
import { createWebdavSessionRetention, type WebdavRetentionReceiptStore } from './webdav-retention'

// Reuse: fixed Clash Party v2.0.4 resolve/backup.ts's Croner scheduling,
// existing sourceSchedule/nextSourceRun, and the private permit + single-flight,
// epoch/revoke/stop-wait lifecycle from relay/plugins/scheduler.ts. This narrow
// adapter deliberately does not call the old data-dir/client/retention code.
export interface WebdavBackupSchedulePermit {
  permission: RelayWebdavBackupScope
  isLive(): boolean
  credential(signal: AbortSignal): Promise<{ account: RelayBackupAccount; secret: string }>
  revoke(): void
}
type PublicEntry = RelayWebdavBackupSchedulerState['entries'][number]
type Entry = PublicEntry & {
  scope: RelayWebdavBackupScope
  permit: WebdavBackupSchedulePermit
  dueAt?: number
  timer?: ReturnType<typeof setTimeout>
  retentionController?: ReturnType<typeof createWebdavSessionRetention>
}
class ScheduleFailure extends Error {
  constructor(readonly reason: 'cancelled' | 'accountChanged' | 'scopeChanged' | 'failed') {
    super(reason)
  }
}
const uuid = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)
const json = (value: unknown): string => JSON.stringify(value)
function permitIsLive(permit: WebdavBackupSchedulePermit | undefined): boolean {
  try {
    return permit?.isLive() === true
  } catch {
    return false
  }
}
function armRequest(raw: unknown): RelayWebdavBackupArmRequest {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    !['id,revision,schedule', 'id,retention,revision,schedule'].includes(
      Object.keys(raw).sort().join(',')
    )
  )
    throw new Error('定时备份只接受账号修订与周期。')
  const value = raw as Record<string, unknown>,
    selected = backupAccountSelection({ id: value.id, revision: value.revision }),
    schedule = sourceSchedule(value.schedule)
  if (schedule.kind === 'manual') throw new Error('定时备份需要至少1分钟周期或有效5段cron。')
  return {
    ...selected,
    schedule,
    ...(value.retention === undefined ? {} : { retention: webdavRetentionPolicy(value.retention) })
  }
}
function stopRequest(raw: unknown): string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).join(',') !== 'id')
    throw new Error('停用只接受账号ID。')
  return backupAccountSelection({ id: (raw as { id: unknown }).id, revision: '0'.repeat(64) }).id
}
function checkedAccount(account: RelayBackupAccount): RelayBackupAccount {
  const { revision, ...metadata } = account
  const selected = backupAccountSelection({ id: account.id, revision })
  return { ...backupAccountMetadata(metadata), revision: selected.revision }
}
export function matchesWebdavBackupAccount(
  account: RelayBackupAccount,
  scope: RelayWebdavBackupScope
): boolean {
  return (
    account.id === scope.id &&
    account.revision === scope.revision &&
    account.state === 'active' &&
    account.provider === 'webdav' &&
    account.name === scope.name &&
    account.directoryURL === scope.directoryURL &&
    account.username === scope.username &&
    account.proxyPort === scope.proxyPort &&
    account.recipient === scope.recipient
  )
}
export function createWebdavBackupScheduler(adapters: {
  accounts: Pick<RelayBackupAccountsStore, 'read'>
  backups: Pick<RelayBackupStore, 'archive'>
  // Called only by an explicit arm action, with no decryption or requests yet.
  // The future native dialog must default to cancel. The returned capability
  // stays main-only and is revoked on every cancellation or scope change.
  authorize(scope: RelayWebdavBackupScope): Promise<WebdavBackupSchedulePermit | undefined>
  canRun(): boolean
  receipts?: WebdavRetentionReceiptStore
  transport?: Pick<ReturnType<typeof createRemoteBackupTransport>, 'upload'> &
    Partial<Pick<ReturnType<typeof createRemoteBackupTransport>, 'deleteOwned'>>
  notify?(): void
  now?(): number
  timeZone?(): string
  uuid?(): string
}) {
  const now = adapters.now ?? Date.now,
    newId = adapters.uuid ?? randomUUID,
    timeZone = adapters.timeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    transport = adapters.transport ?? createRemoteBackupTransport(),
    sessionId = newId(),
    entries = new Map<string, Entry>(),
    waiters: Array<() => void> = []
  if (!uuid(sessionId)) throw new Error('本次备份会话标识无效。')
  let arming = false,
    armingId: string | undefined,
    armingPermit: WebdavBackupSchedulePermit | undefined,
    running: { entry: Entry; controller: AbortController } | undefined,
    closing = false,
    suspended = false,
    generation = 0,
    stopPromise: Promise<void> | undefined
  const runnable = (): boolean => {
    try {
      return adapters.canRun() === true
    } catch {
      return false
    }
  }
  const busy = (): boolean => arming || !!running || closing
  const changed = (): void => {
    if (!arming && !running) waiters.splice(0).forEach((resolve) => resolve())
    try {
      adapters.notify?.()
    } catch {
      /* A closed renderer cannot retain authority. */
    }
  }
  const whenWorkEnds = (): Promise<void> =>
    arming || running ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve()
  const snapshot = (): RelayWebdavBackupSchedulerState => ({
    pending: busy(),
    suspended,
    entries: [...entries.values()].map(
      ({
        scope: _scope,
        permit: _permit,
        timer: _timer,
        dueAt: _due,
        retentionController: _retention,
        ...entry
      }) => structuredClone(entry)
    )
  })
  const disable = (entry: Entry, status: RelayWebdavBackupStatus): void => {
    entry.enabled = false
    entry.lastStatus = status
    entry.nextAt = undefined
    entry.dueAt = undefined
    clearTimeout(entry.timer)
    entry.timer = undefined
    try {
      entry.permit.revoke()
    } catch {
      /* The scheduler also revokes its own epoch/signal. */
    }
    if (running?.entry === entry) running.controller.abort()
  }
  const install = (entry: Entry, at: number): void => {
    clearTimeout(entry.timer)
    if (entries.get(entry.id) !== entry || !entry.enabled || closing || suspended) return
    entry.dueAt = at
    entry.nextAt = new Date(at).toISOString()
    entry.timer = setTimeout(() => void fire(entry), Math.min(2147483647, Math.max(1, at - now())))
    entry.timer.unref?.()
  }
  const schedule = (entry: Entry, defer = false): void => {
    if (!entry.enabled || closing || suspended) return
    const at = defer ? now() + 60000 : nextSourceRun(entry.schedule, now())
    if (at === undefined) {
      disable(entry, 'noNextRun')
      return
    }
    install(entry, at)
  }
  const fire = async (entry: Entry): Promise<void> => {
    if (entries.get(entry.id) !== entry || !entry.enabled || closing || suspended) return
    // Cron deadlines can be farther than Node's maximum timer delay. Waking a
    // chunk early must not turn a future cron occurrence into an upload.
    if (entry.dueAt !== undefined && now() < entry.dueAt) {
      install(entry, entry.dueAt)
      return
    }
    if (arming || running || !runnable()) {
      entry.lastStatus = 'busy'
      schedule(entry, true)
      changed()
      return
    }
    const epoch = generation,
      controller = new AbortController(),
      signal = controller.signal
    running = { entry, controller }
    entry.nextAt = undefined
    entry.dueAt = undefined
    entry.lastAttemptAt = new Date(now()).toISOString()
    entry.lastStatus = 'running'
    entry.lastResult = undefined
    entry.lastCompletedAt = undefined
    entry.lastFilename = undefined
    entry.lastArchiveSHA256 = undefined
    changed()
    let archiveBytes: Buffer | undefined,
      envelope: Buffer | undefined,
      writeObserved = false,
      outcome: PublicEntry['lastResult'] = 'failed'
    const live = (): void => {
      if (
        signal.aborted ||
        generation !== epoch ||
        entries.get(entry.id) !== entry ||
        !entry.enabled ||
        closing ||
        suspended
      )
        throw new ScheduleFailure('cancelled')
      if (
        !permitIsLive(entry.permit) ||
        timeZone() !== entry.scope.timeZone ||
        json(entry.permit.permission) !== json(entry.scope)
      )
        throw new ScheduleFailure('scopeChanged')
      if (!runnable()) throw new ScheduleFailure('failed')
    }
    const verifyAccount = async (): Promise<void> => {
      live()
      let account: RelayBackupAccount
      try {
        account = checkedAccount(
          await adapters.accounts.read({ id: entry.id, revision: entry.revision })
        )
      } catch {
        throw new ScheduleFailure('accountChanged')
      }
      live()
      if (!matchesWebdavBackupAccount(account, entry.scope))
        throw new ScheduleFailure('accountChanged')
    }
    const verify = async (): Promise<void> => {
      await verifyAccount()
      if (entry.scope.retention?.kind === 'recorded-owned')
        await entry.retentionController?.verifyHistory(verifyAccount, live)
    }
    try {
      await verifyAccount()
      if (entry.scope.retention?.kind === 'recorded-owned') {
        await entry.retentionController?.beforeUpload(verifyAccount, live)
      }
      const runId = newId()
      if (!uuid(runId)) throw new ScheduleFailure('failed')
      const filename = entry.scope.filenamePrefix + runId + entry.scope.filenameSuffix
      entry.lastFilename = filename
      const archive = await adapters.backups.archive()
      archiveBytes = Buffer.from(archive.bytes)
      if (backupHash(archiveBytes) !== archive.sha256) throw new ScheduleFailure('failed')
      entry.lastArchiveSHA256 = archive.sha256
      await verify()
      envelope = await encodeRemoteArchive(archiveBytes, entry.scope.recipient)
      const expected = { envelopeSHA256: backupHash(envelope), envelopeBytes: envelope.length }
      await verify()
      let credential: Awaited<ReturnType<WebdavBackupSchedulePermit['credential']>>
      try {
        credential = await entry.permit.credential(signal)
      } catch {
        outcome = 'credentials'
        throw new ScheduleFailure('failed')
      }
      await verify()
      if (!matchesWebdavBackupAccount(checkedAccount(credential.account), entry.scope))
        throw new ScheduleFailure('accountChanged')
      const request = remoteBackupRequest({
        provider: 'webdav',
        action: 'upload',
        proxyPort: entry.scope.proxyPort,
        url: new URL(filename, entry.scope.directoryURL).href,
        username: entry.scope.username,
        password: credential.secret,
        ...(entry.scope.recipient ? { recipient: entry.scope.recipient } : {})
      })
      await verify()
      let receipt: Readonly<VerifiedWebdavUpload> | undefined
      const result = await transport.upload(request, envelope, signal, verify, {
        assertLive: live,
        submitted: () => {
          writeObserved = true
        },
        ...(entry.retentionController
          ? {
              verified: (value: Readonly<VerifiedWebdavUpload>) => {
                receipt = value
              }
            }
          : {})
      })
      if (result.status === 'uncertain') {
        outcome = 'uncertain'
        throw new ScheduleFailure('failed')
      }
      await verifyAccount()
      outcome = 'uploaded'
      entry.lastResult = 'uploaded'
      entry.lastStatus = 'uploaded'
      if (entry.retentionController) {
        // Upload is already confirmed. Cleanup has its own result; a failed
        // deletion must never erase that successful backup or claim it failed.
        let cleanup: NonNullable<PublicEntry['retention']>['lastResult']
        try {
          cleanup = await entry.retentionController.afterUploaded(
            request,
            receipt,
            expected,
            signal,
            verifyAccount,
            live
          )
        } catch {
          cleanup = 'failed'
        }
        if (
          cleanup !== 'notNeeded' &&
          cleanup !== 'pruned' &&
          (entry.enabled || cleanup === 'uncertain')
        ) {
          disable(
            entry,
            cleanup === 'unsupported'
              ? 'retentionUnsupported'
              : cleanup === 'conflict'
                ? 'retentionConflict'
                : cleanup === 'uncertain'
                  ? 'retentionUncertain'
                  : 'retentionFailed'
          )
        }
        if (entry.enabled && !permitIsLive(entry.permit)) disable(entry, 'scopeChanged')
      }
    } catch (error) {
      if (writeObserved) outcome = 'uncertain'
      else if (signal.aborted) outcome = 'cancelled'
      else if (!permitIsLive(entry.permit)) outcome = 'scopeChanged'
      else if (error instanceof ScheduleFailure && error.reason !== 'failed')
        outcome = error.reason === 'cancelled' ? 'cancelled' : error.reason
      entry.lastResult = outcome
      // Never turn a stopped entry back on, including a late upload response.
      if (outcome === 'uncertain') disable(entry, 'uncertain')
      else if (entry.enabled) disable(entry, outcome === 'cancelled' ? 'stopped' : outcome)
    } finally {
      archiveBytes?.fill(0)
      envelope?.fill(0)
      entry.lastCompletedAt = new Date(now()).toISOString()
      running = undefined
      if (entry.enabled && outcome === 'uploaded') schedule(entry)
      changed()
    }
  }
  const stopAll = (status: 'stopped' | 'suspended' | 'restored'): Promise<void> => {
    ++generation
    closing = true
    try {
      armingPermit?.revoke()
    } catch {
      /* Late authorization is checked again before installation. */
    }
    entries.forEach((entry) => disable(entry, status))
    changed()
    if (stopPromise) return stopPromise
    stopPromise = whenWorkEnds().finally(() => {
      closing = false
      stopPromise = undefined
      changed()
    })
    return stopPromise
  }
  return {
    state: snapshot,
    isBusy: busy,
    isBlocking: busy,
    async whenIdle(): Promise<void> {
      if (stopPromise) await stopPromise
      else await whenWorkEnds()
    },
    async arm(
      raw: unknown,
      assertContext?: () => void
    ): Promise<{ status: 'armed' | 'cancelled'; state: RelayWebdavBackupSchedulerState }> {
      const selected = armRequest(raw)
      assertContext?.()
      if (busy() || suspended) throw new Error('请等待调度操作结束，挂起期间不能开启备份。')
      if (!entries.has(selected.id) && entries.size >= 200)
        throw new Error('本次会话调度超过200项预算。')
      arming = true
      armingId = selected.id
      const epoch = generation
      let permit: WebdavBackupSchedulePermit | undefined,
        installed = false,
        status: 'armed' | 'cancelled' = 'cancelled'
      changed()
      const authorize = async (): Promise<'armed' | 'cancelled'> => {
        const account = checkedAccount(
          await adapters.accounts.read({ id: selected.id, revision: selected.revision })
        )
        assertContext?.()
        if (
          account.id !== selected.id ||
          account.revision !== selected.revision ||
          account.provider !== 'webdav' ||
          account.state !== 'active' ||
          !account.directoryURL ||
          account.username === undefined
        )
          throw new Error('请选择可用WebDAV账号。')
        if (closing || suspended || generation !== epoch) return 'cancelled'
        const at = now(),
          next = nextSourceRun(selected.schedule, at),
          zone = timeZone()
        if (next === undefined || !zone || zone.length > 128)
          throw new Error('调度没有下一次时间或时区无效。')
        const scope: RelayWebdavBackupScope = {
          kind: 'webdav-backup-session',
          sessionId,
          id: account.id,
          revision: account.revision,
          name: account.name,
          directoryURL: account.directoryURL,
          username: account.username,
          proxyPort: account.proxyPort,
          ...(account.recipient ? { recipient: account.recipient } : {}),
          encrypted: !!account.recipient,
          containsSecrets: true,
          schedule: structuredClone(selected.schedule),
          timeZone: zone,
          nextAt: new Date(next).toISOString(),
          preparedAt: at,
          authorizationExpiresAt: Math.min(at + 60000, next),
          filenamePrefix: 'relay-' + sessionId + '-',
          filenameSuffix: '.json',
          overwrite: false,
          delete: !!selected.retention,
          ...(selected.retention ? { retention: structuredClone(selected.retention) } : {}),
          sessionOnly: true
        }
        const receiptBinding = {
          accountId: scope.id,
          directoryURL: scope.directoryURL,
          username: scope.username
        }
        if (selected.retention?.kind === 'recorded-owned') {
          if (!adapters.receipts) throw new Error('跨会话备份事实回执不可用。')
          const history = await adapters.receipts.inspect(receiptBinding)
          assertContext?.()
          if (closing || suspended || generation !== epoch || now() >= scope.authorizationExpiresAt)
            return 'cancelled'
          scope.history = {
            scopeSHA256: history.scopeSHA256,
            headSHA256: history.headSHA256,
            ownedCount: history.owned.length,
            uncertainCount: history.uncertain.length
          }
        }
        permit = await adapters.authorize(structuredClone(scope))
        armingPermit = permit
        const consentLive = (): boolean => {
          try {
            assertContext?.()
            return (
              permitIsLive(permit) &&
              !closing &&
              !suspended &&
              generation === epoch &&
              now() >= at &&
              now() < scope.authorizationExpiresAt &&
              timeZone() === zone
            )
          } catch {
            return false
          }
        }
        if (!permit || !consentLive()) return 'cancelled'
        if (json(permit.permission) !== json(scope)) throw new Error('调度私有授权范围不符。')
        const current = checkedAccount(
          await adapters.accounts.read({ id: selected.id, revision: selected.revision })
        )
        if (!consentLive() || !matchesWebdavBackupAccount(current, scope)) return 'cancelled'
        let recorded: Parameters<typeof createWebdavSessionRetention>[0]['recorded']
        if (scope.history) {
          if (!adapters.receipts) throw new Error('跨会话备份事实回执不可用。')
          const inventory = await adapters.receipts.open(receiptBinding, scope.history.headSHA256)
          if (!consentLive()) return 'cancelled'
          const checked = checkedAccount(
            await adapters.accounts.read({ id: selected.id, revision: selected.revision })
          )
          if (!consentLive() || !matchesWebdavBackupAccount(checked, scope)) return 'cancelled'
          const fresh = await adapters.receipts.inspect(receiptBinding)
          if (
            !consentLive() ||
            fresh.headSHA256 !== inventory.headSHA256 ||
            fresh.scopeSHA256 !== inventory.scopeSHA256
          )
            throw new Error('备份事实回执在授权后已变化。')
          recorded = { store: adapters.receipts, inventory }
        }
        const previous = entries.get(selected.id)
        if (previous) disable(previous, 'stopped')
        const entry: Entry = {
          id: scope.id,
          revision: scope.revision,
          name: scope.name,
          directoryURL: scope.directoryURL,
          proxyPort: scope.proxyPort,
          encrypted: scope.encrypted,
          schedule: structuredClone(scope.schedule),
          timeZone: zone,
          enabled: true,
          lastStatus: 'armed',
          scope,
          permit
        }
        if (scope.retention) {
          entry.retentionController = createWebdavSessionRetention({
            scope,
            remove: transport.deleteOwned,
            now,
            ...(recorded ? { recorded } : {}),
            notify: (value) => {
              entry.retention = value
              changed()
            }
          })
          entry.retention = entry.retentionController.state()
        }
        entries.set(entry.id, entry)
        installed = true
        install(entry, next)
        return 'armed'
      }
      try {
        status = await authorize()
      } finally {
        if (!installed) {
          try {
            permit?.revoke()
          } catch {
            /* Do not install a revoked capability. */
          }
        }
        arming = false
        armingId = undefined
        armingPermit = undefined
        changed()
      }
      return { status, state: snapshot() }
    },
    async disarm(raw: unknown): Promise<RelayWebdavBackupSchedulerState> {
      const id = stopRequest(raw)
      if (armingId === id) {
        ++generation
        try {
          armingPermit?.revoke()
        } catch {
          /* Epoch invalidates pending authorization. */
        }
      }
      const entry = entries.get(id)
      if (entry) disable(entry, 'stopped')
      changed()
      if (armingId === id || running?.entry.id === id) await whenWorkEnds()
      return snapshot()
    },
    async accountChanged(raw: unknown): Promise<void> {
      const id = stopRequest(raw)
      if (armingId === id) {
        ++generation
        try {
          armingPermit?.revoke()
        } catch {
          /* Epoch invalidates pending authorization. */
        }
      }
      const entry = entries.get(id)
      if (entry) disable(entry, 'accountChanged')
      changed()
      if (armingId === id || running?.entry.id === id) await whenWorkEnds()
    },
    requestClose: (): Promise<void> => stopAll('stopped'),
    dataRestored: (): Promise<void> => stopAll('restored'),
    suspend(): Promise<void> {
      suspended = true
      return stopAll('suspended')
    },
    resume(): void {
      suspended = false
      changed()
    }
  }
}
