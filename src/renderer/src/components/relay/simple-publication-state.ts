import type {
  RelaySimplePublicationState,
  RelaySimplePublicationPreparation,
  RelaySimplePublicationResult
} from '../../../../shared/relay/simple-publication'
import type { RelayProfilePreparation } from '../../../../shared/relay/profiles'
import type { RelaySimpleMetadata } from '../../../../shared/relay/simple'

export const publicationDigest = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v)
const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(v)
const fail = (): never => {
  throw new Error('Unconfirmed publication metadata')
}
function fields(
  raw: unknown,
  required: string[],
  optional: string[] = []
): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    required.some((key) => !Object.hasOwn(raw, key)) ||
    Object.keys(raw).some((key) => ![...required, ...optional].includes(key))
  )
    return fail()
  return raw as Record<string, unknown>
}
function profile(raw: unknown) {
  const value = fields(raw, ['id', 'sha256'])
  if (!uuid(value.id) || !publicationDigest(value.sha256)) return fail()
  return { id: value.id, sha256: value.sha256 }
}
export function readPublicationState(raw: unknown): RelaySimplePublicationState {
  const value = fields(
    raw,
    [
      'initialized',
      'pending',
      'closing',
      'blocking',
      'classification',
      'needsRetirement',
      'markerRevision'
    ],
    ['operationId', 'profile']
  )
  if (
    ['initialized', 'pending', 'closing', 'blocking', 'needsRetirement'].some(
      (key) => typeof value[key] !== 'boolean'
    ) ||
    typeof value.classification !== 'string' ||
    ![
      'none',
      'complete',
      'abandoned',
      'incomplete-known-copy',
      'unknown-profile',
      'uncertain'
    ].includes(value.classification) ||
    !(value.markerRevision === '' || publicationDigest(value.markerRevision)) ||
    (value.operationId !== undefined && !uuid(value.operationId))
  )
    return fail()
  return {
    initialized: value.initialized as boolean,
    pending: value.pending as boolean,
    closing: value.closing as boolean,
    blocking: value.blocking as boolean,
    needsRetirement: value.needsRetirement as boolean,
    classification: value.classification as RelaySimplePublicationState['classification'],
    markerRevision: value.markerRevision as string,
    ...(typeof value.operationId === 'string' ? { operationId: value.operationId } : {}),
    ...(value.profile !== undefined ? { profile: profile(value.profile) } : {})
  }
}
export interface PublicationTicket extends RelaySimplePublicationPreparation {
  expectedRevision: string
  expectedPublishedRevision: number
}
export function readPublicationPreparation(
  raw: unknown,
  info: RelaySimpleMetadata,
  sha: string,
  bytes: number,
  read: (raw: unknown, sha: string, bytes: number) => RelayProfilePreparation
): PublicationTicket {
  const value = fields(raw, ['operationId', 'preparation'])
  if (!uuid(value.operationId)) return fail()
  return {
    operationId: value.operationId,
    preparation: read(value.preparation, sha, bytes),
    expectedRevision: info.revision,
    expectedPublishedRevision: info.publishedRevision
  }
}
export function readPublicationResult(
  raw: unknown,
  operationId: string
): RelaySimplePublicationResult {
  const value = fields(
    raw,
    ['status', 'operationId', 'needsRecovery'],
    ['profile', 'publishedRevision', 'revision']
  )
  if (
    typeof value.status !== 'string' ||
    !['published', 'cancelled', 'failed', 'uncertain', 'abandoned'].includes(value.status) ||
    value.operationId !== operationId ||
    !uuid(value.operationId) ||
    typeof value.needsRecovery !== 'boolean' ||
    (value.publishedRevision !== undefined &&
      (!Number.isSafeInteger(value.publishedRevision) || Number(value.publishedRevision) < 0)) ||
    (value.revision !== undefined && !publicationDigest(value.revision))
  )
    return fail()
  return {
    status: value.status as RelaySimplePublicationResult['status'],
    operationId: value.operationId,
    needsRecovery: value.needsRecovery,
    ...(value.profile !== undefined ? { profile: profile(value.profile) } : {}),
    ...(typeof value.publishedRevision === 'number'
      ? { publishedRevision: value.publishedRevision }
      : {}),
    ...(typeof value.revision === 'string' ? { revision: value.revision } : {})
  }
}
export function verifyPublishedResult(
  result: RelaySimplePublicationResult,
  ticket: PublicationTicket
): void {
  if (
    result.status !== 'published' ||
    result.profile?.sha256 !== ticket.preparation.sha256 ||
    !publicationDigest(result.revision) ||
    result.revision === ticket.expectedRevision ||
    result.publishedRevision !== ticket.expectedPublishedRevision + 1
  )
    return fail()
}
export function publicationStateBlocks(state?: RelaySimplePublicationState): boolean {
  return (
    !!state &&
    (!state.initialized ||
      state.pending ||
      state.closing ||
      state.blocking ||
      state.needsRetirement ||
      ['incomplete-known-copy', 'unknown-profile', 'uncertain'].includes(state.classification))
  )
}
export function mayAbandonPublication(state?: RelaySimplePublicationState): boolean {
  return (
    !!state?.initialized &&
    !state.pending &&
    !state.closing &&
    uuid(state.operationId) &&
    (state.markerRevision === '' || publicationDigest(state.markerRevision)) &&
    state.classification !== 'none' &&
    state.classification !== 'abandoned' &&
    (state.classification !== 'complete' || state.needsRetirement)
  )
}
export function publicationDescription(state: RelaySimplePublicationState): string {
  if (!state.initialized) return '发布状态尚未初始化；请显式只读核对，不会自动恢复。'
  if (state.pending) return '发布事务正在进行；可查看状态，其他写入保持等待。'
  if (state.closing) return '发布事务正在关闭，等待本次处理收尾。'
  switch (state.classification) {
    case 'none':
      return '没有待处理发布意图。准备发布仍需当前已保存草稿的结构预览。'
    case 'complete':
      return state.needsRetirement
        ? '发布已完成，意图尚需显式收尾；不会撤回已保存副本。'
        : '记录显示发布已完成；不会自动选用或启用。'
    case 'abandoned':
      return '意图已明确放弃；全部配置副本和旧历史内容保留。'
    case 'incomplete-known-copy':
      return '存在未完成意图及已知副本。请只读核对，再明确收尾或放弃；不表示回滚。'
    case 'unknown-profile':
      return '副本身份尚未确认，保留现场并阻止新发布。请只读核对，不自动猜测或删除。'
    case 'uncertain':
      return '发布记录或持久化结果不确定，保留现场；请显式只读核对。'
  }
}
