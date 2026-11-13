export const APP_UPDATE_IPC_CHANNELS = [
  'relayAppUpdateState',
  'relayAppUpdateCheck',
  'relayAppUpdatePrepareDownload',
  'relayAppUpdateDownload',
  'relayAppUpdatePrepareInstall',
  'relayAppUpdateInstall',
  'relayAppUpdateRecover',
  'relayAppUpdateDismiss',
  'relayAppUpdateRemove',
  'relayAppUpdateCancel'
] as const

export interface RelayAppUpdateRelease {
  version: string
  architecture: 'arm64' | 'x64'
  bytes: number
  sha512: string
  releasedAt: string
}
export interface RelayAppUpdateCandidate extends RelayAppUpdateRelease {
  id: string
  sha256: string
  stagedAt: number
}
export interface RelayAppUpdatePlan {
  evidenceId: string
  operation: 'download' | 'install'
  release: RelayAppUpdateRelease
  expiresAt: number
}
export type RelayAppInstallationPhase =
  'handoff-intent' | 'installer-opened' | 'installed' | 'not-confirmed' | 'uncertain' | 'dismissed'
export interface RelayAppInstallationRecord {
  version: 1
  operationId: string
  candidateId: string
  previousVersion: string
  targetVersion: string
  targetSHA256: string
  trustRevision: string
  phase: RelayAppInstallationPhase
  updatedAt: number
}
export interface RelayAppUpdateState {
  configured: boolean
  runningVersion: string
  checkedAt: number | null
  pending: boolean
  phase: 'idle' | 'checking' | 'downloading' | 'verifying' | 'handoff' | 'recovering'
  latest: RelayAppUpdateRelease | null
  candidates: RelayAppUpdateCandidate[]
  incomplete: number
  installation: RelayAppInstallationRecord | null
  installationRevision: string
  requiresApplicationExit: boolean
}

