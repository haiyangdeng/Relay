import { profileSelection } from '../../../shared/relay/runtime'
import type { TunRuleProviderEntry } from '../../../shared/relay/tun-rule-providers'
import { checkResourceJob, type ResourceValidationJob } from './check-definition'
import { resourceHash } from './source'
import type { ResourceStore } from './store'

export interface RuleProviderResourceCandidate {
  job: ResourceValidationJob
  revision: string
  recheck(): Promise<void>
}

// Candidate bytes and metadata belong to an immutable private cache, not the
// mutable runtime file. Actual Core acceptance and publish authority are later
// held-owner operations; this helper grants neither of them.
export async function readRuleProviderCandidate(
  cache: Pick<ResourceStore, 'read'>,
  raw: unknown,
  expected: Pick<TunRuleProviderEntry, 'kind' | 'behavior'>
): Promise<RuleProviderResourceCandidate> {
  const selected = profileSelection(raw),
    target = { kind: expected.kind, behavior: expected.behavior },
    first = await cache.read(selected),
    { name, kind, behavior, selector } = first.info
  if (kind !== target.kind || behavior !== target.behavior)
    throw new Error('规则缓存格式或行为与当前提供者不一致。')
  const job: ResourceValidationJob = {
    descriptor: { name, kind, behavior, selector },
    bytes: Buffer.from(first.bytes),
    sha256: first.info.sha256
  }
  checkResourceJob(job)
  const revision = first.revision,
    descriptor = JSON.stringify(job.descriptor)
  const recheck = async (): Promise<void> => {
    checkResourceJob(job)
    if (
      resourceHash(job.bytes) !== selected.sha256 ||
      JSON.stringify(job.descriptor) !== descriptor
    )
      throw new Error('规则候选正文或描述已变化。')
    const current = await cache.read(selected)
    if (
      current.revision !== revision ||
      current.info.kind !== target.kind ||
      current.info.behavior !== target.behavior
    )
      throw new Error('规则候选缓存或元数据已变化。')
    checkResourceJob(job)
    if (
      resourceHash(job.bytes) !== selected.sha256 ||
      JSON.stringify(job.descriptor) !== descriptor
    )
      throw new Error('规则候选正文或描述已变化。')
  }
  await recheck()
  return Object.freeze({ job, revision, recheck })
}
