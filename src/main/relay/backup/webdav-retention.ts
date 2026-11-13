import {
  isStrongBackupETag,
  remoteBackupRequest,
  type RelayRemoteBackupRequest
} from '../../../shared/relay/backup-remote'
import {
  webdavRetentionPolicy,
  type RelayWebdavBackupScope,
  type RelayWebdavRetentionState
} from '../../../shared/relay/backup-scheduler'
import type {
  createRemoteBackupTransport,
  RemoteBackupUploadGuards,
  VerifiedWebdavUpload
} from './remote'
import {
  WEBDAV_RECEIPT_MAX_FRAMES,
  type RelayWebdavReceiptStore,
  type WebdavReceiptInventory,
  type WebdavDeletionTicket
} from './webdav-receipts'

export type WebdavRetentionReceiptStore = Pick<
  RelayWebdavReceiptStore,
  'inspect' | 'open' | 'recordUploaded' | 'beginDeletion' | 'finishDeletion'
>

type Outcome = NonNullable<RelayWebdavRetentionState['lastResult']>
type Owned = VerifiedWebdavUpload & { etag: string; filename: string }

// New instance per explicitly accepted authorization epoch. No listing, disk
// receipt import, filename-prefix adoption or state restoration can populate it.
export function createWebdavSessionRetention(adapters: {
  scope: RelayWebdavBackupScope
  remove?: ReturnType<typeof createRemoteBackupTransport>['deleteOwned']
  notify?(state: RelayWebdavRetentionState): void
  now?(): number
  recorded?: { store: WebdavRetentionReceiptStore; inventory: WebdavReceiptInventory }
}) {
  const scope = structuredClone(adapters.scope),
    policy = webdavRetentionPolicy(scope.retention),
    now = adapters.now ?? Date.now,
    recorded = adapters.recorded,
    owned: Owned[] = recorded ? structuredClone(recorded.inventory.owned) : []
  let inventory = recorded ? structuredClone(recorded.inventory) : undefined
  if (scope.delete !== true) throw new Error('本次授权不包含保留删除。')
  if (policy.kind === 'recorded-owned') {
    if (
      !recorded ||
      !inventory ||
      !scope.history ||
      inventory.binding.accountId !== scope.id ||
      inventory.binding.directoryURL !== scope.directoryURL ||
      inventory.binding.username !== scope.username ||
      inventory.scopeSHA256 !== scope.history.scopeSHA256 ||
      inventory.owned.length !== scope.history.ownedCount ||
      inventory.uncertain.length !== scope.history.uncertainCount ||
      (scope.history.headSHA256 === null
        ? inventory.sequence !== 0
        : inventory.headSHA256 !== scope.history.headSHA256)
    )
      throw new Error('跨会话保留事实范围未通过本次授权。')
  } else if (recorded || scope.history) throw new Error('本次会话策略不接受旧回执。')
  const data: RelayWebdavRetentionState = {
    ...policy,
    ownedCount: 0,
    protectedCount: 0,
    deletedCount: 0,
    phase: 'idle'
  }
  let pending = false
  const state = (): RelayWebdavRetentionState =>
    structuredClone({
      ...data,
      ownedCount: owned.length,
      protectedCount: Math.min(policy.keepCount, owned.length),
      ...(inventory ? { uncertainCount: inventory.uncertain.length } : {})
    })
  const changed = (): void => {
    try {
      adapters.notify?.(state())
    } catch {
      /* Authority is checked separately. */
    }
  }
  const adopt = (value: WebdavReceiptInventory): void => {
    inventory = structuredClone(value)
    owned.splice(0, owned.length, ...structuredClone(value.owned))
    changed()
  }
  const head = (): string => {
    if (!inventory?.headSHA256) throw new Error('备份回执头尚未确认。')
    return inventory.headSHA256
  }
  const verifyHistory = async (
    verify: () => Promise<void>,
    assertLive: () => void
  ): Promise<void> => {
    await verify()
    assertLive()
    if (!recorded || !inventory) return
    const checked = await recorded.store.inspect(inventory.binding)
    assertLive()
    if (
      checked.headSHA256 !== inventory.headSHA256 ||
      checked.scopeSHA256 !== inventory.scopeSHA256
    )
      throw new Error('备份事实回执已变化，请重新授权。')
    await verify()
    assertLive()
  }
  return {
    state,
    verifyHistory,
    async beforeUpload(verify: () => Promise<void>, assertLive: () => void): Promise<void> {
      await verifyHistory(verify, assertLive)
      if (
        inventory &&
        inventory.sequence + 1 + Math.max(0, owned.length + 1 - policy.keepCount) * 2 >=
          WEBDAV_RECEIPT_MAX_FRAMES
      )
        throw new Error('备份事实回执剩余容量不足，未上传或自动清理账本。')
    },
    async afterUploaded(
      input: RelayRemoteBackupRequest,
      receipt: Readonly<VerifiedWebdavUpload> | undefined,
      expected: { envelopeSHA256: string; envelopeBytes: number },
      signal: AbortSignal,
      verify: () => Promise<void>,
      assertLive: () => void
    ): Promise<Outcome> {
      if (pending) throw new Error('本次保留操作尚未结束。')
      pending = true
      let result: Outcome = 'failed',
        submitted = false
      data.lastResult = undefined
      data.phase = 'checking'
      data.currentFilename = undefined
      data.lastAttemptFilename = undefined
      changed()
      try {
        await verifyHistory(verify, assertLive)
        if (!receipt || !isStrongBackupETag(receipt.etag) || !adapters.remove) {
          result = 'unsupported'
          return result
        }
        const target = new URL(input.url ?? ''),
          directory = new URL(scope.directoryURL),
          filename = target.pathname.slice(directory.pathname.length),
          run = filename.slice(scope.filenamePrefix.length, -scope.filenameSuffix.length)
        if (
          input.provider !== 'webdav' ||
          input.action !== 'upload' ||
          input.proxyPort !== scope.proxyPort ||
          input.username !== scope.username ||
          target.origin !== directory.origin ||
          target.username ||
          target.password ||
          target.hash ||
          target.search ||
          !target.pathname.startsWith(directory.pathname) ||
          filename.includes('/') ||
          !filename.startsWith(scope.filenamePrefix) ||
          !filename.endsWith(scope.filenameSuffix) ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(run) ||
          receipt.url !== target.href ||
          receipt.envelopeSHA256 !== expected.envelopeSHA256 ||
          receipt.envelopeBytes !== expected.envelopeBytes ||
          !/^[a-f0-9]{64}$/u.test(expected.envelopeSHA256) ||
          !Number.isSafeInteger(expected.envelopeBytes) ||
          expected.envelopeBytes < 1 ||
          owned.some((entry) => entry.url === receipt.url)
        ) {
          result = 'conflict'
          return result
        }
        // The scheduler has already reported a verified upload; this separate
        // guard is still required before adding it to deletion authority.
        await verifyHistory(verify, assertLive)
        const uploaded: Owned = {
          url: receipt.url,
          envelopeSHA256: receipt.envelopeSHA256,
          envelopeBytes: receipt.envelopeBytes,
          etag: receipt.etag,
          filename
        }
        if (recorded && inventory) {
          const next = await recorded.store.recordUploaded(inventory.binding, head(), uploaded)
          adopt(next)
          await verifyHistory(verify, assertLive)
        } else owned.push(uploaded)
        changed()
        if (owned.length <= policy.keepCount) {
          result = 'notNeeded'
          return result
        }
        while (owned.length > policy.keepCount) {
          const candidate = owned[0]
          data.phase = 'checking'
          data.currentFilename = candidate.filename
          data.lastAttemptFilename = candidate.filename
          changed()
          await verifyHistory(verify, assertLive)
          let ticket: WebdavDeletionTicket | undefined
          const selected = remoteBackupRequest({
            provider: 'webdav',
            action: 'delete',
            url: candidate.url,
            username: scope.username,
            password: input.password,
            proxyPort: scope.proxyPort,
            etag: candidate.etag
          })
          const guards: Pick<RemoteBackupUploadGuards, 'assertLive' | 'submitted'> = {
            assertLive,
            submitted: () => {
              submitted = true
              data.phase = 'deleting'
              changed()
            }
          }
          let removed: Awaited<ReturnType<NonNullable<typeof adapters.remove>>>
          try {
            if (recorded && inventory) {
              const begun = await recorded.store.beginDeletion(
                inventory.binding,
                head(),
                candidate.url
              )
              ticket = begun.ticket
              adopt(begun.inventory)
            }
            await verifyHistory(verify, assertLive)
            removed = await adapters.remove(
              selected,
              candidate,
              signal,
              () => verifyHistory(verify, assertLive),
              guards
            )
          } catch (error) {
            if (ticket && !submitted && recorded && inventory)
              adopt(await recorded.store.finishDeletion(inventory.binding, ticket, 'not-submitted'))
            throw error
          }
          if (removed.status !== 'deleted') {
            // A process-held ticket may close a proven zero-DELETE attempt as
            // a local fact even after Stop/context loss. It grants no retry.
            if (ticket && !submitted && removed.status !== 'uncertain' && recorded && inventory)
              adopt(await recorded.store.finishDeletion(inventory.binding, ticket, 'not-submitted'))
            result = removed.status
            return result
          }
          if (ticket && recorded && inventory)
            adopt(await recorded.store.finishDeletion(inventory.binding, ticket, 'deleted'))
          else owned.shift()
          submitted = false
          data.deletedCount++
          data.lastDeletedFilename = candidate.filename
          data.lastDeletedAt = new Date(now()).toISOString()
          changed()
        }
        result = 'pruned'
        return result
      } catch {
        result = submitted ? 'uncertain' : signal.aborted ? 'cancelled' : 'failed'
        return result
      } finally {
        pending = false
        data.phase = 'idle'
        data.lastResult = result
        data.currentFilename = undefined
        changed()
      }
    }
  }
}
