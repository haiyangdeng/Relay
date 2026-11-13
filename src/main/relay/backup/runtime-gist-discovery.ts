import { randomUUID } from 'crypto'
import {
  backupAccountMetadata,
  backupAccountSelection,
  type RelayBackupAccount
} from '../../../shared/relay/backup-accounts'
import { RUNTIME_GIST_FILENAME } from '../../../shared/relay/runtime-gist'
import {
  RUNTIME_GIST_DESCRIPTION,
  runtimeGistDiscoveryEvidence,
  runtimeGistDiscoveryRequest,
  type RelayRuntimeGistDiscoveryCandidate,
  type RelayRuntimeGistDiscoveryPlan,
  type RelayRuntimeGistDiscoveryResult
} from '../../../shared/relay/runtime-gist-discovery'
import { requestOnce, type PluginRequestOptions } from '../../resolve/plugin/http-client'
import type { RelayBackupAccountsStore } from './accounts-store'

const maximumResponseBytes = 2 * 1024 * 1024,
  maximumPayloadBytes = 1024 * 1024,
  lifetime = 60000
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
function account(value: RelayBackupAccount): RelayBackupAccount {
  const { revision, ...metadata } = value,
    selection = backupAccountSelection({ id: value.id, revision }),
    checked = { ...backupAccountMetadata(metadata), revision: selection.revision }
  if (checked.provider !== 'gist' || checked.state !== 'active')
    throw new Error('请选择已保存且启用的Gist账号。')
  return checked
}
function candidates(bytes: Buffer): {
  scanned: number
  entries: RelayRuntimeGistDiscoveryCandidate[]
} {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maximumResponseBytes)
    throw new Error('候选列表响应大小无效。')
  const rows: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  if (!Array.isArray(rows) || rows.length > 100) throw new Error('候选列表格式或行数无效。')
  const entries: RelayRuntimeGistDiscoveryCandidate[] = [],
    ids = new Set<string>()
  for (const row of rows) {
    if (
      !object(row) ||
      row.description !== RUNTIME_GIST_DESCRIPTION ||
      row.public !== false ||
      (row.truncated !== undefined && row.truncated !== false) ||
      typeof row.id !== 'string' ||
      !/^[a-f0-9]{5,64}$/u.test(row.id) ||
      typeof row.updated_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(row.updated_at) ||
      !Number.isFinite(Date.parse(row.updated_at)) ||
      new Date(row.updated_at).toISOString() !== row.updated_at.replace('Z', '.000Z') ||
      !object(row.files) ||
      Object.keys(row.files).join(',') !== RUNTIME_GIST_FILENAME
    )
      continue
    const file = row.files[RUNTIME_GIST_FILENAME]
    if (
      !object(file) ||
      file.filename !== RUNTIME_GIST_FILENAME ||
      (file.truncated !== undefined && file.truncated !== false) ||
      !Number.isSafeInteger(file.size) ||
      Number(file.size) < 1 ||
      Number(file.size) > maximumPayloadBytes
    )
      continue
    if (ids.has(row.id)) throw new Error('候选列表含重复ID。')
    ids.add(row.id)
    // Only known metadata crosses IPC. In particular, do not use raw_url,
    // html_url, content, owner, or arbitrary description/unknown field names.
    entries.push({
      id: row.id,
      updatedAt: row.updated_at,
      payloadBytes: Number(file.size),
      verified: false
    })
  }
  return { scanned: rows.length, entries }
}
class DiscoveryRevoked extends Error {}

