import { constants } from 'fs'
import { lstat, mkdir, open, realpath, rm, type FileHandle } from 'fs/promises'
import { createHash, randomUUID } from 'crypto'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import {
  variantAcquireRequest,
  variantImportRequest,
  variantRecord,
  variantSelection,
  type VariantInventory,
  type VariantRecord
} from '../../../shared/relay/variant'
import { atomicWriteFile } from '../../utils/safeFile'
import { readBinaryResource } from '../resources/source'
import { verifyCoreExecutable, verifyCoreResource } from './resources'
import { trustedCoreVariant } from './trusted-variants'
import { readTrustedSmartModel, trustedSmartModel } from './smart-models'

export interface VariantStoreContext {
  readonly stateRoot: string
}
export type VariantStoreSnapshot = VariantInventory
type Records = Omit<VariantInventory, 'pinnedDefault'>

async function digest(file: FileHandle, expectedSize: number): Promise<string> {
  const hash = createHash('sha256'),
    buffer = Buffer.alloc(65536)
  let offset = 0
  while (true) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
    if (!bytesRead) break
    offset += bytesRead
    if (offset > expectedSize) throw new Error('变体资源超过预期大小。')
    hash.update(buffer.subarray(0, bytesRead))
  }
  if (offset !== expectedSize) throw new Error('变体资源大小不符。')
  return hash.digest('hex')
}
async function checkModel(file: FileHandle, size: number): Promise<void> {
  if (size <= 128) throw new Error('Smart模型文件不完整。')
  const head = Buffer.alloc(64),
    tail = Buffer.alloc(64)
  await file.read(head, 0, head.length, 0)
  await file.read(tail, 0, tail.length, size - tail.length)
  if (
    !head.toString('latin1').startsWith('tree') ||
    !tail.toString('latin1').trimEnd().endsWith('[/target_enhance]')
  )
    throw new Error('Smart模型格式不完整；尚未执行模型加载验证。')
}

