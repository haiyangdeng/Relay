import { randomUUID } from 'crypto'
import { constants, type Stats } from 'fs'
import { lstat, mkdir, open, opendir, realpath } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import type { RelayStateContext } from '../context'
import {
  stripProfileControls,
  type RelayProfileInventory,
  type RelayStoredProfile
} from '../../../shared/relay/profiles'
import { profileSelection } from '../../../shared/relay/runtime'
import { inspectProfile } from './inspect'
import { profileHash, readProfileFile } from './source'

const idPattern = /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
export interface LegacyProfileFileIdentity {
  dev: number
  ino: number
  uid: number
  mode: number
  nlink: number
  size: number
  mtimeMs: number
  ctimeMs: number
}
export interface LegacyProfileSourceIdentity {
  root: LegacyProfileFileIdentity
  directory: LegacyProfileFileIdentity
  metadata: LegacyProfileFileIdentity
  configuration: LegacyProfileFileIdentity
}
export interface LegacyProfileSelection {
  id: string
  sha256: string
  revision: string
}
export interface LegacyProfileSource {
  profile: RelayStoredProfile
  text: string
  metadata: string
  revision: string
  identity: LegacyProfileSourceIdentity
}
export interface LegacyProfileInventory {
  profiles: Omit<LegacyProfileSource, 'text' | 'metadata'>[]
  rootIdentity: LegacyProfileFileIdentity | null
  incomplete: number
  warnings: string[]
}
const fileIdentity = (info: Stats): LegacyProfileFileIdentity => ({
  dev: info.dev,
  ino: info.ino,
  uid: info.uid,
  mode: info.mode,
  nlink: info.nlink,
  size: info.size,
  mtimeMs: info.mtimeMs,
  ctimeMs: info.ctimeMs
})
const sameIdentity = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right)
export class ProfileWriteUncertain extends Error {
  constructor() {
    super('配置写入或同步未确认；保留本次目录，请刷新列表核对。')
  }
}
export class ProfileStore {
  readonly directory: string
  private readonly legacyDirectory?: string
  constructor(
    private readonly context: RelayStateContext,
    namespace: 'Configurations' | 'ProviderResources' = 'Configurations'
  ) {
    if (namespace !== 'Configurations' && namespace !== 'ProviderResources')
      throw new Error('私有记录命名空间无效。')
    if (
      !isAbsolute(context.home) ||
      resolve(context.home) !== context.home ||
      context.home.includes('\0') ||
      !['Relay', 'Relay-Preview']
        .map((name) => join(context.home, 'Library/Application Support', name))
        .includes(context.stateRoot)
    )
      throw new Error('配置数据目录上下文无效。')
    this.directory = join(context.stateRoot, namespace)
    this.legacyDirectory =
      namespace === 'Configurations' ? join(context.stateRoot, 'Profiles') : undefined
  }
  private async sync(path: string): Promise<void> {
    const handle = await open(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
    )
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  private async directories(target: string, create: boolean): Promise<boolean> {
    if (!(target === this.context.home || target.startsWith(this.context.home + '/')))
      throw new Error('配置路径无效。')
    let current = this.context.home
    for (const segment of ['', ...relative(this.context.home, target).split('/').filter(Boolean)]) {
      if (segment) current = join(current, segment)
      let info: Awaited<ReturnType<typeof lstat>>
      try {
        info = await lstat(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || current === this.context.home)
          throw error
        if (!create) return false
        try {
          await mkdir(current, { mode: 0o700 })
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        }
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
        throw new Error('配置目录类型、归属或权限不安全。')
    }
    return true
  }
  private async writeNew(path: string, text: string): Promise<void> {
    const handle = await open(path, 'wx', 0o600)
    try {
      await handle.writeFile(text, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
  }
  async save(name: string, text: string): Promise<RelayStoredProfile> {
    if (!name || name.length > 120 || stripProfileControls(name) !== name)
      throw new Error('配置名称无效。')
    const inspected = inspectProfile(text)
    if (inspected.structure !== 'passed' || !inspected.summary)
      throw new Error('配置结构未通过检查。')
    const profile: RelayStoredProfile = {
      id: randomUUID(),
      name,
      createdAt: new Date().toISOString(),
      sha256: profileHash(text),
      summary: inspected.summary
    }
    await this.directories(this.directory, true)
    const directory = join(this.directory, profile.id)
    await mkdir(directory, { mode: 0o700 }) // New immutable record, no shared index or overwrite.
    try {
      const identity = await lstat(directory)
      await this.sync(this.directory)
      const same = async (): Promise<void> => {
        await this.directories(directory, false)
        const info = await lstat(directory)
        if (
          info.dev !== identity.dev ||
          info.ino !== identity.ino ||
          (info.mode & 0o7777) !== 0o700
        )
          throw new Error()
      }
      await same()
      await this.writeNew(join(directory, 'profile.yaml'), text)
      await same()
      await this.writeNew(
        join(directory, 'metadata.json'),
        JSON.stringify({ version: 1, ...profile })
      )
      await same()
      await this.sync(directory)
      await this.sync(this.directory)
      return structuredClone(profile)
    } catch {
      throw new ProfileWriteUncertain()
    }
  }
  private async load(
    id: string,
    root: string
  ): Promise<{ profile: RelayStoredProfile; text: string; metadata: string; revision: string }> {
    if (!idPattern.test(id)) throw new Error('配置ID无效。')
    const directory = join(root, id)
    if (!(await this.directories(directory, false))) throw new Error()
    const identity = await lstat(directory)
    if ((identity.mode & 0o7777) !== 0o700) throw new Error()
    let members = 0
    for await (const member of await opendir(directory)) {
      if (++members > 2 || !['profile.yaml', 'metadata.json'].includes(member.name))
        throw new Error()
    }
    if (members !== 2) throw new Error()
    const raw = await readProfileFile(join(directory, 'metadata.json'), true)
    if (Buffer.byteLength(raw) > 4096) throw new Error()
    const value: unknown = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    const meta = value as Record<string, unknown>
    if (
      Object.keys(meta).sort().join(',') !== 'createdAt,id,name,sha256,summary,version' ||
      meta.version !== 1 ||
      meta.id !== id ||
      typeof meta.name !== 'string' ||
      !meta.name ||
      meta.name.length > 120 ||
      stripProfileControls(meta.name) !== meta.name ||
      typeof meta.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(meta.createdAt)) ||
      typeof meta.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(meta.sha256)
    )
      throw new Error()
    const text = await readProfileFile(join(directory, 'profile.yaml'), true)
    const inspected = inspectProfile(text)
    if (
      inspected.structure !== 'passed' ||
      !inspected.summary ||
      profileHash(text) !== meta.sha256 ||
      JSON.stringify(meta.summary) !== JSON.stringify(inspected.summary)
    )
      throw new Error()
    const after = await lstat(directory)
    if (after.dev !== identity.dev || after.ino !== identity.ino) throw new Error()
    return {
      profile: {
        id,
        name: meta.name,
        createdAt: meta.createdAt,
        sha256: meta.sha256,
        summary: inspected.summary
      },
      text,
      metadata: raw,
      revision: profileHash(root + '\0' + raw + '\0' + text)
    }
  }
  private async locations(id: string): Promise<string[]> {
    if (!idPattern.test(id)) throw new Error('配置ID无效。')
    const roots: string[] = []
    for (const root of [this.directory, ...(this.legacyDirectory ? [this.legacyDirectory] : [])]) {
      if (!(await this.directories(root, false))) continue
      try {
        await lstat(join(root, id))
        roots.push(root)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return roots
  }
  async read(
    raw: unknown
  ): Promise<{ profile: RelayStoredProfile; text: string; revision: string }> {
    const selection = profileSelection(raw),
      roots = await this.locations(selection.id)
    if (roots.length !== 1) throw new Error('配置不存在，或新旧目录存在重复ID；未自动选择。')
    const result = await this.load(selection.id, roots[0])
    if (result.profile.sha256 !== selection.sha256)
      throw new Error('配置原文已变化，请重新读取列表。')
    return { profile: result.profile, text: result.text, revision: result.revision }
  }
  // Main-only legacy migration readers. They never resolve through the new
  // Configurations root, so ordinary read/list retain their ambiguity refusal.
  private async captureLegacy(
    id: string,
    expectedIdentity?: LegacyProfileSourceIdentity
  ): Promise<LegacyProfileSource> {
    if (!this.legacyDirectory || !idPattern.test(id)) throw new Error('旧配置来源无效。')
    const root = this.legacyDirectory,
      directory = join(root, id),
      identities = async (): Promise<LegacyProfileSourceIdentity> => {
        const rootInfo = await lstat(root),
          directoryInfo = await lstat(directory)
        if (
          !rootInfo.isDirectory() ||
          rootInfo.isSymbolicLink() ||
          !directoryInfo.isDirectory() ||
          directoryInfo.isSymbolicLink()
        )
          throw new Error('旧配置来源目录类型无效。')
        return {
          root: fileIdentity(rootInfo),
          directory: fileIdentity(directoryInfo),
          metadata: fileIdentity(await lstat(join(directory, 'metadata.json'))),
          configuration: fileIdentity(await lstat(join(directory, 'profile.yaml')))
        }
      }
    if (!(await this.directories(directory, false))) throw new Error('旧配置目录不存在。')
    const before = await identities()
    if (expectedIdentity && !sameIdentity(before, expectedIdentity))
      throw new Error('旧配置来源或根身份已变化，请重新检查。')
    const loaded = await this.load(id, root),
      after = await identities()
    if (!sameIdentity(before, after)) throw new Error('旧配置来源读取期间已变化。')
    return { ...loaded, identity: after }
  }
  async listLegacy(): Promise<LegacyProfileInventory> {
    const report: LegacyProfileInventory = {
      profiles: [],
      rootIdentity: null,
      incomplete: 0,
      warnings: []
    }
    if (!this.legacyDirectory || !(await this.directories(this.legacyDirectory, false)))
      return report
    const before = fileIdentity(await lstat(this.legacyDirectory))
    let count = 0
    for await (const entry of await opendir(this.legacyDirectory)) {
      if (++count > 200) {
        report.warnings.push('旧根条目超过200项，本次列表已截断；未读取或删除其余条目。')
        break
      }
      if (!idPattern.test(entry.name)) continue
      try {
        const { profile, revision, identity } = await this.captureLegacy(entry.name)
        report.profiles.push({ profile, revision, identity })
      } catch {
        report.incomplete++
      }
    }
    const after = fileIdentity(await lstat(this.legacyDirectory))
    if (!sameIdentity(before, after)) throw new Error('旧配置根读取期间已变化，请重新检查。')
    report.rootIdentity = after
    report.profiles.sort((a, b) => a.profile.id.localeCompare(b.profile.id))
    if (report.incomplete)
      report.warnings.push('存在损坏或未知UUID条目，未作为迁移来源；原件完整保留。')
    return report
  }
  async readLegacy(
    selection: LegacyProfileSelection,
    expectedIdentity: LegacyProfileSourceIdentity
  ): Promise<LegacyProfileSource> {
    if (
      !selection ||
      typeof selection !== 'object' ||
      Object.keys(selection).sort().join(',') !== 'id,revision,sha256' ||
      typeof selection.id !== 'string' ||
      !idPattern.test(selection.id) ||
      typeof selection.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(selection.sha256) ||
      typeof selection.revision !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(selection.revision) ||
      !expectedIdentity
    )
      throw new Error('旧配置只接受本次检查的标识、摘要和修订。')
    const result = await this.captureLegacy(selection.id, expectedIdentity)
    if (
      result.profile.sha256 !== selection.sha256 ||
      result.revision !== selection.revision ||
      !sameIdentity(result.identity, expectedIdentity)
    )
      throw new Error('旧配置来源或根身份已变化，请重新检查。')
    return result
  }
  async list(): Promise<RelayProfileInventory> {
    const report: RelayProfileInventory = {
      profiles: [],
      incomplete: 0,
      activeId: null,
      warnings: []
    }
    let count = 0,
      truncated = false,
      legacy = false
    for (const root of [this.directory, ...(this.legacyDirectory ? [this.legacyDirectory] : [])]) {
      if (!(await this.directories(root, false))) continue
      for await (const entry of await opendir(root)) {
        if (++count > 200) {
          truncated = true
          break
        }
        // The legacy Profiles folder also contains native Edge staging files.
        // Only its old UUID records are ours; do not read other entries.
        if (root === this.legacyDirectory && !idPattern.test(entry.name)) continue
        if (root === this.legacyDirectory) legacy = true
        try {
          if (!idPattern.test(entry.name) || (await this.locations(entry.name)).length !== 1)
            throw new Error()
          report.profiles.push((await this.load(entry.name, root)).profile)
        } catch {
          ++report.incomplete
        }
      }
      if (truncated) break
    }
    if (truncated) report.warnings.push('条目超过200项，本次列表已截断；未删除任何文件。')
    if (legacy)
      report.warnings.push('旧试验Profiles目录仅作只读兼容；没有迁移配置或访问Edge暂存文件。')
    report.profiles.sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)
    )
    if (report.incomplete)
      report.warnings.push('存在不完整、被改动或未知条目；保留原文件，未作为可用配置。')
    return report
  }
}
