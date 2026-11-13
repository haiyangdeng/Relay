// Main-private spool identity only. Provider names, paths and authorization are
// bound separately by the held runtime operation, never by this blob ticket.
export type TunRuleProviderBlobKind = 'rule-yaml' | 'rule-text' | 'rule-mrs'
export interface TunRuleProviderBlobTicket {
  blobId: string
  kind: TunRuleProviderBlobKind
  sha256: string
  bytes: number
  filename: string
}
export function isTunRuleProviderBlobKind(value: unknown): value is TunRuleProviderBlobKind {
  return value === 'rule-yaml' || value === 'rule-text' || value === 'rule-mrs'
}
export function tunRuleProviderBlobTicket(raw: unknown): TunRuleProviderBlobTicket {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.getPrototypeOf(raw) !== Object.prototype
  )
    throw new Error('规则提供者暂存票据无效。')
  const value = raw as Record<string, unknown>
  if (
    Object.keys(value).sort().join(',') !== 'blobId,bytes,filename,kind,sha256' ||
    typeof value.blobId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value.blobId) ||
    !isTunRuleProviderBlobKind(value.kind) ||
    typeof value.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(value.sha256) ||
    typeof value.bytes !== 'number' ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 1 ||
    value.bytes > (value.kind === 'rule-mrs' ? 128 : 8) * 1024 * 1024 ||
    typeof value.filename !== 'string' ||
    value.filename !== `${value.blobId}.${value.kind.slice(5)}`
  )
    throw new Error('规则提供者暂存票据无效。')
  return {
    blobId: value.blobId,
    kind: value.kind,
    sha256: value.sha256,
    bytes: value.bytes,
    filename: value.filename
  }
}