// A read-only authority independent of runtime capture and all write proofs.
// Each consumed proof permits one page GET; selection grants no later write.
export function createRuntimeGistDiscoveryService(adapters: {
  store: Pick<RelayBackupAccountsStore, 'read' | 'credential'>
  assertIdle(): void
  confirm(plan: RelayRuntimeGistDiscoveryPlan): Promise<boolean>
  request?: typeof requestOnce
  now?(): number
}) {
  const now = adapters.now ?? Date.now,
    request = adapters.request ?? requestOnce,
    waiters: Array<() => void> = []
  type Prepared = {
    plan: RelayRuntimeGistDiscoveryPlan
    account: RelayBackupAccount
    epoch: number
    at: number
    assertLive?: () => void
  }
  let pending = false,
    epoch = 0,
    proof: Prepared | undefined,
    active: { evidenceId: string; controller: AbortController } | undefined
  const begin = (): void => {
    if (pending) throw new Error('请等待本次Gist候选读取结束。')
    adapters.assertIdle()
    pending = true
  }
  const end = (): void => {
    pending = false
    waiters.splice(0).forEach((resolve) => resolve())
  }
  const invalidate = (): void => {
    ++epoch
    proof = undefined
    active?.controller.abort()
  }
  const live = (prepared: Prepared, signal?: AbortSignal): void => {
    const fresh = (): boolean => {
      const at = now()
      return (
        !signal?.aborted &&
        prepared.epoch === epoch &&
        Number.isSafeInteger(at) &&
        at >= prepared.at &&
        at < prepared.plan.expiresAt
      )
    }
    if (!fresh()) throw new DiscoveryRevoked()
    try {
      adapters.assertIdle()
      // Idle checks can synchronously change window state without an event.
      // Context is the final external guard before the pure freshness check.
      prepared.assertLive?.()
    } catch {
      throw new DiscoveryRevoked()
    }
    if (!fresh()) throw new DiscoveryRevoked()
  }
  const recheck = async (prepared: Prepared, signal?: AbortSignal): Promise<void> => {
    live(prepared, signal)
    try {
      const selected = backupAccountSelection({
          id: prepared.plan.id,
          revision: prepared.plan.revision
        }),
        current = account(await adapters.store.read(selected))
      live(prepared, signal)
      if (JSON.stringify(current) !== JSON.stringify(prepared.account)) throw new DiscoveryRevoked()
    } catch {
      throw new DiscoveryRevoked()
    }
  }
  return {
    isBusy: (): boolean => pending,
    whenIdle: (): Promise<void> =>
      pending ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(),
    invalidate,
    cancel(raw: unknown): boolean {
      const { evidenceId } = runtimeGistDiscoveryEvidence(raw)
      if (proof?.plan.evidenceId !== evidenceId && active?.evidenceId !== evidenceId) return false
      invalidate()
      return true
    },
    async prepare(raw: unknown, assertLive?: () => void): Promise<RelayRuntimeGistDiscoveryPlan> {
      const input = runtimeGistDiscoveryRequest(raw)
      begin()
      invalidate()
      const started = now(),
        preparing = epoch
      try {
        if (
          !Number.isSafeInteger(started) ||
          started < 0 ||
          !Number.isSafeInteger(started + lifetime)
        )
          throw new DiscoveryRevoked()
        assertLive?.()
        const selected = backupAccountSelection({ id: input.id, revision: input.revision }),
          saved = account(await adapters.store.read(selected)),
          page = input.page ?? 1,
          plan: RelayRuntimeGistDiscoveryPlan = {
            ...selected,
            evidenceId: randomUUID(),
            action: 'listRuntimeCandidates',
            name: saved.name,
            endpoint: `https://api.github.com/gists?per_page=100&page=${page}`,
            proxyPort: saved.proxyPort,
            description: RUNTIME_GIST_DESCRIPTION,
            filename: RUNTIME_GIST_FILENAME,
            page,
            perPage: 100,
            expiresAt: started + lifetime
          },
          prepared: Prepared = { plan, account: saved, epoch: preparing, at: started, assertLive }
        if (saved.id !== selected.id || saved.revision !== selected.revision)
          throw new DiscoveryRevoked()
        live(prepared)
        proof = prepared
        return structuredClone(plan)
      } catch {
        throw new Error('运行Gist候选准备未通过；请重新核对账号和当前界面。')
      } finally {
        end()
      }
    },
    async execute(raw: unknown): Promise<RelayRuntimeGistDiscoveryResult> {
      const { evidenceId } = runtimeGistDiscoveryEvidence(raw),
        prepared = proof
      if (!prepared || prepared.plan.evidenceId !== evidenceId)
        throw new Error('运行Gist候选凭据已失效，请重新准备。')
      begin()
      proof = undefined
      const controller = new AbortController(),
        signal = controller.signal
      active = { evidenceId, controller }
      try {
        await recheck(prepared, signal)
        live(prepared, signal)
        const accepted = await adapters.confirm(structuredClone(prepared.plan))
        live(prepared, signal)
        if (accepted !== true) return { status: 'cancelled' }
        await recheck(prepared, signal)
        live(prepared, signal)
        const selected = backupAccountSelection({
            id: prepared.plan.id,
            revision: prepared.plan.revision
          }),
          credential = await adapters.store.credential(selected)
        live(prepared, signal)
        if (
          JSON.stringify(account(credential.account)) !== JSON.stringify(prepared.account) ||
          typeof credential.secret !== 'string' ||
          !/^[\x21-\x7e]{8,500}$/u.test(credential.secret)
        )
          throw new Error('本次账号凭据无效。')
        await recheck(prepared, signal)
        const options: PluginRequestOptions = {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${credential.secret}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'Relay-Runtime-Gist-Discovery',
            'Cache-Control': 'no-cache'
          },
          timeout: Math.max(1, Math.min(lifetime, prepared.plan.expiresAt - now())),
          maxBytes: maximumResponseBytes,
          proxy: { host: '127.0.0.1', port: prepared.plan.proxyPort },
          signal,
          binary: true,
          captureRedirects: true
        }
        if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('TLS校验已关闭。')
        // No await/observer callback after this synchronous capability check.
        live(prepared, signal)
        const response = await request(prepared.plan.endpoint, options)
        live(prepared, signal)
        if (response.status !== 200 || !Buffer.isBuffer(response.bytes))
          throw new Error('列表请求未确认。')
        const listing = candidates(response.bytes),
          link = response.headers.link
        if (link !== undefined && (typeof link !== 'string' || link.length > 8192))
          throw new Error('分页提示无效。')
        const moreAvailable = typeof link === 'string' && /;\s*rel="next"/u.test(link),
          page = prepared.plan.page
        await recheck(prepared, signal)
        live(prepared, signal)
        return {
          status: 'listed',
          page,
          ...listing,
          moreAvailable,
          ...(moreAvailable && page < 1000 ? { nextPage: page + 1 } : {}),
          budgetReached: moreAvailable && page === 1000,
          checkedAt: now(),
          account: selected
        }
      } catch (error) {
        if (error instanceof DiscoveryRevoked || signal.aborted || prepared.epoch !== epoch)
          return { status: 'cancelled' }
        throw new Error('运行Gist候选读取未确认；请核对账号、权限及代理，不会自动重试。')
      } finally {
        if (active?.evidenceId === evidenceId) active = undefined
        end()
      }
    }
  }
}
