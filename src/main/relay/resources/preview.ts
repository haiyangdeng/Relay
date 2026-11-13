import {
  RULE_RESOURCE_PREVIEW_INPUT_LIMIT,
  RULE_RESOURCE_PREVIEW_TEXT_LIMIT,
  type RuleResourcePreview
} from '../../../shared/relay/resources'
import { profileSelection } from '../../../shared/relay/runtime'
import type { ResourceValidationJob } from './check-definition'
import type { ResourceStore } from './store'

export type RulePreviewConverter = (
  job: ResourceValidationJob,
  assertCurrent: () => void
) => Promise<{ entries: string[]; sourceRules: number }>

// Read one selected immutable cache, never an original path or active Core file.
// Live root-bound revisions remain the pending operation's CAS, including when
// a portable origin receipt supplied this cache selection.
export async function readRuleResourcePreview(
  cache: Pick<ResourceStore, 'read'>,
  raw: unknown,
  assertCurrent: () => void,
  convertMRS?: RulePreviewConverter
): Promise<RuleResourcePreview> {
  const selection = profileSelection(raw)
  assertCurrent()
  const stored = await cache.read(selection, RULE_RESOURCE_PREVIEW_INPUT_LIMIT)
  assertCurrent()
  const { kind } = stored.info
  if (kind !== 'rule-yaml' && kind !== 'rule-text' && kind !== 'rule-mrs')
    throw new Error('正文预览只接受已选定的规则缓存。')
  let text: string, sourceRules: number | undefined
  if (kind === 'rule-mrs') {
    if (!convertMRS) throw new Error('固定核心转换尚不可用。')
    const { name, behavior, selector } = stored.info,
      bytes = Buffer.from(stored.bytes)
    try {
      assertCurrent()
      const converted = await convertMRS(
        {
          descriptor: { name, kind, behavior, selector },
          bytes,
          sha256: stored.info.sha256
        },
        assertCurrent
      )
      assertCurrent()
      text = converted.entries.join('\n')
      sourceRules = converted.sourceRules
    } finally {
      bytes.fill(0)
    }
  } else {
    if (stored.bytes.length > RULE_RESOURCE_PREVIEW_TEXT_LIMIT)
      throw new Error('文本规则预览超过512KiB。')
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stored.bytes)
  }
  if (Buffer.byteLength(text) > RULE_RESOURCE_PREVIEW_TEXT_LIMIT)
    throw new Error('规则预览超过512KiB。')
  assertCurrent()
  const after = await cache.read(selection, RULE_RESOURCE_PREVIEW_INPUT_LIMIT)
  assertCurrent()
  if (after.revision !== stored.revision) throw new Error('预览期间缓存正文或元数据已变化。')
  return {
    resource: { ...selection },
    kind,
    text,
    language: kind === 'rule-yaml' ? 'yaml' : 'text',
    sourceBytes: stored.bytes.length,
    converted: kind === 'rule-mrs',
    ...(sourceRules === undefined ? {} : { sourceRules })
  }
}
