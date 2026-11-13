import { createHash, randomUUID } from 'crypto'
import { constants } from 'fs'
import { lstat, mkdir, open, realpath, rmdir, unlink } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import { atomicWriteFile } from '../../utils/safeFile'
import { coreOwnerWorkspaceAbsent } from '../core-owner/presence'
import { validateCoreMode, type RelayCoreMode } from '../../../shared/relay/core'
import type { RelayStateContext } from '../context'
import { localResolverMode, type LocalResolverMode } from '../../../shared/relay/local-proxy'
import { localProxyPortsFor, type LocalProxyPorts } from '../../../shared/relay/local-proxy-ports'

const hash = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
const missingRevision = hash('missing core preferences')
type Identity = { dev: number; ino: number }
export interface CoreLeaseRuntime {
  kind: 'localProxy'
  httpPort: number
  ports?: LocalProxyPorts
  profileId: string
  sourceSHA256: string
  resolverMode?: LocalResolverMode
}
function leaseRuntime(value: unknown): CoreLeaseRuntime | undefined {
  if (value === undefined) return undefined
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![
      'httpPort,kind,profileId,sourceSHA256',
      'httpPort,kind,profileId,resolverMode,sourceSHA256'
    ].includes(
      Object.keys(value)
        .filter((key) => key !== 'ports')
        .sort()
        .join(',')
    )
  )
    throw new Error('会话运行信息无效。')
  const record = value as Record<string, unknown>
  if (
    record.kind !== 'localProxy' ||
    typeof record.httpPort !== 'number' ||
    !Number.isInteger(record.httpPort) ||
    record.httpPort < 1024 ||
    record.httpPort > 65535 ||
    typeof record.profileId !== 'string' ||
    !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(record.profileId) ||
    typeof record.sourceSHA256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(record.sourceSHA256)
  )
    throw new Error('会话运行信息无效。')
  return {
    kind: 'localProxy',
    httpPort: record.httpPort,
    ...(record.ports === undefined
      ? {}
      : { ports: localProxyPortsFor(record.httpPort, record.ports) }),
    profileId: record.profileId,
    sourceSHA256: record.sourceSHA256,
    ...(record.resolverMode === undefined
      ? {}
      : { resolverMode: localResolverMode(record.resolverMode) })
  }
}
type Owner = {
  version: 1
  token: string
  mode: RelayCoreMode
  createdAt: string
  phase: 'starting' | 'running' | 'stopping'
  pid?: number
  runtime?: CoreLeaseRuntime
}
export interface CoreStoreSnapshot {
  mode: RelayCoreMode
  revision: string
  lease: 'missing' | 'present' | 'invalid'
}
export interface CoreStoreLease {
  update(phase: Owner['phase'], pid?: number): Promise<void>
  updateRuntime?(runtime: CoreLeaseRuntime): Promise<void>
  release(): Promise<void>
}

