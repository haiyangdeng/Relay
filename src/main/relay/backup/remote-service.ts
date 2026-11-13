import { randomUUID } from 'crypto'
import {
  remoteBackupRequest,
  remoteBackupEndpoint,
  type RelayRemoteBackupPlan,
  type RelayRemoteBackupResult
} from '../../../shared/relay/backup-remote'
import type { RelayBackupResult } from '../../../shared/relay/backup'
import type { LegacyClashMigrationResult } from '../../../shared/relay/legacy-clash'
import type { LegacyMigrationSourceGuard } from './service'
import type { RelayBackupStore } from './store'
import { createRemoteBackupTransport, encodeRemoteArchive, GIST_ARCHIVE_MAX_BYTES } from './remote'

export type RemoteBackupRecheck = (phase?: 'transfer' | 'restore') => Promise<void>

export function createRemoteBackupService(adapters: {
  store: RelayBackupStore
  prepareArchive(bytes: Buffer, signal: AbortSignal): Promise<RelayBackupResult>
  prepareLegacyArchive?(
    bytes: Buffer,
    proxyPort: number,
    signal: AbortSignal,
    sourceGuard?: LegacyMigrationSourceGuard
  ): Promise<LegacyClashMigrationResult>
  confirmTransfer(plan: RelayRemoteBackupPlan): Promise<boolean>
  assertIdle(): void
  transport?: Pick<ReturnType<typeof createRemoteBackupTransport>, 'upload' | 'download'> &
    Partial<Pick<ReturnType<typeof createRemoteBackupTransport>, 'list' | 'delete'>>
  now?(): number
}) {
  const now = adapters.now ?? Date.now
  const transport = adapters.transport ?? createRemoteBackupTransport()
  let pending = false
  let controller: AbortController | undefined
  let proof:
    | {
        plan: RelayRemoteBackupPlan
        request: ReturnType<typeof remoteBackupRequest>
        envelope?: Buffer
        recheck?: RemoteBackupRecheck
        assertLive?: () => void
      }
    | undefined
  let expiry: ReturnType<typeof setTimeout> | undefined
  let generation = 0
  const waiters: Array<() => void> = []
  const clear = (): void => {
    generation++
    proof = undefined
    if (expiry) clearTimeout(expiry)
    expiry = undefined
  }
  const begin = (): void => {
    if (pending) throw new Error('请等待当前远程备份操作结束。')
    adapters.assertIdle()
    pending = true
  }
  const end = (): void => {
    pending = false
    for (const resolve of waiters.splice(0)) resolve()
  }
  return {
    isBusy: (): boolean => pending,
    whenIdle: (): Promise<void> =>
      pending ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(),
    cancel(): void {
      clear()
      controller?.abort()
    },
    async prepare(
      raw: unknown,
      recheck?: RemoteBackupRecheck,
      assertLive?: () => void
    ): Promise<RelayRemoteBackupPlan> {
      begin()
      clear()
      const preparing = generation
      try {
        const request = remoteBackupRequest(raw)
        assertLive?.()
        if (request.archiveFormat === 'legacy-zip' && !adapters.prepareLegacyArchive)
          throw new Error('旧Clash ZIP远端迁移尚未接通。')
        const archive = request.action === 'upload' ? await adapters.store.archive() : undefined
        if (archive && request.provider === 'gist' && archive.bytes.length > GIST_ARCHIVE_MAX_BYTES)
          throw new Error('Gist仅接受不超过512KiB的完整备份；请改用WebDAV或本地导出。')
        const envelope = archive
          ? await encodeRemoteArchive(archive.bytes, request.recipient)
          : undefined
        await recheck?.()
        assertLive?.()
        if (preparing !== generation) throw new Error('远程备份准备已取消。')
        adapters.assertIdle()
        const plan: RelayRemoteBackupPlan = {
          evidenceId: randomUUID(),
          provider: request.provider,
          action: request.action,
          endpoint: remoteBackupEndpoint(request),
          proxyPort: request.proxyPort,
          encrypted:
            (request.provider === 'gist' && request.action !== 'list') ||
            !!(request.action === 'upload' ? request.recipient : request.secretKey),
          containsSecrets: request.action !== 'list' && request.action !== 'delete',
          ...(request.action === 'delete' ? { etag: request.etag } : {}),
          archiveSHA256: archive?.sha256,
          archiveBytes: archive?.bytes.length,
          ...(request.action === 'download'
            ? { archiveFormat: request.archiveFormat ?? 'relay-envelope' }
            : {}),
          expiresAt: now() + 60000
        }
        proof = {
          plan,
          request,
          envelope,
          ...(recheck ? { recheck } : {}),
          ...(assertLive ? { assertLive } : {})
        }
        expiry = setTimeout(clear, 60000)
        expiry.unref()
        return structuredClone(plan)
      } finally {
        end()
      }
    },
    async execute(raw: unknown): Promise<RelayRemoteBackupResult> {
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        Object.keys(raw).join(',') !== 'evidenceId'
      )
        throw new Error('远程备份只接受本次准备凭据。')
      const prepared = proof
      const fresh = (): boolean =>
        !!prepared && now() <= prepared.plan.expiresAt && now() >= prepared.plan.expiresAt - 60000
      if (
        !prepared ||
        (raw as { evidenceId?: unknown }).evidenceId !== prepared.plan.evidenceId ||
        !fresh()
      ) {
        clear()
        throw new Error('远程备份凭据已失效，请重新准备。')
      }
      begin()
      clear()
      const operationGeneration = generation,
        legacy = prepared.request.archiveFormat === 'legacy-zip'
      let handedOff = false
      controller = new AbortController()
      const signal = controller.signal
      const assertSource = (): void => {
        if (signal.aborted) throw new Error('远程备份操作已取消。')
        if (legacy && generation !== operationGeneration)
          throw new Error('远程备份来源准备已撤销。')
        if (!handedOff && !fresh()) throw new Error('远程备份凭据已过期。')
        prepared.assertLive?.()
      }
      const verifySource = async (): Promise<void> => {
        assertSource()
        try {
          if (legacy && handedOff) await prepared.recheck?.('restore')
          else await prepared.recheck?.()
        } catch {
          throw new Error('保存的备份账号已变化或本次授权失效，请重新准备。')
        }
        assertSource()
      }
      const verify = async (): Promise<void> => {
        await verifySource()
        adapters.assertIdle()
      }
      const sendGuard = prepared.recheck ? ([verify] as const) : ([] as const)
      try {
        if (!(await adapters.confirmTransfer(structuredClone(prepared.plan))) || signal.aborted)
          return { status: 'cancelled' }
        await verify()
        if (prepared.request.action === 'delete') {
          if (!transport.delete) throw new Error('WebDAV条件删除尚未接通。')
          return await transport.delete(prepared.request, signal, ...sendGuard)
        }
        if (prepared.request.action === 'list') {
          if (!transport.list) throw new Error('备份候选列表尚未接通。')
          const listing = await transport.list(prepared.request, signal, ...sendGuard)
          await verify()
          return signal.aborted ? { status: 'cancelled' } : { status: 'listed', listing }
        }
        if (prepared.request.action === 'upload') {
          if (!prepared.envelope) throw new Error('上传备份尚未准备。')
          return await transport.upload(prepared.request, prepared.envelope, signal, ...sendGuard)
        }
        const bytes = legacy
          ? await transport.download(prepared.request, signal, verify, { assertLive: assertSource })
          : await transport.download(prepared.request, signal, ...sendGuard)
        if (signal.aborted) return { status: 'cancelled' }
        await verify()
        if (legacy) {
          if (!adapters.prepareLegacyArchive) throw new Error('旧Clash ZIP远端迁移尚未接通。')
          const result = await adapters.prepareLegacyArchive(
            bytes,
            prepared.request.proxyPort,
            signal,
            { recheck: verifySource, assertLive: assertSource }
          )
          if (signal.aborted || result.status === 'cancelled') return { status: 'cancelled' }
          await verify()
          assertSource()
          if (result.status !== 'inspected' && (result.status !== 'prepared' || !result.plan))
            throw new Error('旧Clash ZIP未能进入迁移检查。')
          if (!result.report || !result.migrationId)
            throw new Error('旧Clash ZIP迁移报告或原件记录缺失。')
          handedOff = result.status === 'prepared'
          return {
            status: result.status,
            ...(result.plan ? { plan: result.plan } : {}),
            report: structuredClone(result.report),
            migrationId: result.migrationId
          }
        }
        const result = await adapters.prepareArchive(bytes, signal)
        if (signal.aborted || result.status === 'cancelled') return { status: 'cancelled' }
        await verify()
        if (result.status !== 'prepared' || !result.plan)
          throw new Error('远程备份未能进入本地恢复预检。')
        return { status: 'prepared', plan: result.plan }
      } catch (error) {
        const cancelled = signal.aborted
        controller?.abort()
        if (cancelled) return { status: 'cancelled' }
        throw error
      } finally {
        controller = undefined
        end()
      }
    }
  }
}
