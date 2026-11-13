import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, open, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { getHeapSnapshot } from 'node:v8'
import { SimplePrivateDocumentFile } from '../simple/store'
import { SubscriptionFiles } from '../subscriptions/private-files'
import { readAppUpdateFile } from '../updates/app/store'
import type { RelayStateContext } from '../context'
import {
  maintenanceID,
  maintenanceReset,
  type RelayMaintenanceReset,
  type RelayHeapExport
} from '../../../shared/relay/maintenance'
import { uiPreferences, type RelayUIPreferences } from '../../../shared/relay/ui-preferences'
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
export class RelayMaintenanceStore {
  readonly files: SubscriptionFiles
  readonly root: string
  readonly heapRoot: string
  readonly journal: SimplePrivateDocumentFile<RelayMaintenanceReset | null>
  constructor(context: RelayStateContext) {
    this.files = new SubscriptionFiles(context)
    this.root = join(context.stateRoot, 'Maintenance', 'UI-Reset')
    this.heapRoot = join(context.stateRoot, 'Diagnostics', 'Heap')
    this.journal = new SimplePrivateDocumentFile(
      context,
      'maintenance.json',
      maintenanceReset,
      () => null,
      'ui-reset'
    )
  }
  async backup(
    value: RelayUIPreferences,
    assertCurrent: () => void
  ): Promise<{ id: string; sha256: string }> {
    assertCurrent()
    await this.files.directory(this.root, true)
    assertCurrent()
    const id = randomUUID(),
      directory = join(this.root, id)
    await this.files.directory(directory, true)
    assertCurrent()
    const bytes = Buffer.from(JSON.stringify(uiPreferences(value), null, 2) + '\n')
    await this.files.write(join(directory, 'before.json'), bytes.toString('utf8'))
    await this.files.sync(directory)
    assertCurrent()
    return { id, sha256: hash(bytes) }
  }
  async restoreValue(record: RelayMaintenanceReset): Promise<RelayUIPreferences> {
    maintenanceID(record.id)
    const path = join(this.root, record.id, 'before.json')
    await this.files.directory(join(path, '..'))
    const bytes = await readAppUpdateFile(path, 16384)
    if (hash(bytes) !== record.beforeSHA256) throw new Error('原偏好备份已变化。')
    return uiPreferences(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
      'stored'
    )
  }
  async exportHeap(assertCurrent: () => void, signal: AbortSignal): Promise<RelayHeapExport> {
    assertCurrent()
    await this.files.directory(this.heapRoot, true)
    assertCurrent()
    const id = randomUUID(),
      temporary = join(this.heapRoot, '.heap-' + id + '.tmp'),
      fileName = 'Relay-main-' + id + '.heapsnapshot',
      destination = join(this.heapRoot, fileName),
      file = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      ),
      identity = await file.stat()
    let closed = false,
      published = false
    let failure: unknown, result: RelayHeapExport | undefined
    try {
      assertCurrent()
      const snapshot = getHeapSnapshot({ exposeInternals: false, exposeNumericValues: false }),
        digest = createHash('sha256')
      let bytes = 0
      const abort = () => snapshot.destroy(new Error('堆快照导出已取消。'))
      signal.addEventListener('abort', abort, { once: true })
      try {
        if (signal.aborted) abort()
        for await (const raw of snapshot) {
          assertCurrent()
          if (signal.aborted) throw new Error('堆快照导出已取消。')
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
          bytes += chunk.length
          if (bytes > 1024 * 1024 * 1024) throw new Error('堆快照超过1GiB上限。')
          digest.update(chunk)
          let offset = 0
          while (offset < chunk.length) {
            const out = await file.write(chunk, offset, chunk.length - offset)
            if (!out.bytesWritten) throw new Error('堆快照写入未确认。')
            offset += out.bytesWritten
            assertCurrent()
          }
        }
      } finally {
        signal.removeEventListener('abort', abort)
        snapshot.destroy()
      }
      await file.sync()
      await file.close()
      closed = true
      assertCurrent()
      const current = await lstat(temporary)
      if (
        current.dev !== identity.dev ||
        current.ino !== identity.ino ||
        current.nlink !== 1 ||
        !current.isFile() ||
        current.isSymbolicLink()
      )
        throw new Error('堆快照文件归属变化。')
      await this.files.directory(this.heapRoot)
      assertCurrent()
      await link(temporary, destination)
      await unlink(temporary)
      published = true
      await this.files.sync(this.heapRoot)
      result = { id, fileName, bytes, sha256: digest.digest('hex'), containsSecrets: true }
    } catch (error) {
      failure = error
    } finally {
      if (!closed) {
        try {
          await file.close()
        } catch (error) {
          failure ??= error
        }
      }
      if (!published) {
        try {
          const current = await lstat(temporary)
          if (
            current.dev === identity.dev &&
            current.ino === identity.ino &&
            current.isFile() &&
            !current.isSymbolicLink()
          )
            await unlink(temporary)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') failure ??= error
        }
      }
    }
    if (failure) throw failure
    if (!result) throw new Error('堆快照导出结果未确认。')
    return result
  }
}