export class VariantStore {
  private readonly dir: string
  private readonly recordsPath: string
  private readonly slotDir: string
  constructor(private readonly context: VariantStoreContext) {
    if (
      !isAbsolute(context.stateRoot) ||
      resolve(context.stateRoot) !== context.stateRoot ||
      context.stateRoot.includes('\0')
    )
      throw new Error('变体私有目录无效。')
    this.dir = join(context.stateRoot, 'Variants')
    this.recordsPath = join(this.dir, 'variants.json')
    this.slotDir = join(this.dir, 'variants')
  }
  private async directory(path: string, create: boolean): Promise<boolean> {
    let current = this.context.stateRoot
    for (const part of ['', ...relative(current, path).split('/').filter(Boolean)]) {
      if (part) current = join(current, part)
      try {
        await lstat(current)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (!create) return false
        await mkdir(current, { recursive: current === this.context.stateRoot, mode: 0o700 })
      }
      const info = await lstat(current)
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.mode & 0o022 ||
        info.uid !== process.getuid?.() ||
        (await realpath(current)) !== current
      )
        throw new Error('变体私有目录类型、权限或身份无效。')
    }
    return true
  }
  private async readRecords(): Promise<Records> {
    if (!(await this.directory(this.dir, false)))
      return { records: [], activeCoreId: undefined, activeSmartId: undefined }
    try {
      const file = await open(
        this.recordsPath,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
      )
      try {
        const info = await file.stat()
        if (
          !info.isFile() ||
          info.nlink !== 1 ||
          info.size > 1_048_576 ||
          info.mode & 0o077 ||
          info.uid !== process.getuid?.()
        )
          throw new Error('invalid')
        const parsed: unknown = JSON.parse(await file.readFile('utf8'))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error('invalid')
        const data = parsed as Record<string, unknown>
        if (
          Object.keys(data).some(
            (key) => !['records', 'activeCoreId', 'activeSmartId'].includes(key)
          ) ||
          !Array.isArray(data.records) ||
          data.records.length > 1024
        )
          throw new Error('invalid')
        const records = data.records.map(variantRecord)
        if (new Set(records.map((record) => record.id)).size !== records.length)
          throw new Error('invalid')
        const active = (kind: 'core' | 'smart', field: string): string | undefined => {
          if (data[field] === undefined) return undefined
          const selection = variantSelection({ id: data[field] })
          if (!records.some((record) => record.id === selection.id && record.kind === kind))
            throw new Error('invalid')
          return selection.id
        }
        return {
          records,
          activeCoreId: active('core', 'activeCoreId'),
          activeSmartId: active('smart', 'activeSmartId')
        }
      } finally {
        await file.close()
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { records: [], activeCoreId: undefined, activeSmartId: undefined }
      throw new Error('变体记录读取失败或格式无效。')
    }
  }
  private async writeRecords(data: Records): Promise<void> {
    await this.directory(this.dir, true)
    await atomicWriteFile(this.recordsPath, JSON.stringify(data, null, 2), { mode: 0o600 })
  }
  private root(record: VariantRecord): string {
    return join(this.slotDir, `${record.kind}-${record.id}`)
  }
  private path(record: VariantRecord): string {
    return record.kind === 'core'
      ? join(this.root(record), trustedCoreVariant(record).path)
      : this.root(record)
  }
  async list(): Promise<VariantStoreSnapshot> {
    return { ...(await this.readRecords()), pinnedDefault: true }
  }
  async verify(id: string): Promise<VariantRecord> {
    const selection = variantSelection({ id })
    const record = (await this.readRecords()).records.find((item) => item.id === selection.id)
    if (!record) throw new Error('选择的变体不存在。')
    const path = this.path(record)
    if (!(await this.directory(dirname(path), false))) throw new Error('变体私有副本缺失。')
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await file.stat()
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.uid !== process.getuid?.() ||
        info.mode & 0o077 ||
        info.size !== record.size ||
        (await realpath(path)) !== path
      )
        throw new Error('变体副本类型、权限或大小无效。')
      if ((await digest(file, record.size)) !== record.sha256)
        throw new Error('变体副本摘要已改变。')
      if (record.kind === 'smart') await checkModel(file, record.size)
    } finally {
      await file.close()
    }
    if (record.kind === 'core') {
      await verifyCoreExecutable(path, trustedCoreVariant(record))
      const resource = await verifyCoreResource(this.root(record), record.architecture)
      if (resource.version !== record.version || resource.sha256 !== record.sha256)
        throw new Error('核心私有记录与可信来源回执不一致。')
    }
    return record
  }
  async acquire(raw: unknown): Promise<VariantRecord> {
    const request = variantAcquireRequest(raw)
    if (request.kind === 'core') trustedCoreVariant(request)
    const { sourcePath, ...fields } = request
    const record = variantRecord({ ...fields, id: randomUUID(), acquiredAt: Date.now() })
    const slot = this.root(record),
      target = this.path(record)
    const source = await open(
      sourcePath,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    try {
      const before = await source.stat()
      if (
        !before.isFile() ||
        before.nlink !== 1 ||
        before.size !== request.size ||
        (await realpath(sourcePath)) !== sourcePath
      )
        throw new Error('变体来源必须是未改变的普通文件。')
      if ((await digest(source, request.size)) !== request.sha256)
        throw new Error('变体来源摘要不符。')
      if (request.kind === 'smart') await checkModel(source, request.size)
      await this.directory(dirname(target), true)
      const output = await open(target, 'wx+', request.kind === 'core' ? 0o700 : 0o600)
      try {
        const buffer = Buffer.alloc(65536)
        let offset = 0
        while (offset < before.size) {
          const { bytesRead } = await source.read(
            buffer,
            0,
            Math.min(buffer.length, before.size - offset),
            offset
          )
          if (!bytesRead) throw new Error('复制期间来源变短。')
          await output.writeFile(buffer.subarray(0, bytesRead))
          offset += bytesRead
        }
        await output.sync()
        if ((await digest(output, request.size)) !== request.sha256)
          throw new Error('变体私有副本摘要不符。')
      } finally {
        await output.close()
      }
      const after = await source.stat(),
        linked = await lstat(sourcePath)
      if (
        [after, linked].some(
          (info) =>
            info.dev !== before.dev ||
            info.ino !== before.ino ||
            info.size !== before.size ||
            info.mtimeMs !== before.mtimeMs ||
            info.ctimeMs !== before.ctimeMs
        )
      )
        throw new Error('复制期间变体来源已改变。')
      if (request.kind === 'core') {
        await verifyCoreExecutable(target, trustedCoreVariant(request))
        await atomicWriteFile(
          join(slot, 'relay-core.json'),
          JSON.stringify({
            kind: 'core',
            version: request.version,
            architecture: request.architecture,
            sha256: request.sha256,
            size: request.size
          }),
          { mode: 0o600 }
        )
      }
      const data = await this.readRecords()
      if (data.records.length >= 1024) throw new Error('变体记录数量已达上限。')
      data.records.push(record)
      await this.writeRecords(data)
      return record
    } catch (error) {
      await rm(slot, { recursive: request.kind === 'core', force: true })
      throw error
    } finally {
      await source.close()
    }
  }
  async select(raw: unknown): Promise<VariantRecord> {
    const request = variantSelection(raw),
      record = await this.verify(request.id)
    if (record.kind === 'core' && record.architecture !== process.arch)
      throw new Error('核心架构与当前进程不符。')
    const data = await this.readRecords()
    if (record.kind === 'core') await this.bindSmartModel(record, data)
    if (record.kind === 'core') data.activeCoreId = record.id
    else data.activeSmartId = record.id
    await this.writeRecords(data)
    return record
  }
  private async bindSmartModel(record: VariantRecord, data: Records): Promise<void> {
    if (record.kind !== 'core' || trustedCoreVariant(record).family !== 'smart') return
    const selected = data.records.find(
      (item) => item.id === data.activeSmartId && item.kind === 'smart'
    )
    if (!selected) throw new Error('请先导入并选择固定可信Smart模型；未启用或回退其他核心。')
    const model = await this.verify(selected.id),
      pin = trustedSmartModel(model),
      root = this.root(record),
      receiptPath = join(root, 'relay-model.json')
    const receipt = { kind: 'smart' as const, ...pin }
    let previous: ReturnType<typeof variantImportRequest> | undefined
    try {
      const metadata = JSON.parse(
        (await readBinaryResource(receiptPath, true, 4096)).toString('utf8')
      )
      previous = variantImportRequest(metadata)
      if (previous.kind !== 'smart' || previous.architecture !== undefined)
        throw new Error('模型回执无效。')
      trustedSmartModel(previous)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (
      previous?.version === pin.version &&
      previous.sha256 === pin.sha256 &&
      previous.size === pin.size
    ) {
      await readTrustedSmartModel(join(root, 'Model.bin'), pin)
      return
    }
    const bytes = await readTrustedSmartModel(this.path(model), pin)
    await atomicWriteFile(join(root, 'Model.bin'), bytes, { mode: 0o600 })
    await atomicWriteFile(receiptPath, JSON.stringify(receipt), { mode: 0o600 })
    await readTrustedSmartModel(join(root, 'Model.bin'), pin)
  }
  async restore(kind: 'core' | 'smart'): Promise<void> {
    if (kind !== 'core' && kind !== 'smart') throw new Error('变体恢复类型无效。')
    const data = await this.readRecords()
    if (kind === 'core') data.activeCoreId = undefined
    else data.activeSmartId = undefined
    await this.writeRecords(data)
  }
  async remove(raw: unknown): Promise<void> {
    const { id } = variantSelection(raw),
      data = await this.readRecords()
    const record = data.records.find((item) => item.id === id)
    if (!record) throw new Error('选择的变体不存在。')
    await this.directory(this.slotDir, false)
    await rm(this.root(record), { recursive: record.kind === 'core', force: true })
    data.records = data.records.filter((item) => item.id !== id)
    if (data.activeCoreId === id) data.activeCoreId = undefined
    if (data.activeSmartId === id) data.activeSmartId = undefined
    await this.writeRecords(data)
  }
  async resolveCoreRoot(defaultRoot: string): Promise<string> {
    const data = await this.readRecords()
    if (!data.activeCoreId) return defaultRoot
    const record = await this.verify(data.activeCoreId)
    if (record.kind !== 'core' || record.architecture !== process.arch)
      throw new Error('所选核心与当前架构不符。')
    const root = this.root(record)
    await this.bindSmartModel(record, data)
    await verifyCoreResource(root)
    return root
  }
}
