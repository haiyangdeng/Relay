import { constants } from 'node:fs'
import { lstat, open, realpath, rename, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { KeyedWriteQueue } from '../../utils/safeFile'
import { SubscriptionFiles } from '../subscriptions/private-files'
import type { RelayStateContext } from '../context'
import {
  clone,
  document,
  hash,
  missingRecord,
  saveRequest,
  SIMPLE_DOCUMENT_BYTES,
  boundedJSON,
  keys,
  publicationReceipt,
  revision,
  type SimplePublicationReceipt,
  SimpleFailure,
  type SimpleRecord
} from './model'

const writes = new KeyedWriteQueue()
export class SimpleWriteUncertain extends SimpleFailure {
  constructor() {
    super('uncertain')
  }
}
export interface SimpleFileRecord<T> {
  value: T
  revision: string
  exists: boolean
}

type PrivateDocumentArea = 'core' | 'configuration' | 'app-update' | 'ui-reset' | 'diagnostics'
const privateDocumentNames: Record<PrivateDocumentArea, readonly string[]> = {
  core: ['core-startup.json'],
  configuration: [
    'simple.json',
    'simple-publication.json',
    'ui-preferences.json',
    'system-proxy-defaults.json',
    'local-proxy-plan.json',
    'app-log-preferences.json'
  ],
  'app-update': ['app-update-installation.json'],
  'ui-reset': ['maintenance.json'],
  diagnostics: ['external-verification.json']
}
const privateDocumentDirectories: Record<PrivateDocumentArea, readonly string[]> = {
  core: ['Core'],
  configuration: ['Configuration'],
  'app-update': ['Transactions', 'AppUpdate'],
  'ui-reset': ['Transactions', 'UIReset'],
  diagnostics: ['Diagnostics']
}
// Fixed internal areas, selected only by Main module callers. Runtime journals
// are outside portable Configuration backups; renderer input never chooses one.
export class SimplePrivateDocumentFile<T> {
  readonly path: string
  private readonly files: SubscriptionFiles
  private readonly maxBytes: number
  constructor(
    context: RelayStateContext,
    name:
      | 'core-startup.json'
      | 'simple.json'
      | 'simple-publication.json'
      | 'app-update-installation.json'
      | 'ui-preferences.json'
      | 'system-proxy-defaults.json'
      | 'local-proxy-plan.json'
      | 'app-log-preferences.json'
      | 'maintenance.json'
      | 'external-verification.json',
    private readonly decode: (raw: unknown) => T,
    private readonly missing: () => T,
    area: PrivateDocumentArea = 'configuration'
  ) {
    if (!Object.hasOwn(privateDocumentNames, area) || !privateDocumentNames[area].includes(name))
      throw new SimpleFailure('invalid')
    this.files = new SubscriptionFiles(context)
    this.path = join(context.stateRoot, ...privateDocumentDirectories[area], name)
    this.maxBytes =
      name === 'external-verification.json'
        ? 64 * 1024
        : name === 'simple.json'
          ? SIMPLE_DOCUMENT_BYTES
          : name === 'system-proxy-defaults.json' || name === 'core-startup.json'
            ? 512 * 1024
            : 16 * 1024
  }
  private absent(): SimpleFileRecord<T> {
    return { value: this.missing(), revision: '', exists: false }
  }
  async read(): Promise<SimpleFileRecord<T>> {
    const parent = join(this.path, '..')
    if (!(await this.files.directory(parent))) return this.absent()
    let info: Awaited<ReturnType<typeof lstat>>
    try {
      info = await lstat(this.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.absent()
      throw new SimpleFailure('invalid')
    }
    let file: FileHandle | undefined
    try {
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        info.nlink !== 1 ||
        (info.mode & 0o7777) !== 0o600 ||
        info.size < 1 ||
        info.size > this.maxBytes ||
        (await realpath(this.path)) !== this.path
      )
        throw new SimpleFailure('invalid')
      file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const before = await file.stat()
      if (
        before.dev !== info.dev ||
        before.ino !== info.ino ||
        before.size !== info.size ||
        before.mode !== info.mode ||
        before.uid !== info.uid ||
        before.nlink !== info.nlink ||
        before.mtimeMs !== info.mtimeMs ||
        before.ctimeMs !== info.ctimeMs
      )
        throw new SimpleFailure('stale')
      const bytes = Buffer.alloc(before.size + 1)
      let count = 0
      while (count < bytes.length) {
        const part = await file.read(bytes, count, bytes.length - count, count)
        if (!part.bytesRead) break
        count += part.bytesRead
      }
      const after = await file.stat(),
        linked = await lstat(this.path)
      if (
        count !== before.size ||
        [after, linked].some(
          (value) =>
            value.dev !== before.dev ||
            value.ino !== before.ino ||
            value.size !== before.size ||
            value.mtimeMs !== before.mtimeMs ||
            value.ctimeMs !== before.ctimeMs ||
            value.mode !== before.mode ||
            value.uid !== before.uid ||
            value.nlink !== before.nlink
        )
      )
        throw new SimpleFailure('stale')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count))
      return {
        value: this.decode(JSON.parse(text)),
        revision: createHash('sha256').update(bytes.subarray(0, count)).digest('hex'),
        exists: true
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new SimpleFailure('stale')
      if (error instanceof SimpleFailure) throw error
      throw new SimpleFailure('invalid')
    } finally {
      await file?.close()
    }
  }
  async change(
    expectedRevision: string,
    build: (previous: SimpleFileRecord<T>) => T,
    assertCurrent: () => void,
    recheck?: () => Promise<void>
  ): Promise<SimpleFileRecord<T>> {
    revision(expectedRevision)
    return writes.run(this.path, async () => {
      assertCurrent()
      const previous = await this.read()
      if (previous.revision !== expectedRevision) throw new SimpleFailure('stale')
      const next = this.decode(build(previous))
      const text = JSON.stringify(next, null, 2) + '\n'
      if (Buffer.byteLength(text) > this.maxBytes) throw new SimpleFailure('invalid')
      assertCurrent()
      await this.files.directory(join(this.path, '..'), true)
      const temporary = join(this.path, '..', '.simple-' + randomUUID() + '.tmp')
      let file: FileHandle | undefined,
        renamed = false
      try {
        file = await open(temporary, 'wx', 0o600)
        await file.writeFile(text, 'utf8')
        await file.sync()
        await file.close()
        file = undefined
        if ((await this.read()).revision !== expectedRevision) throw new SimpleFailure('stale')
        await this.files.directory(join(this.path, '..'))
        if (recheck) {
          await recheck()
          if ((await this.read()).revision !== expectedRevision) throw new SimpleFailure('stale')
          await this.files.directory(join(this.path, '..'))
        }
        assertCurrent()
        await rename(temporary, this.path)
        renamed = true
        await this.files.sync(join(this.path, '..'))
        const result = await this.read()
        if (result.revision !== hash(text)) throw new SimpleWriteUncertain()
        return result
      } catch (error) {
        if (renamed) throw new SimpleWriteUncertain()
        throw error
      } finally {
        await file?.close()
        await rm(temporary, { force: true })
      }
    })
  }
}