export class CoreStore {
  readonly directory: string
  private readonly leaseDirectory: string
  constructor(private readonly context: RelayStateContext) {
    const { home, stateRoot } = context
    if (
      !isAbsolute(home) ||
      resolve(home) !== home ||
      home.includes('\0') ||
      !['Relay', 'Relay-Preview']
        .map((name) => join(home, 'Library/Application Support', name))
        .includes(stateRoot)
    )
      throw new Error('核心数据目录上下文无效。')
    this.directory = join(stateRoot, 'Core')
    this.leaseDirectory = join(this.directory, '.session')
  }
  private async sync(path: string): Promise<void> {
    const file = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try {
      await file.sync()
    } finally {
      await file.close()
    }
  }
  private async directories(target: string, create: boolean): Promise<boolean> {
    if (!(target === this.context.home || target.startsWith(this.context.home + '/')))
      throw new Error('核心路径无效。')
    let current = this.context.home
    for (const segment of ['', ...relative(this.context.home, target).split('/').filter(Boolean)]) {
      if (segment) current = join(current, segment)
      let info: Awaited<ReturnType<typeof lstat>>
      try {
        info = await lstat(current)
      } catch (error) {
        if (current === this.context.home) throw new Error('用户目录必须已存在。')
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !create) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
          throw error
        }
        await mkdir(current, { mode: 0o700 })
        info = await lstat(current)
        await this.sync(dirname(current))
      }
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        info.mode & 0o022 ||
        (await realpath(current)) !== current
      )
        throw new Error('核心数据目录类型、归属或权限不安全。')
    }
    return true
  }
  private async text(path: string): Promise<string | undefined> {
    let file: Awaited<ReturnType<typeof open>>
    try {
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    try {
      const info = await file.stat()
      if (
        !info.isFile() ||
        info.uid !== process.getuid?.() ||
        info.nlink !== 1 ||
        (info.mode & 0o7777) !== 0o600 ||
        info.size > 4096
      )
        throw new Error('核心记录格式或权限异常。')
      const buffer = Buffer.alloc(4097),
        { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead > 4096 || bytesRead !== info.size) throw new Error('核心记录读取期间发生改变。')
      return buffer.subarray(0, bytesRead).toString('utf8')
    } finally {
      await file.close()
    }
  }
  private owner(raw: string): Owner {
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效记录。')
    const record = value as Record<string, unknown>
    if (
      Object.keys(record).some(
        (key) => !['version', 'token', 'mode', 'createdAt', 'phase', 'pid', 'runtime'].includes(key)
      ) ||
      record.version !== 1 ||
      typeof record.token !== 'string' ||
      !/^[a-f0-9-]{36}$/u.test(record.token) ||
      typeof record.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(record.createdAt)) ||
      !['starting', 'running', 'stopping'].some((phase) => phase === record.phase) ||
      (record.pid !== undefined && (!Number.isInteger(record.pid) || Number(record.pid) < 1)) ||
      (record.phase === 'running' && record.pid === undefined)
    )
      throw new Error('无效记录。')
    return {
      version: 1,
      token: record.token,
      mode: validateCoreMode(record.mode),
      createdAt: record.createdAt,
      phase: record.phase as Owner['phase'],
      ...(record.runtime === undefined ? {} : { runtime: leaseRuntime(record.runtime) }),
      ...(record.pid === undefined ? {} : { pid: Number(record.pid) })
    }
  }
  async inspect(): Promise<CoreStoreSnapshot> {
    const ownerAbsent = await coreOwnerWorkspaceAbsent(this.context)
    if (!(await this.directories(this.directory, false)))
      return { mode: 'rule', revision: missingRevision, lease: ownerAbsent ? 'missing' : 'invalid' }
    const raw = await this.text(join(this.directory, 'preferences.json'))
    let mode: RelayCoreMode = 'rule'
    if (raw !== undefined) {
      const value: unknown = JSON.parse(raw)
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== 'mode,version' ||
        (value as Record<string, unknown>).version !== 1
      )
        throw new Error('核心偏好版本或内容不兼容，未覆盖。')
      mode = validateCoreMode((value as Record<string, unknown>).mode)
    }
    let lease: CoreStoreSnapshot['lease'] = 'missing'
    try {
      const info = await lstat(this.leaseDirectory)
      lease = 'invalid'
      if (
        info.isDirectory() &&
        !info.isSymbolicLink() &&
        info.uid === process.getuid?.() &&
        (info.mode & 0o7777) === 0o700 &&
        (await realpath(this.leaseDirectory)) === this.leaseDirectory
      ) {
        const owner = await this.text(join(this.leaseDirectory, 'owner.json'))
        if (owner !== undefined) {
          this.owner(owner)
          lease = 'present'
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') lease = 'invalid'
    }
    return {
      mode,
      revision: raw === undefined ? missingRevision : hash(raw),
      lease: !ownerAbsent && lease === 'missing' ? 'invalid' : lease
    }
  }
  async acquire(
    mode: RelayCoreMode,
    expectedRevision: string,
    runtime?: CoreLeaseRuntime
  ): Promise<CoreStoreLease> {
    validateCoreMode(mode)
    const context = leaseRuntime(runtime)
    if (!/^[a-f0-9]{64}$/u.test(expectedRevision)) throw new Error('请重新准备核心配置。')
    if (!(await coreOwnerWorkspaceAbsent(this.context)))
      throw new Error('CoreOwner session unresolved')
    await this.directories(this.directory, true)
    await mkdir(this.leaseDirectory, { mode: 0o700 }) // Exclusive; never reclaim stale leases by PID.
    const identity: Identity = await lstat(this.leaseDirectory)
    let raw: string | undefined,
      owner: Owner = {
        version: 1,
        token: randomUUID(),
        mode,
        createdAt: new Date().toISOString(),
        phase: 'starting',
        ...(context ? { runtime: context } : {})
      }
    let ownerRemoved = false,
      directoryRemoved = false
    const assertDirectory = async (): Promise<void> => {
      await this.directories(this.directory, false)
      const now = await lstat(this.leaseDirectory)
      if (
        !now.isDirectory() ||
        now.isSymbolicLink() ||
        now.uid !== process.getuid?.() ||
        (now.mode & 0o7777) !== 0o700 ||
        now.dev !== identity.dev ||
        now.ino !== identity.ino
      )
        throw new Error('核心会话目录被改变，保留记录。')
    }
    const assertOwner = async (): Promise<void> => {
      await assertDirectory()
      if ((await this.text(join(this.leaseDirectory, 'owner.json'))) !== raw)
        throw new Error('核心会话记录被改变，停止覆盖。')
    }
    const release = async (): Promise<void> => {
      if (!directoryRemoved) {
        await assertDirectory()
        if (!ownerRemoved) {
          await assertOwner()
          if (raw !== undefined) await unlink(join(this.leaseDirectory, 'owner.json'))
          ownerRemoved = true
        } else if ((await this.text(join(this.leaseDirectory, 'owner.json'))) !== undefined)
          throw new Error('出现新记录，未删除。')
        await rmdir(this.leaseDirectory) // Never recursively remove unknown files.
        directoryRemoved = true
      } else {
        try {
          await lstat(this.leaseDirectory)
          throw new Error('出现新会话，停止清理。')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
      await this.sync(this.directory)
    }
    const update = async (phase: Owner['phase'], pid?: number): Promise<void> => {
      await assertOwner()
      const allowed =
        owner.phase === 'starting'
          ? ['starting', 'running', 'stopping']
          : owner.phase === 'running'
            ? ['running', 'stopping']
            : ['stopping']
      if (!allowed.includes(phase)) throw new Error('会话阶段不能倒退。')
      owner = { ...owner, phase, ...(pid === undefined ? {} : { pid }) }
      const next = JSON.stringify(owner)
      this.owner(next)
      await atomicWriteFile(join(this.leaseDirectory, 'owner.json'), next, { mode: 0o600 })
      raw = next // Track publication before directory sync, even if sync fails.
      await this.sync(this.leaseDirectory)
      await this.sync(this.directory)
    }
    const updateRuntime = async (runtime: CoreLeaseRuntime): Promise<void> => {
      await assertOwner()
      if (owner.phase !== 'running') throw new Error('只有本次运行中的实例可更新来源绑定。')
      const checked = leaseRuntime(runtime)
      if (!checked) throw new Error('运行来源绑定无效。')
      const next = JSON.stringify({ ...owner, runtime: checked })
      this.owner(next)
      await atomicWriteFile(join(this.leaseDirectory, 'owner.json'), next, { mode: 0o600 })
      raw = next
      owner = { ...owner, runtime: checked }
      await this.sync(this.leaseDirectory)
      await this.sync(this.directory)
    }
    try {
      if (!(await coreOwnerWorkspaceAbsent(this.context)))
        throw new Error('CoreOwner session appeared')
      const snapshot = await this.inspect()
      if (snapshot.revision !== expectedRevision) throw new Error('核心偏好已改变，请重新准备。')
      await update('starting')
      if ((await this.inspect()).revision !== expectedRevision) throw new Error('核心偏好已改变。')
      await atomicWriteFile(
        join(this.directory, 'preferences.json'),
        JSON.stringify({ version: 1, mode }),
        { mode: 0o600 }
      )
      await this.sync(this.directory)
      if (!(await coreOwnerWorkspaceAbsent(this.context)))
        throw new Error('CoreOwner session appeared')
      return { update, updateRuntime, release }
    } catch {
      try {
        await release()
      } catch {
        throw new Error('核心准备未完成且记录清理未确认，请检查记录。')
      }
      throw new Error('核心准备未完成；未启动子进程，请重新读取配置。')
    }
  }
}
