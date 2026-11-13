import { isDeepStrictEqual } from 'node:util'
import { parseDocument } from 'yaml'
import type { SimpleDraft, SimpleObject } from '../../../shared/simple-config'
import {
  getSimpleNodeType,
  listSimpleNodeFields,
  pruneSimpleNode,
  readSimpleNodeValue,
  writeSimpleNodeValue,
  type SimpleNodeField
} from '../../../shared/simple-node/index'
import { stripProfileControls } from '../../../shared/relay/profiles'
import { readSimpleNodes, updateSimpleNode } from '../../simple/nodes'
import { normalizeShortIds } from '../../utils/yaml'
import {
  boundedJSON,
  clone,
  keys,
  object,
  revision,
  SIMPLE_MODULE_BYTES,
  SimpleFailure
} from './model'

interface NodeUpdateRequest {
  expectedRevision: string
  action: { kind: 'node.update'; name: string; value: SimpleObject }
}
const invalid = (): never => {
  throw new SimpleFailure('invalid')
}
const identity = (value: unknown): value is string =>
  typeof value === 'string' &&
  !!value &&
  value === value.trim() &&
  value.length <= 256 &&
  stripProfileControls(value) === value

export function nodeUpdateRequest(raw: unknown): NodeUpdateRequest {
  boundedJSON(raw)
  keys(raw, ['expectedRevision', 'action'])
  revision(raw.expectedRevision)
  keys(raw.action, ['kind', 'name', 'value'])
  if (raw.action.kind !== 'node.update' || !identity(raw.action.name) || !object(raw.action.value))
    return invalid()
  return {
    expectedRevision: raw.expectedRevision,
    action: { kind: 'node.update', name: raw.action.name, value: clone(raw.action.value) }
  }
}

// Main/private only: this detached array can contain credentials. It is not a
// PublicView, IPC DTO, source-derived node list or automatic compiler preview.
export function readNodeDraft(draft: SimpleDraft): SimpleObject[] {
  try {
    if (
      typeof draft.modules.proxies !== 'string' ||
      Buffer.byteLength(draft.modules.proxies) > SIMPLE_MODULE_BYTES
    )
      return invalid()
    // Legacy parse can emit YAML warnings. Reject the same input silently
    // before calling it, so tags/diagnostics cannot copy a source credential.
    const parsed = parseDocument(normalizeShortIds(draft.modules.proxies), {
      merge: true,
      uniqueKeys: true,
      logLevel: 'silent'
    })
    if (parsed.errors.length || parsed.warnings.length) return invalid()
    const nodes = readSimpleNodes(draft)
    boundedJSON(nodes, SIMPLE_MODULE_BYTES)
    return clone(nodes)
  } catch {
    return invalid()
  }
}

function checkedNode(node: SimpleObject): Map<string, SimpleNodeField> {
  boundedJSON(node, SIMPLE_MODULE_BYTES)
  if (!identity(node.name) || typeof node.type !== 'string' || !getSimpleNodeType(node.type))
    return invalid()
  // Upstream prune removes empty optional values recursively; unknown nonempty
  // keys can survive it. Check both effects separately, on held and new data.
  if (!isDeepStrictEqual(pruneSimpleNode(clone(node), node.type), node)) return invalid()
  const fields = new Map(
    listSimpleNodeFields(node.type)
      .filter((entry) => !entry.path.includes('.'))
      .map((entry) => [entry.path, entry.field] as const)
  )
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type') continue
    const field = fields.get(key)
    if (!field) return invalid()
    if (['text', 'password', 'select'].includes(field.kind) && typeof value !== 'string')
      return invalid()
    if (field.kind === 'bool' && typeof value !== 'boolean') return invalid()
    if (
      field.kind === 'number' &&
      !(
        (typeof value === 'number' || (typeof value === 'string' && !!value.trim())) &&
        Number.isFinite(Number(value))
      )
    )
      return invalid()
    if (field.kind === 'list' && !Array.isArray(value)) return invalid()
    if (['map', 'object'].includes(field.kind) && !object(value)) return invalid()
  }
  return fields
}

export function sameNameNodeUpdate(draft: SimpleDraft, request: NodeUpdateRequest): SimpleDraft {
  try {
    const before = readNodeDraft(draft),
      matches = before.filter((node) => node.name === request.action.name)
    if (matches.length !== 1) return invalid()
    const held = matches[0],
      value = request.action.value,
      fields = checkedNode(held)
    checkedNode(value)
    if (value.name !== held.name || value.type !== held.type) return invalid()
    // No field deletion/empty-value clearing in this first slice. A full-object
    // UI payload cannot silently omit old credentials or advanced fields.
    for (const key of Object.keys(held)) if (!Object.hasOwn(value, key)) return invalid()
    const expected = clone(value),
      frozen = new Set<string>(['dialer-proxy'])
    for (const [key, field] of fields)
      if (field.hidden || ['map', 'object', 'list'].includes(field.kind)) frozen.add(key)
    for (const key of frozen)
      if (
        Object.hasOwn(held, key) !== Object.hasOwn(value, key) ||
        !isDeepStrictEqual(held[key], value[key])
      )
        return invalid()
    // Preserve precisely the mature numeric-string normalization. Any other
    // normalizer change (including inside a frozen container) is rejected.
    let normalized = expected
    for (const entry of listSimpleNodeFields(String(value.type))) {
      const current = readSimpleNodeValue(value, entry.path)
      if (entry.field.kind === 'number' && typeof current === 'string')
        normalized = writeSimpleNodeValue(normalized, entry.path, Number(current))
    }
    const next = updateSimpleNode(clone(draft), request.action.name, clone(value), held),
      after = readNodeDraft(next),
      index = before.findIndex((node) => node.name === request.action.name)
    if (after.length !== before.length || !isDeepStrictEqual(after[index], normalized))
      return invalid()
    for (let i = 0; i < before.length; i++)
      if (i !== index && !isDeepStrictEqual(after[i], before[i])) return invalid()
    for (const key of frozen) if (!isDeepStrictEqual(after[index][key], held[key])) return invalid()
    for (const [key, text] of Object.entries(draft.modules))
      if (key !== 'proxies' && next.modules[key as keyof SimpleDraft['modules']] !== text)
        return invalid()
    if (
      !isDeepStrictEqual(next.sources, draft.sources) ||
      !isDeepStrictEqual(next.preserved, draft.preserved) ||
      !isDeepStrictEqual(next.moduleOrder, draft.moduleOrder)
    )
      return invalid()
    return next
  } catch {
    // Legacy parsers/normalizers include names, field values or YAML source in
    // their diagnostics. Keep them out of this future service response.
    return invalid()
  }
}