export function publicationPostimage(record: SimpleRecord, raw: unknown): SimpleRecord {
  const receipt = publicationReceipt(raw)
  if (record.document.state.revision >= Number.MAX_SAFE_INTEGER) throw new SimpleFailure('invalid')
  const next = document({
    ...clone(record.document),
    state: {
      ...clone(record.document.state),
      revision: record.document.state.revision + 1,
      published: clone(record.document.state.draft)
    },
    bindings: {
      ...clone(record.document.bindings),
      published: clone(record.document.bindings.draft)
    },
    configurationRevision: {
      ...clone(record.document.configurationRevision),
      published: record.document.configurationRevision.draft
    },
    publication: receipt
  })
  const text = JSON.stringify(next, null, 2) + '\n'
  if (Buffer.byteLength(text) > SIMPLE_DOCUMENT_BYTES) throw new SimpleFailure('invalid')
  return { document: next, revision: hash(text), exists: true }
}
export class SimpleDraftStore {
  readonly path: string
  private readonly file: SimplePrivateDocumentFile<SimpleRecord['document']>
  constructor(context: RelayStateContext) {
    this.file = new SimplePrivateDocumentFile(
      context,
      'simple.json',
      document,
      () => missingRecord().document
    )
    this.path = this.file.path
  }
  private record(value: SimpleFileRecord<SimpleRecord['document']>): SimpleRecord {
    return { document: value.value, revision: value.revision, exists: value.exists }
  }
  async read(): Promise<SimpleRecord> {
    return this.record(await this.file.read())
  }
  async saveDraft(raw: unknown, assertCurrent: () => void): Promise<SimpleRecord> {
    const request = saveRequest(raw)
    return this.record(
      await this.file.change(
        request.expectedRevision,
        (previous) =>
          document({
            ...clone(previous.value),
            configurationRevision: {
              ...clone(previous.value.configurationRevision),
              draft: request.configurationRevision
            },
            state: { ...clone(previous.value.state), draft: request.draft },
            bindings: { ...clone(previous.value.bindings), draft: request.bindings }
          }),
        assertCurrent
      )
    )
  }
  async promotePublished(
    raw: unknown,
    recheck: () => Promise<void>,
    assertCurrent: () => void
  ): Promise<SimpleRecord> {
    boundedJSON(raw)
    keys(raw, ['expectedRevision', 'receipt'])
    revision(raw.expectedRevision)
    const receipt: SimplePublicationReceipt = publicationReceipt(raw.receipt)
    return this.record(
      await this.file.change(
        raw.expectedRevision,
        (previous) => publicationPostimage(this.record(previous), receipt).document,
        assertCurrent,
        recheck
      )
    )
  }
}
