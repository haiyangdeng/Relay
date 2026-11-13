import { tunDigest } from '../../../shared/relay/tun'
import type { CoreExecutionReceiptV2 } from '../configuration/core-snapshot-prototype'
import { validateBoundConfiguration } from '../configuration/checker'
import type { RuntimeAsset } from '../configuration/bindings'
import { resourceHash } from '../resources/source'
import { inspectRuntimeConfiguration } from '../configuration/schema'
import { plainConfigurationMap as object } from '../profiles/document'
import {
  smartStateDigest,
  smartStateSchema,
  type SmartStateSeedV1
} from '../core/smart-state-schema'
import { compiledExecutionCoreV2 } from './execution-installation'
import { parseTunHostFrame } from './wire-json'

export interface CheckedTunExecutionV2 {
  readonly receipt: CoreExecutionReceiptV2
  readonly raw: string
  readonly sha256: string
  readonly stateSeed?: SmartStateSeedV1
}
const invalid = (): Error => new Error('TUN核心执行快照、正文或原始回执摘要不匹配。')

export function smartStateCollectsCSV(source: string): boolean {
  const parsed = inspectRuntimeConfiguration(source).configuration
  if (!parsed) throw invalid()
  const groups = parsed['proxy-groups']
  return (
    Array.isArray(groups) &&
    groups.some(
      (group: unknown) => object(group) && group.type === 'smart' && group.collectdata === true
    )
  )
}

export function validateSmartStateSeedMetadata(
  seed: unknown,
  collectCSV: boolean
): asserts seed is SmartStateSeedV1 {
  if (
    !object(seed) ||
    Object.keys(seed).sort().join(',') !== 'files,key,previousRevision,version' ||
    seed.version !== 1 ||
    !tunDigest(seed.key) ||
    (seed.previousRevision !== null && !tunDigest(seed.previousRevision)) ||
    !Array.isArray(seed.files) ||
    seed.files.length !== (collectCSV ? 2 : 1)
  )
    throw invalid()
  const names = new Set<string>()
  let total = 0
  for (const file of seed.files) {
    if (
      !object(file) ||
      Object.keys(file).sort().join(',') !== 'path,sha256,size' ||
      (file.path !== 'cache.db' && file.path !== 'smart_weight_data.csv') ||
      names.has(file.path) ||
      !tunDigest(file.sha256) ||
      typeof file.size !== 'number' ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > smartStateSchema.fileByteLimit ||
      (file.path === 'smart_weight_data.csv' && file.size < smartStateSchema.csvHeaderBytes) ||
      (file.size === 0 && file.sha256 !== smartStateDigest(Buffer.alloc(0)))
    )
      throw invalid()
    names.add(file.path)
    total += file.size
  }
  if (
    !names.has('cache.db') ||
    names.has('smart_weight_data.csv') !== collectCSV ||
    total > smartStateSchema.totalByteLimit
  )
    throw invalid()
}

// Encode before preparation: its exact digest participates in evidenceSHA256
// and therefore in the automatic utun device name. Staging copies these bytes.
export function encodeCheckedTunExecutionV2(
  receipt: CoreExecutionReceiptV2,
  stateSeed?: SmartStateSeedV1
): CheckedTunExecutionV2 {
  const raw = JSON.stringify({
    version: 2,
    kind: 'relay-core-execution',
    checked: receipt,
    ...(stateSeed !== undefined ? { stateSeed } : {})
  })
  if (Buffer.byteLength(raw) > 262144) throw invalid()
  return Object.freeze({
    receipt: structuredClone(receipt),
    ...(stateSeed !== undefined ? { stateSeed: structuredClone(stateSeed) } : {}),
    raw,
    sha256: resourceHash(Buffer.from(raw))
  })
}

export function validateCheckedTunExecutionV2(
  execution: CheckedTunExecutionV2,
  configuration: string,
  assets: readonly RuntimeAsset[],
  expectedCoreSHA256: string,
  now: number
): void {
  if (
    !execution ||
    typeof execution.raw !== 'string' ||
    Buffer.byteLength(execution.raw) > 262144 ||
    execution.sha256 !== resourceHash(Buffer.from(execution.raw)) ||
    !Number.isSafeInteger(now) ||
    now < 0
  )
    throw invalid()
  const envelope = parseTunHostFrame(Buffer.from(execution.raw), 262144)
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    Array.isArray(envelope) ||
    Object.keys(envelope).sort().join(',') !==
      (execution.stateSeed !== undefined
        ? 'checked,kind,stateSeed,version'
        : 'checked,kind,version') ||
    !('version' in envelope) ||
    envelope.version !== 2 ||
    !('kind' in envelope) ||
    envelope.kind !== 'relay-core-execution' ||
    !('checked' in envelope) ||
    JSON.stringify(envelope.checked) !== JSON.stringify(execution.receipt)
  )
    throw invalid()
  if (execution.stateSeed !== undefined) {
    if (
      execution.receipt.profile !== 'smart' ||
      !('stateSeed' in envelope) ||
      JSON.stringify(envelope.stateSeed) !== JSON.stringify(execution.stateSeed)
    )
      throw invalid()
    validateSmartStateSeedMetadata(execution.stateSeed, smartStateCollectsCSV(configuration))
  }
  const receipt = execution.receipt,
    core = compiledExecutionCoreV2(receipt.profile, receipt.architecture)
  if (
    receipt.version !== 2 ||
    !tunDigest(receipt.selectionSHA256) ||
    !tunDigest(receipt.snapshotSHA256) ||
    core.sha256 !== expectedCoreSHA256 ||
    receipt.core.sha256 !== core.sha256 ||
    receipt.core.version !== core.version ||
    receipt.core.size !== core.size ||
    !Number.isSafeInteger(receipt.expiresAt) ||
    receipt.expiresAt <= now ||
    receipt.expiresAt > now + 60000
  )
    throw invalid()
  validateBoundConfiguration(configuration, assets, receipt)
}
