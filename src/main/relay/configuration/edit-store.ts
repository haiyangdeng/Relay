// Private, atomic persistence for the configuration edit document. The edit
// document feeds the complete-configuration merge (batch 26); storing it in
// Relay's own directory keeps overrides / rule patches / sniffer / DNS edits
// independent of the imported profile source and the current Clash config.
import { mkdir, readFile, unlink } from 'fs/promises'
import { join } from 'path'
import { createHash } from 'crypto'
import {
  configurationEditDocument,
  defaultEditDocument,
  inheritProfileEdits,
  configurationEditRevision,
  type ConfigurationEditDocument,
  type ConfigurationEditRecord
} from '../../../shared/relay/configuration-edit'
import { atomicWriteFile, KeyedWriteQueue } from '../../utils/safeFile'

const FILE = 'configuration-edit.json'
const writes = new KeyedWriteQueue()

export interface ConfigurationEditStoreContext {
  readonly stateRoot: string
}
export type { ConfigurationEditRecord } from '../../../shared/relay/configuration-edit'

export class ConfigurationEditStore {
  private readonly path: string
  constructor(context: ConfigurationEditStoreContext) {
    this.path = join(context.stateRoot, 'Configuration', FILE)
  }
  async read(): Promise<ConfigurationEditRecord> {
    try {
      const buffer = await readFile(this.path)
      const text = buffer.toString('utf8')
      const parsed: unknown = JSON.parse(text)
      const document = configurationEditDocument(parsed)
      return {
        document,
        revision: createHash('sha256').update(text).digest('hex'),
        exists: true
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { document: defaultEditDocument(), revision: '', exists: false }
      throw new Error('配置编辑文档读取失败或格式无效。')
    }
  }
  private async write(document: ConfigurationEditDocument): Promise<ConfigurationEditRecord> {
    document = configurationEditDocument(document)
    await mkdir(join(this.path, '..'), { recursive: true, mode: 0o700 })
    const text = JSON.stringify(document, null, 2)
    if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('配置编辑文档过大。')
    await atomicWriteFile(this.path, text, { mode: 0o600 })
    const revision = createHash('sha256').update(text).digest('hex')
    return { document, revision, exists: true }
  }
  private async assertRevision(expectedRevision?: string): Promise<void> {
    if (expectedRevision === undefined) return
    configurationEditRevision(expectedRevision)
    if ((await this.read()).revision !== expectedRevision)
      throw new Error('编辑版本已变化，请重新读取；未覆盖当前编辑。')
  }
  async save(
    document: ConfigurationEditDocument,
    expectedRevision?: string
  ): Promise<ConfigurationEditRecord> {
    const checked = configurationEditDocument(document)
    return writes.run(this.path, async () => {
      await this.assertRevision(expectedRevision)
      return this.write(checked)
    })
  }
  async inherit(
    previousId: string,
    targetId: string,
    validate?: (document: ConfigurationEditDocument) => Promise<void>
  ): Promise<ConfigurationEditRecord> {
    return writes.run(this.path, async () => {
      const current = await this.read(),
        document = inheritProfileEdits(current.document, previousId, targetId)
      if (JSON.stringify(document) === JSON.stringify(current.document)) return current
      await validate?.(structuredClone(document))
      return this.write(document)
    })
  }
  async clear(expectedRevision?: string): Promise<void> {
    return writes.run(this.path, async () => {
      await this.assertRevision(expectedRevision)
      try {
        await unlink(this.path)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    })
  }
}
