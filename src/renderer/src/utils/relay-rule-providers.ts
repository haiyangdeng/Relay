import { parseDocument } from 'yaml'
import type { RuleProviderDraftChange } from '../components/resources/rule-provider-editor-modal'

export function providerDefinitions(text: string): Record<string, Record<string, unknown>> {
  if (new TextEncoder().encode(text).length > 512 * 1024) throw new Error('提供者草稿过大')
  const parsed: unknown = JSON.parse(text, (_key, value: unknown) => {
    if (
      typeof value === 'number' &&
      (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
    )
      throw new Error('提供者数值无法无损表示')
    return value
  })
  // Reuse DNS editor's strict JSON syntax plus mature decoded-key duplicate check.
  const document = parseDocument(text, { schema: 'json', uniqueKeys: true })
  const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value)
  if (
    document.errors.length ||
    !object(parsed) ||
    Object.keys(parsed).length > 200 ||
    !Object.values(parsed).every(object)
  )
    throw new Error('提供者JSON不是完整定义对象')
  return parsed as Record<string, Record<string, unknown>>
}

export function providerDraftChange(text: string, change: RuleProviderDraftChange): string {
  const definitions = providerDefinitions(text),
    name = change.name.trim()
  if (!name || (name !== change.oldName && Object.hasOwn(definitions, name)))
    throw new Error('名称为空或已存在')
  if (
    change.oldName !== undefined &&
    (!Object.hasOwn(definitions, change.oldName) ||
      JSON.stringify(definitions[change.oldName]) !== JSON.stringify(change.expected))
  )
    throw new Error('提供者草稿已变化，请重新打开')
  const entries = Object.entries(definitions).map(([key, value]) =>
    key === change.oldName ? [name, structuredClone(change.value)] : [key, value]
  )
  if (change.oldName === undefined) entries.push([name, structuredClone(change.value)])
  return JSON.stringify(Object.fromEntries(entries), null, 2)
}

export function providerDraftRemove(text: string, name: string): string {
  const definitions = providerDefinitions(text)
  if (!Object.hasOwn(definitions, name)) throw new Error('提供者已不存在')
  return JSON.stringify(
    Object.fromEntries(Object.entries(definitions).filter(([key]) => key !== name)),
    null,
    2
  )
}
