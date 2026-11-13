import {
  tunRuleProviderName,
  type TunRuleProviderEntry
} from '../../../shared/relay/tun-rule-providers'
import { createTunAssetChannel, type TunAssetIO, type TunAssetIdentity } from './asset-channel'
import { isTunRuleProviderBlobKind, tunRuleProviderBlobTicket } from './rule-provider-ticket'
import type {
  TunRuleProvidersChannel,
  TunRuleProvidersMutation,
  TunRuleProvidersNativeSnapshot
} from './rule-providers-contract'

export type {
  TunRuleProvidersChannel,
  TunRuleProvidersChannelResult,
  TunRuleProvidersMutation,
  TunRuleProvidersNativeSnapshot
} from './rule-providers-contract'
export interface TunRuleProvidersIO extends TunAssetIO {
  // Only provider FD9/10 are closed; control and the older capabilities remain held.
  close(): void
}
export const tunRuleProvidersFrameByteLimit = 262144 // 256KiB, independent of the old 8KiB Geo frames.

const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value),
  keys = (value: Record<string, unknown>, fields: string): boolean =>
    Object.keys(value).sort().join(',') === fields.split(',').sort().join(','),
  hash = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value),
  integer = (value: unknown, min: number, max: number): value is number =>
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max

function mutation(raw: unknown): TunRuleProvidersMutation {
  if (
    !object(raw) ||
    !keys(
      raw,
      'configurationRevision,expectedGenerationSHA256,provider,oldSHA256,newSHA256,blobId,kind,bytes,filename,declaredRuleCount'
    ) ||
    !hash(raw.configurationRevision) ||
    !hash(raw.expectedGenerationSHA256) ||
    !hash(raw.oldSHA256) ||
    !hash(raw.newSHA256) ||
    !integer(raw.declaredRuleCount, 1, 2_000_000)
  )
    throw new Error('规则提供者替换范围无效。')
  const ticket = tunRuleProviderBlobTicket({
    blobId: raw.blobId,
    kind: raw.kind,
    sha256: raw.newSHA256,
    bytes: raw.bytes,
    filename: raw.filename
  })
  return {
    configurationRevision: raw.configurationRevision,
    expectedGenerationSHA256: raw.expectedGenerationSHA256,
    provider: tunRuleProviderName(raw.provider),
    oldSHA256: raw.oldSHA256,
    newSHA256: ticket.sha256,
    blobId: ticket.blobId,
    kind: ticket.kind,
    bytes: ticket.bytes,
    filename: ticket.filename,
    declaredRuleCount: raw.declaredRuleCount
  }
}

function snapshot(raw: unknown): TunRuleProvidersNativeSnapshot {
  if (
    !object(raw) ||
    !keys(raw, 'configurationRevision,generationSHA256,providers,groups') ||
    !hash(raw.configurationRevision) ||
    !hash(raw.generationSHA256) ||
    !Array.isArray(raw.providers) ||
    raw.providers.length > 200 ||
    !Array.isArray(raw.groups) ||
    raw.groups.length > 200
  )
    throw new Error('规则提供者活动代际无效。')
  const entries = new Map<string, TunRuleProviderEntry>()
  for (const value of raw.providers) {
    if (
      !object(value) ||
      !keys(value, 'name,kind,behavior,fileSHA256,bytes,ruleCount') ||
      !isTunRuleProviderBlobKind(value.kind) ||
      typeof value.behavior !== 'string' ||
      !['domain', 'ipcidr', 'classical'].includes(value.behavior) ||
      !hash(value.fileSHA256) ||
      !integer(value.bytes, 1, 128 * 1024 * 1024) ||
      !integer(value.ruleCount, 0, Number.MAX_SAFE_INTEGER)
    )
      throw new Error('规则提供者活动条目无效。')
    const name = tunRuleProviderName(value.name)
    if (entries.has(name)) throw new Error('规则提供者名称重复。')
    entries.set(name, {
      name,
      kind: value.kind,
      behavior: value.behavior as TunRuleProviderEntry['behavior'],
      fileSHA256: value.fileSHA256,
      bytes: value.bytes,
      ruleCount: value.ruleCount
    })
  }
  const groups: string[][] = [],
    seen = new Set<string>()
  let bytes = 0
  for (const value of raw.groups) {
    if (!Array.isArray(value) || !value.length || value.length > 200)
      throw new Error('规则提供者关联分组无效。')
    const group: string[] = []
    let first: TunRuleProviderEntry | undefined
    for (const name of value) {
      const valid = tunRuleProviderName(name),
        entry = entries.get(valid)
      if (!entry || seen.has(valid)) throw new Error('规则提供者关联分组不是完整分区。')
      if (
        first &&
        (entry.kind !== first.kind ||
          entry.fileSHA256 !== first.fileSHA256 ||
          entry.bytes !== first.bytes)
      )
        throw new Error('规则提供者关联文件不一致。')
      first ??= entry
      seen.add(valid)
      group.push(valid)
    }
    bytes += first?.bytes ?? 0
    if (bytes > 256 * 1024 * 1024) throw new Error('规则提供者活动正文超过预算。')
    groups.push(group)
  }
  if (seen.size !== entries.size) throw new Error('规则提供者关联分组不是完整分区。')
  // Both generations and file digests come from Native, never JS JSON re-hashing.
  return {
    configurationRevision: raw.configurationRevision,
    generationSHA256: raw.generationSHA256,
    providers: [...entries.values()],
    groups
  }
}

export function createTunRuleProvidersChannel(
  io: TunRuleProvidersIO,
  identity: TunAssetIdentity,
  timeout = 30000
): TunRuleProvidersChannel {
  return createTunAssetChannel(
    io,
    identity,
    {
      capability: 'runtime-rule-providers-v1',
      frameByteLimit: tunRuleProvidersFrameByteLimit,
      label: '规则提供者',
      mutation,
      ticket: tunRuleProviderBlobTicket,
      snapshot,
      verifyCommit(reply, selected, status) {
        const current = reply.providers.find((entry) => entry.name === selected.provider),
          group = reply.groups.find((names) => names.includes(selected.provider))
        if (
          reply.configurationRevision !== selected.configurationRevision ||
          !current ||
          !group ||
          current.kind !== selected.kind ||
          group.some((name) => {
            const entry = reply.providers.find((row) => row.name === name)
            return (
              !entry ||
              entry.fileSHA256 !== selected.newSHA256 ||
              entry.bytes !== selected.bytes ||
              entry.kind !== selected.kind ||
              entry.ruleCount !== selected.declaredRuleCount
            )
          }) ||
          (status === 'updated' &&
            (selected.oldSHA256 === selected.newSHA256 ||
              reply.generationSHA256 === selected.expectedGenerationSHA256)) ||
          (status === 'unchanged' &&
            (selected.oldSHA256 !== selected.newSHA256 ||
              reply.generationSHA256 !== selected.expectedGenerationSHA256))
        )
          throw new Error('规则提供者文件发布回执范围不匹配。')
      }
    },
    timeout
  )
}
