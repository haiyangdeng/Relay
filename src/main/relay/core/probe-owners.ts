import { createHash } from 'crypto'
import { lstat, opendir, realpath, mkdtemp, rename } from 'fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { atomicWriteFile } from '../../utils/safeFile'
import { readBinaryResource } from '../resources/source'
import { SubscriptionFiles } from '../subscriptions/private-files'
import type { RelayStateContext } from '../context'
import official from './manifest.json'
const heldWorkspaces = new Map<string, { dev: string; ino: string }>()
export function registerHeldProbeWorkspace(path: string, dev: string, ino: string): () => void {
  const entry = { dev, ino }
  if (heldWorkspaces.has(path)) throw new Error('临时核心工作区已持有。')
  heldWorkspaces.set(path, entry)
  return () => {
    if (heldWorkspaces.get(path) === entry) heldWorkspaces.delete(path)
  }
}
export const probeOwnerFilename = 'relay-probe-owner.json'
export type ProbePurpose = 'isolated-probe-v1' | 'isolated-substore-v1'
export interface ProbeOwnerRecord {
  version: 1
  purpose: ProbePurpose
  phase: 'preparing' | 'spawned'
  pid: number | null
  birth: null
  createdAt: number
  directory: { dev: string; ino: string }
  resource: { sha256: string; executable: string }
  configurationSHA256: string
}
interface ProbeArchiveRow {
  name: string
  dev: string
  ino: string
  ownerSHA256: string
  pid: number
}
export interface ProbeWorkspaceInspection {
  status: 'clear' | 'blocked' | 'unknown'
  count: number
  canArchive: boolean
  rows: readonly ProbeArchiveRow[]
}
const officialHashes = new Set(Object.values(official.assets).map((pin) => pin.sha256))
const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const sameKeys = (v: Record<string, unknown>, keys: string): boolean =>
  Object.keys(v).sort().join(',') === keys
const decimal = (s: unknown): s is string =>
  typeof s === 'string' && /^(?:0|[1-9][0-9]{0,19})$/u.test(s)