function dtoString(raw: unknown, maximum: number): string {
  if (
    typeof raw !== 'string' ||
    !raw ||
    raw.length > maximum ||
    [...raw].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error('应用更新说明字段无效。')
  return raw
}
function dtoTime(raw: unknown): number {
  if (!Number.isSafeInteger(raw) || Number(raw) < 1) throw new Error('应用更新时间无效。')
  return Number(raw)
}
function dtoRelease(
  raw: unknown,
  candidate = false
): RelayAppUpdateRelease | RelayAppUpdateCandidate {
  const value = appUpdateObject(raw, [
    'version',
    'architecture',
    'bytes',
    'sha512',
    'releasedAt',
    ...(candidate ? ['id', 'sha256', 'stagedAt'] : [])
  ])
  if (
    !['arm64', 'x64'].includes(String(value.architecture)) ||
    !Number.isSafeInteger(value.bytes) ||
    Number(value.bytes) < 1 ||
    Number(value.bytes) > 1024 ** 3 ||
    typeof value.sha512 !== 'string' ||
    !/^[A-Za-z0-9+/]{86}==$/u.test(value.sha512)
  )
    throw new Error('应用更新资产字段无效。')
  const release: RelayAppUpdateRelease = {
    version: dtoString(value.version, 128),
    architecture: value.architecture as 'arm64' | 'x64',
    bytes: Number(value.bytes),
    sha512: value.sha512,
    releasedAt: dtoString(value.releasedAt, 64)
  }
  if (!Number.isFinite(Date.parse(release.releasedAt))) throw new Error('应用发布时间无效。')
  if (!candidate) return release
  if (typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256))
    throw new Error('应用候选摘要无效。')
  return {
    ...release,
    id: appUpdateCandidateId({ id: value.id }),
    sha256: value.sha256,
    stagedAt: dtoTime(value.stagedAt)
  }
}
export function readAppUpdatePlan(raw: unknown): RelayAppUpdatePlan {
  const value = appUpdateObject(raw, ['evidenceId', 'operation', 'release', 'expiresAt'])
  if (value.operation !== 'download' && value.operation !== 'install')
    throw new Error('应用更新动作未知。')
  return {
    evidenceId: appUpdateCandidateId({ evidenceId: value.evidenceId }, 'evidenceId'),
    operation: value.operation,
    release: dtoRelease(value.release),
    expiresAt: dtoTime(value.expiresAt)
  }
}
export function readAppUpdateState(raw: unknown): RelayAppUpdateState {
  const value = appUpdateObject(raw, [
    'configured',
    'runningVersion',
    'checkedAt',
    'pending',
    'phase',
    'latest',
    'candidates',
    'incomplete',
    'installation',
    'installationRevision',
    'requiresApplicationExit'
  ])
  if (
    typeof value.configured !== 'boolean' ||
    typeof value.pending !== 'boolean' ||
    typeof value.requiresApplicationExit !== 'boolean' ||
    typeof value.phase !== 'string' ||
    !['idle', 'checking', 'downloading', 'verifying', 'handoff', 'recovering'].includes(
      value.phase
    ) ||
    (!value.pending && value.phase !== 'idle') ||
    !Array.isArray(value.candidates) ||
    value.candidates.length > 64 ||
    !Number.isSafeInteger(value.incomplete) ||
    Number(value.incomplete) < 0 ||
    typeof value.installationRevision !== 'string' ||
    (value.installationRevision !== '' && !/^[a-f0-9]{64}$/u.test(value.installationRevision))
  )
    throw new Error('应用更新状态未知。')
  const latest = value.latest === null ? null : dtoRelease(value.latest)
  const candidates = value.candidates.map(
    (item) => dtoRelease(item, true) as RelayAppUpdateCandidate
  )
  if (
    new Set(candidates.map((item) => item.id)).size !== candidates.length ||
    (!value.configured && (latest || candidates.length)) ||
    (value.checkedAt === null && latest)
  )
    throw new Error('应用更新状态缺少来源证据。')
  let installation: RelayAppInstallationRecord | null = null
  if (value.installation !== null) {
    const record = appUpdateObject(value.installation, [
      'version',
      'operationId',
      'candidateId',
      'previousVersion',
      'targetVersion',
      'targetSHA256',
      'trustRevision',
      'phase',
      'updatedAt'
    ])
    if (
      record.version !== 1 ||
      typeof record.phase !== 'string' ||
      ![
        'handoff-intent',
        'installer-opened',
        'installed',
        'not-confirmed',
        'uncertain',
        'dismissed'
      ].includes(record.phase) ||
      typeof record.targetSHA256 !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(record.targetSHA256) ||
      typeof record.trustRevision !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(record.trustRevision)
    )
      throw new Error('应用安装历史记录未知。')
    installation = {
      version: 1,
      operationId: appUpdateCandidateId({ id: record.operationId }),
      candidateId: appUpdateCandidateId({ id: record.candidateId }),
      previousVersion: dtoString(record.previousVersion, 128),
      targetVersion: dtoString(record.targetVersion, 128),
      targetSHA256: record.targetSHA256,
      trustRevision: record.trustRevision,
      phase: record.phase as RelayAppInstallationPhase,
      updatedAt: dtoTime(record.updatedAt)
    }
  }
  if (
    !!installation !== !!value.installationRevision ||
    value.requiresApplicationExit !==
      (!!installation && !['installed', 'dismissed'].includes(installation.phase))
  )
    throw new Error('应用安装状态与事务记录不一致。')
  return {
    configured: value.configured,
    runningVersion: dtoString(value.runningVersion, 128),
    checkedAt: value.checkedAt === null ? null : dtoTime(value.checkedAt),
    pending: value.pending,
    phase: value.phase as RelayAppUpdateState['phase'],
    latest,
    candidates,
    incomplete: Number(value.incomplete),
    installation,
    installationRevision: value.installationRevision,
    requiresApplicationExit: value.requiresApplicationExit
  }
}

export function appUpdateObject(raw: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).sort().join(',') !== [...fields].sort().join(',')
  )
    throw new Error('应用更新记录或参数字段无效。')
  return raw as Record<string, unknown>
}
export function appUpdateCandidateId(raw: unknown, field: 'id' | 'evidenceId' = 'id'): string {
  const value = appUpdateObject(raw, [field])[field]
  if (typeof value !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value))
    throw new Error('应用更新凭据无效。')
  return value
}
