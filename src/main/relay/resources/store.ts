import { randomUUID } from 'crypto'
import { lstat, mkdir, open, opendir } from 'fs/promises'
import { join } from 'path'
import type { RelayStateContext } from '../context'
import { profileSelection } from '../../../shared/relay/runtime'
import {
  resourceDescriptor,
  type ResourceDescriptor,
  type ResourceInfo,
  type ResourceInventory
} from '../../../shared/relay/resources'
import { SubscriptionFiles } from '../subscriptions/private-files'
import { profileHash, readProfileFile } from '../profiles/source'
import { readBinaryResource, resourceHash, RESOURCE_BYTE_LIMIT } from './source'

export class ResourceWriteUncertain extends Error {
  constructor() {
    super('资源写入或同步未确认；保留文件，不自动重试。')
  }
}
export class ResourceStore {
  readonly directory: string
  private readonly files: SubscriptionFiles
  constructor(context: RelayStateContext) {
    this.files = new SubscriptionFiles(context)
    this.directory = join(context.stateRoot, 'ResourceSnapshots')
  }
  async save(raw: ResourceDescriptor, input: Buffer): Promise<ResourceInfo> {
    const descriptor = resourceDescriptor(raw)
    if (!Buffer.isBuffer(input) || !input.length || input.length > RESOURCE_BYTE_LIMIT)
      throw new Error('资源大小无效。')
    const bytes = Buffer.from(input)
    const info: ResourceInfo = {
      ...descriptor,
      id: randomUUID(),
      sha256: resourceHash(bytes),
      size: bytes.length,
      createdAt: new Date().toISOString(),
      integrity: 'notChecked'
    }
    await this.files.directory(this.directory, true)
    const root = join(this.directory, info.id)
    await mkdir(root, { mode: 0o700 })
    const identity = await lstat(root)
    const same = async (): Promise<void> => {
      if (!(await this.files.directory(root)) || ((await lstat(root)).mode & 0o7777) !== 0o700)
        throw new Error()
      const after = await lstat(root)
      if (after.dev !== identity.dev || after.ino !== identity.ino) throw new Error()
    }
    try {
      await this.files.sync(this.directory)
      await same()
      // Exclusive creation, never writes to a source path or follows a link.
      const file = await open(join(root, 'resource.bin'), 'wx', 0o600)
      try {
        await file.writeFile(bytes)
        await file.sync()
      } finally {
        await file.close()
      }
      await same()
      await this.files.write(join(root, 'metadata.json'), JSON.stringify({ version: 1, ...info }))
      await same()
      await this.files.sync(root)
      await this.files.sync(this.directory)
      return structuredClone(info)
    } catch {
      throw new ResourceWriteUncertain()
    }
  }
  private async metadata(id: string) {
    profileSelection({ id, sha256: '0'.repeat(64) })
    const root = join(this.directory, id)
    if (!(await this.files.directory(root)) || ((await lstat(root)).mode & 0o7777) !== 0o700)
      throw new Error()
    const identity = await lstat(root)
    let count = 0
    for await (const entry of await opendir(root))
      if (++count > 2 || !['resource.bin', 'metadata.json'].includes(entry.name)) throw new Error()
    if (count !== 2) throw new Error()
    const raw = await readProfileFile(join(root, 'metadata.json'), true)
    if (Buffer.byteLength(raw) > 4096) throw new Error()
    const value: unknown = JSON.parse(raw)
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !==
        'behavior,createdAt,id,integrity,kind,name,selector,sha256,size,version'
    )
      throw new Error()
    const v = value as Record<string, unknown>,
      descriptor = resourceDescriptor({
        name: v.name,
        kind: v.kind,
        behavior: v.behavior,
        selector: v.selector
      })
    if (
      v.version !== 1 ||
      v.id !== id ||
      typeof v.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(v.sha256) ||
      typeof v.size !== 'number' ||
      !Number.isSafeInteger(v.size) ||
      v.size < 1 ||
      v.size > RESOURCE_BYTE_LIMIT ||
      typeof v.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(v.createdAt)) ||
      v.integrity !== 'notChecked'
    )
      throw new Error()
    const info: ResourceInfo = {
        ...descriptor,
        id,
        sha256: v.sha256,
        size: v.size,
        createdAt: v.createdAt,
        integrity: 'notChecked'
      },
      stat = await lstat(join(root, 'resource.bin')),
      after = await lstat(root)
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      stat.nlink !== 1 ||
      (stat.mode & 0o7777) !== 0o600 ||
      stat.size !== info.size ||
      after.ino !== identity.ino ||
      after.dev !== identity.dev
    )
      throw new Error()
    return { root, info, raw, identity }
  }
  async read(
    raw: unknown,
    maxBytes = RESOURCE_BYTE_LIMIT
  ): Promise<{ info: ResourceInfo; bytes: Buffer; revision: string; metadataSHA256: string }> {
    try {
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > RESOURCE_BYTE_LIMIT)
        throw new Error()
      const selected = profileSelection(raw),
        meta = await this.metadata(selected.id)
      if (meta.info.size > maxBytes) throw new Error()
      const bytes = await readBinaryResource(join(meta.root, 'resource.bin'), true, maxBytes),
        after = await this.metadata(selected.id)
      if (
        meta.info.sha256 !== selected.sha256 ||
        resourceHash(bytes) !== selected.sha256 ||
        meta.raw !== after.raw ||
        meta.identity.dev !== after.identity.dev ||
        meta.identity.ino !== after.identity.ino
      )
        throw new Error()
      return {
        info: meta.info,
        bytes,
        revision: profileHash(meta.root + '\0' + meta.raw + '\0' + meta.info.sha256),
        metadataSHA256: profileHash(meta.raw)
      }
    } catch {
      throw new Error('私有资源摘要、权限或元数据未确认，未继续使用。')
    }
  }
  async list(): Promise<ResourceInventory> {
    const result: ResourceInventory = {
      resources: [],
      incomplete: 0,
      warnings: [
        '列表只检查元数据、大小和权限；选择后才读取正文及验证摘要，不代表核心已接受该资源。'
      ]
    }
    if (!(await this.files.directory(this.directory))) return result
    let count = 0
    for await (const entry of await opendir(this.directory)) {
      if (++count > 200) {
        result.warnings.push('列表超过200项，已截断，未删除。')
        break
      }
      try {
        result.resources.push((await this.metadata(entry.name)).info)
      } catch {
        ++result.incomplete
      }
    }
    result.resources.sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id)
    )
    if (result.incomplete)
      result.warnings.push('存在不完整、未知或权限不符条目，保留原文件，不自动修复。')
    return result
  }
}