export function probeOwnerRecord(raw: unknown): ProbeOwnerRecord {
  if (
    !object(raw) ||
    !sameKeys(
      raw,
      'birth,configurationSHA256,createdAt,directory,phase,pid,purpose,resource,version'
    ) ||
    raw.version !== 1 ||
    raw.birth !== null ||
    !['isolated-probe-v1', 'isolated-substore-v1'].includes(String(raw.purpose)) ||
    !['preparing', 'spawned'].includes(String(raw.phase)) ||
    !Number.isSafeInteger(raw.createdAt) ||
    Number(raw.createdAt) < 1 ||
    typeof raw.configurationSHA256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(raw.configurationSHA256) ||
    !object(raw.directory) ||
    !sameKeys(raw.directory, 'dev,ino') ||
    !decimal(raw.directory.dev) ||
    !decimal(raw.directory.ino) ||
    !object(raw.resource) ||
    !sameKeys(raw.resource, 'executable,sha256') ||
    typeof raw.resource.sha256 !== 'string' ||
    !officialHashes.has(raw.resource.sha256) ||
    typeof raw.resource.executable !== 'string' ||
    !isAbsolute(raw.resource.executable) ||
    resolve(raw.resource.executable) !== raw.resource.executable ||
    basename(raw.resource.executable) !== 'mihomo' ||
    !/^darwin-(?:arm64|x64)$/u.test(basename(dirname(raw.resource.executable))) ||
    [...raw.resource.executable].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    (raw.phase === 'preparing'
      ? raw.pid !== null
      : typeof raw.pid !== 'number' ||
        !Number.isInteger(raw.pid) ||
        raw.pid < 2 ||
        raw.pid > 2147483647)
  )
    throw new Error('临时核心持久记录未知。')
  return {
    version: 1,
    purpose: raw.purpose as ProbePurpose,
    phase: raw.phase as 'preparing' | 'spawned',
    pid: raw.pid as number | null,
    birth: null,
    createdAt: raw.createdAt as number,
    directory: { dev: raw.directory.dev, ino: raw.directory.ino },
    resource: { sha256: raw.resource.sha256, executable: raw.resource.executable },
    configurationSHA256: raw.configurationSHA256
  }
}
export async function writeProbeOwner(directory: string, record: ProbeOwnerRecord): Promise<void> {
  const checked = probeOwnerRecord(record),
    info = await lstat(directory, { bigint: true })
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== BigInt(process.getuid?.() ?? -1) ||
    (info.mode & 0o7777n) !== 0o700n ||
    String(info.dev) !== record.directory.dev ||
    String(info.ino) !== record.directory.ino ||
    (await realpath(directory)) !== directory
  )
    throw new Error('临时核心持久目录已变化。')
  await atomicWriteFile(join(directory, probeOwnerFilename), JSON.stringify(checked), {
    mode: 0o600
  })
  const after = await lstat(directory, { bigint: true })
  if (after.dev !== info.dev || after.ino !== info.ino || (await realpath(directory)) !== directory)
    throw new Error('临时核心持久目录已变化。')
}
async function fixedDirectory(
  context: RelayStateContext,
  relative: string
): Promise<string | undefined> {
  const path = join(context.stateRoot, relative),
    files = new SubscriptionFiles(context)
  if (!(await files.directory(path, false))) return undefined
  const info = await lstat(path, { bigint: true })
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o7777n) !== 0o700n ||
    info.uid !== BigInt(process.getuid?.() ?? -1) ||
    (await realpath(path)) !== path
  )
    throw new Error('固定自有目录不安全。')
  return path
}
async function directoryEmpty(path: string): Promise<boolean> {
  const before = await lstat(path, { bigint: true }),
    entries = await opendir(path)
  try {
    for await (const _entry of entries) return false
    const after = await lstat(path, { bigint: true })
    return (
      before.dev === after.dev &&
      before.ino === after.ino &&
      before.mtimeNs === after.mtimeNs &&
      before.ctimeNs === after.ctimeNs &&
      (await realpath(path)) === path
    )
  } finally {
    await entries.close().catch(() => {})
  }
}
// Normal and maintenance-bootstrap reset gate: fixed paths, no process query,
// no actor instantiation or cleanup. Native uses the same conservative rule.
export async function inspectOtherAuxiliaryOwnedActorsIdle(
  context: RelayStateContext
): Promise<boolean> {
  try {
    if (await fixedDirectory(context, 'SubStore/.session')) return false
    for (const relative of ['Diagnostics/Probe', 'ScopedCLI']) {
      const path = await fixedDirectory(context, relative)
      if (path && !(await directoryEmpty(path))) return false
    }
    return true
  } catch {
    return false
  }
}
export async function inspectAuxiliaryOwnedActorsIdle(
  context: RelayStateContext
): Promise<boolean> {
  try {
    if (await fixedDirectory(context, 'CoreOwner/.session')) return false
    return inspectOtherAuxiliaryOwnedActorsIdle(context)
  } catch {
    return false
  }
}
function gone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}
export async function inspectProbeWorkspaces(
  context: RelayStateContext
): Promise<ProbeWorkspaceInspection> {
  let count = 0
  try {
    const parent = await fixedDirectory(context, 'Diagnostics/Probe')
    if (!parent) return { status: 'clear', count: 0, canArchive: false, rows: [] }
    const rows: ProbeArchiveRow[] = []
    const parentBefore = await lstat(parent, { bigint: true })
    for await (const entry of await opendir(parent)) {
      if (
        ++count > 32 ||
        !/^p-[a-zA-Z0-9]{6}$/u.test(entry.name) ||
        !entry.isDirectory() ||
        entry.isSymbolicLink()
      )
        throw new Error()
      const path = join(parent, entry.name),
        info = await lstat(path, { bigint: true })
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== BigInt(process.getuid?.() ?? -1) ||
        (info.mode & 0o7777n) !== 0o700n ||
        (await realpath(path)) !== path
      )
        throw new Error()
      const held = heldWorkspaces.get(path)
      if (held && held.dev === String(info.dev) && held.ino === String(info.ino)) continue
      const bytes = await readBinaryResource(join(path, probeOwnerFilename), true, 4096),
        record = probeOwnerRecord(JSON.parse(bytes.toString('utf8')))
      if (!Buffer.from(JSON.stringify(record)).equals(bytes)) throw new Error()
      if (
        String(info.dev) !== record.directory.dev ||
        String(info.ino) !== record.directory.ino ||
        record.phase !== 'spawned' ||
        record.pid === null
      )
        throw new Error()
      const config = await readBinaryResource(join(path, 'config.yaml'), true, 2 * 1024 * 1024)
      if (sha(config) !== record.configurationSHA256) throw new Error()
      const after = await lstat(path, { bigint: true })
      if (after.dev !== info.dev || after.ino !== info.ino) throw new Error()
      if (!gone(record.pid)) return { status: 'blocked', count, canArchive: false, rows: [] }
      rows.push({
        name: entry.name,
        dev: String(info.dev),
        ino: String(info.ino),
        ownerSHA256: sha(bytes),
        pid: record.pid
      })
    }
    const parentAfter = await lstat(parent, { bigint: true })
    if (
      parentAfter.dev !== parentBefore.dev ||
      parentAfter.ino !== parentBefore.ino ||
      parentAfter.mtimeNs !== parentBefore.mtimeNs ||
      parentAfter.ctimeNs !== parentBefore.ctimeNs ||
      (await realpath(parent)) !== parent
    )
      throw new Error()
    return {
      status: rows.length ? 'blocked' : 'clear',
      count: rows.length,
      canArchive: rows.length > 0,
      rows: rows.sort((a, b) => a.name.localeCompare(b.name))
    }
  } catch {
    return { status: 'unknown', count, canArchive: false, rows: [] }
  }
}
// Adapted from the existing Sub-Store exact-record archive. It never sends termination signals
// or deletes evidence; only a fresh native-confirmed owning operation
// can move exact dead spawned records into the fixed retained directory.
export async function archiveProbeWorkspaces(
  context: RelayStateContext,
  prepared: ProbeWorkspaceInspection,
  assertLive: () => void
): Promise<void> {
  assertLive()
  if (prepared.status !== 'blocked' || !prepared.canArchive || !prepared.rows.length)
    throw new Error('没有可明确归档的旧临时核心记录。')
  const fresh = await inspectProbeWorkspaces(context)
  assertLive()
  if (!fresh.canArchive || JSON.stringify(fresh.rows) !== JSON.stringify(prepared.rows))
    throw new Error('旧临时核心记录已变化。')
  const files = new SubscriptionFiles(context),
    archive = join(context.stateRoot, 'Diagnostics/ProbeRecovery')
  await files.directory(archive, true)
  assertLive()
  for (const row of prepared.rows) {
    const path = join(context.stateRoot, 'Diagnostics/Probe', row.name),
      before = await lstat(path, { bigint: true }),
      bytes = await readBinaryResource(join(path, probeOwnerFilename), true, 4096)
    assertLive()
    if (
      String(before.dev) !== row.dev ||
      String(before.ino) !== row.ino ||
      sha(bytes) !== row.ownerSHA256 ||
      !gone(row.pid)
    )
      throw new Error('旧临时核心归档事实已变化。')
    const container = await mkdtemp(
      join(archive, row.name + '-' + row.ownerSHA256.slice(0, 12) + '-')
    )
    const containerIdentity = await lstat(container, { bigint: true }),
      target = join(container, 'workspace')
    if (
      !containerIdentity.isDirectory() ||
      containerIdentity.isSymbolicLink() ||
      (containerIdentity.mode & 0o7777n) !== 0o700n ||
      (await realpath(container)) !== container
    )
      throw new Error('归档保留目录未确认。')
    assertLive()
    if (!gone(row.pid)) throw new Error('旧临时核心退出事实变化。')
    await rename(path, target)
    const after = await lstat(target, { bigint: true })
    if (after.dev !== before.dev || after.ino !== before.ino)
      throw new Error('旧临时核心归档未确认，保留原件。')
  }
}
