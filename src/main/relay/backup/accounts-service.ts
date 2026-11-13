import {
  backupAccountRemoteRequest,
  backupAccountRuntimeRequest,
  backupAccountSelection,
  type RelayBackupAccountSelection
} from '../../../shared/relay/backup-accounts'
import {
  remoteBackupRequest,
  type RelayRemoteBackupRequest,
  type RelayRemoteBackupPlan
} from '../../../shared/relay/backup-remote'
import {
  runtimeGistRequest,
  type RelayRuntimeGistRequest,
  type RelayRuntimeGistSource,
  type RelayRuntimeGistPlan
} from '../../../shared/relay/runtime-gist'
import type { RelayBackupAccountsStore } from './accounts-store'

type Recheck = (phase?: 'transfer' | 'restore') => Promise<void>
// The receiving service must retain and await the main-only recheck after its
// native confirmation and immediately before every outbound request. It is not
// renderer data and must never be serialized into an IPC request or plan.
export function createBackupAccountsService(adapters: {
  store: RelayBackupAccountsStore
  assertIdle(): void
  assertListIdle?(): void
  assertRuntimeIdle?(source?: RelayRuntimeGistSource): void
  prepareRemote(
    request: RelayRemoteBackupRequest,
    recheck: Recheck,
    assertLive?: () => void
  ): Promise<RelayRemoteBackupPlan>
  prepareRuntime(
    request: RelayRuntimeGistRequest,
    recheck: Recheck,
    assertContext?: () => void
  ): Promise<RelayRuntimeGistPlan>
  cancelRemote?(): void
  cancelRuntime?(): void
  now?(): number
}) {
  const proofs = new Map<string, { recheck: Recheck; expiresAt: number }>(),
    now = adapters.now ?? Date.now
  const waiters: Array<() => void> = []
  let pending = false,
    generation = 0
  const begin = (assertIdle = adapters.assertIdle): number => {
    if (pending) throw new Error('请等待备份账号操作结束。')
    assertIdle()
    pending = true
    return generation
  }
  const end = (): void => {
    pending = false
    waiters.splice(0).forEach((resolve) => resolve())
  }
  const cancel = (): void => {
    ++generation
    adapters.cancelRemote?.()
    adapters.cancelRuntime?.()
  }
  const clearExpired = (): void => {
    for (const [id, proof] of proofs) if (now() >= proof.expiresAt) proofs.delete(id)
  }
  const selectionGuard = (
    selected: RelayBackupAccountSelection,
    epoch: number
  ): { recheck: Recheck; bind(plan: RelayRemoteBackupPlan | RelayRuntimeGistPlan): void } => {
    let preparedAt = now(),
      expiresAt = preparedAt + 60000
    const recheck: Recheck = async (phase = 'transfer'): Promise<void> => {
      const fresh = (): boolean => phase === 'restore' || (now() >= preparedAt && now() < expiresAt)
      if (generation !== epoch || !fresh()) throw new Error('保存账号的本次授权已失效。')
      const account = await adapters.store.read(selected)
      if (account.state !== 'active' || generation !== epoch || !fresh())
        throw new Error('备份账号已停用、变化或过期。')
    }
    return {
      recheck,
      bind(plan) {
        preparedAt = plan.expiresAt - 60000
        expiresAt = plan.expiresAt
        proofs.set(plan.evidenceId, { recheck, expiresAt })
      }
    }
  }
  return {
    isBusy: (): boolean => pending,
    whenIdle: (): Promise<void> =>
      pending ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(),
    async list() {
      begin(adapters.assertListIdle ?? adapters.assertIdle)
      try {
        return await adapters.store.list()
      } finally {
        end()
      }
    },
    dataRestored(): void {
      if (pending) throw new Error('备份账号操作尚未结束。')
      cancel()
      adapters.store.clearTrust()
    },
    async save(raw: unknown) {
      begin()
      try {
        const saved = await adapters.store.save(raw)
        cancel()
        return saved
      } finally {
        end()
      }
    },
    async disable(raw: unknown) {
      begin()
      try {
        const disabled = await adapters.store.disable(raw)
        cancel()
        return disabled
      } finally {
        end()
      }
    },
    cancel,
    async verifyPrepared(evidenceId: string): Promise<void> {
      const proof = proofs.get(evidenceId)
      if (proof) await proof.recheck()
    },
    async prepareRemote(raw: unknown, assertLive?: () => void): Promise<RelayRemoteBackupPlan> {
      const input = backupAccountRemoteRequest(raw),
        epoch = begin()
      try {
        assertLive?.()
        clearExpired()
        if (proofs.size >= 64) throw new Error('备份账号待核对操作过多，请等待旧凭据过期。')
        const selected = backupAccountSelection({ id: input.id, revision: input.revision }),
          guard = selectionGuard(selected, epoch),
          account = await adapters.store.read(selected),
          secret = account.provider === 'webdav' ? '' : 'relay-placeholder'
        assertLive?.()
        await guard.recheck()
        assertLive?.()
        let request: RelayRemoteBackupRequest
        if (account.provider === 'webdav') {
          if (
            !account.directoryURL ||
            account.username === undefined ||
            input.gistId !== undefined ||
            input.page !== undefined ||
            (input.action === 'list' ? input.filename !== undefined : !input.filename)
          )
            throw new Error('WebDAV操作需要账号目录内的一个安全文件名。')
          request = remoteBackupRequest({
            provider: 'webdav',
            action: input.action,
            proxyPort: account.proxyPort,
            url:
              input.action === 'list'
                ? account.directoryURL
                : new URL(input.filename ?? '', account.directoryURL).href,
            username: account.username,
            password: secret,
            ...(input.archiveFormat !== undefined ? { archiveFormat: input.archiveFormat } : {}),
            ...(input.action === 'upload' && account.recipient
              ? { recipient: account.recipient }
              : {}),
            ...(input.secretKey !== undefined ? { secretKey: input.secretKey } : {}),
            ...(input.etag !== undefined ? { etag: input.etag } : {})
          })
        } else {
          if (input.filename !== undefined || input.archiveFormat !== undefined)
            throw new Error('Gist账号不能接受WebDAV文件名或归档格式。')
          request = remoteBackupRequest({
            provider: 'gist',
            action: input.action,
            proxyPort: account.proxyPort,
            token: secret,
            ...(input.action === 'upload' && account.recipient
              ? { recipient: account.recipient }
              : {}),
            ...(input.gistId !== undefined ? { gistId: input.gistId } : {}),
            ...(input.page !== undefined ? { page: input.page } : {}),
            ...(input.secretKey !== undefined ? { secretKey: input.secretKey } : {}),
            ...(input.etag !== undefined ? { etag: input.etag } : {})
          })
        }
        assertLive?.()
        const credential = await adapters.store.credential(selected)
        assertLive?.()
        request = remoteBackupRequest({
          ...request,
          ...(account.provider === 'webdav'
            ? { password: credential.secret }
            : { token: credential.secret })
        })
        await guard.recheck()
        assertLive?.()
        const plan =
          input.archiveFormat === 'legacy-zip'
            ? await adapters.prepareRemote(request, guard.recheck, assertLive)
            : await adapters.prepareRemote(request, guard.recheck)
        assertLive?.()
        guard.bind(plan)
        await guard.recheck()
        assertLive?.()
        return structuredClone(plan)
      } catch {
        adapters.cancelRemote?.()
        throw new Error('保存账号的远程准备未通过；请核对账号修订、目标、凭据与加密选项。')
      } finally {
        end()
      }
    },
    async prepareRuntime(raw: unknown, assertContext?: () => void): Promise<RelayRuntimeGistPlan> {
      const input = backupAccountRuntimeRequest(raw),
        epoch = begin(
          adapters.assertRuntimeIdle
            ? () => adapters.assertRuntimeIdle?.(input.source)
            : adapters.assertIdle
        )
      try {
        assertContext?.()
        clearExpired()
        if (proofs.size >= 64) throw new Error('备份账号待核对操作过多，请等待旧凭据过期。')
        const selected = backupAccountSelection({ id: input.id, revision: input.revision }),
          guard = selectionGuard(selected, epoch),
          account = await adapters.store.read(selected)
        if (account.provider !== 'gist') throw new Error('运行配置同步只接受Gist账号。')
        assertContext?.()
        await guard.recheck()
        assertContext?.()
        const credential = await adapters.store.credential(selected)
        assertContext?.()
        await guard.recheck()
        assertContext?.()
        const request = runtimeGistRequest({
            proxyPort: account.proxyPort,
            token: credential.secret,
            ...(input.source ? { source: input.source } : {}),
            ...(input.gistId ? { gistId: input.gistId } : {}),
            ...(account.recipient ? { recipient: account.recipient } : {})
          }),
          plan = await adapters.prepareRuntime(request, guard.recheck, assertContext)
        guard.bind(plan)
        assertContext?.()
        await guard.recheck()
        assertContext?.()
        return structuredClone(plan)
      } catch {
        adapters.cancelRuntime?.()
        throw new Error('保存账号的运行配置Gist准备未通过；请重新核对本次账号与自有代理。')
      } finally {
        end()
      }
    }
  }
}
