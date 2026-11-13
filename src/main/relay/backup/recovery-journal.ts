import { BACKUP_MAX_FILES, backupDirectories, backupFiles } from './archive'
import type { BackupRestorePlan } from './store'

export const recoveryRoots: readonly string[] = [...backupDirectories, ...backupFiles]
export type RecoveryAction = 'resume' | 'rollback'
export type RecoveryPhase =
  'staged' | 'applying' | 'applied' | 'uncertain' | 'rolling-back' | 'rolled-back'
export type RecoverySlot = 'current' | 'candidate' | 'original' | 'displaced'
export interface RecoveryIdentity {
  dev: number
  ino: number
  uid: number
  mode: number
}
export interface RecoveryAsset {
  sha256: string
  identity: RecoveryIdentity
}
export interface RecoveryRootState {
  root: string
  before: RecoveryAsset | null
  after: RecoveryAsset | null
  baseline: 'current' | 'original' | null
  target: 'candidate' | 'current' | 'displaced' | null
}
export interface RecoveryIntent {
  action: RecoveryAction
  root: string
  from: RecoverySlot
  to: RecoverySlot
  identity: RecoveryIdentity
  sha256: string
}
export interface RecoveryMarker {
  name: 'recheck-pending' | 'recovery-pending'
  identity: RecoveryIdentity
  sha256: string
}
export interface RecoveryJournal {
  version: 2
  plan: BackupRestorePlan
  baselineArchiveSHA256: string
  directoryIdentity: RecoveryIdentity
  phase: RecoveryPhase
  direction: RecoveryAction
  roots: RecoveryRootState[]
  completed: string[]
  intent?: RecoveryIntent
  marker?: RecoveryMarker
}
export interface LegacyRecoveryJournal {
  version: 1
  plan: BackupRestorePlan
  phase: 'staged' | 'applying' | 'applied' | 'uncertain'
  completed: string[]
}

type Item = Record<string, unknown>
const directoryRoots = new Set<string>(backupDirectories)
const sha = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)
const natural = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max
function fail(): never {
  throw new Error('恢复记录版本、字段、身份或步骤无效；未推断或执行恢复。')
}
function fields(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Item {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail()
  const item = value as Item
  if (
    required.some((key) => !Object.hasOwn(item, key)) ||
    Object.keys(item).some((key) => !required.includes(key) && !optional.includes(key))
  )
    return fail()
  return item
}
function identity(
  value: unknown,
  kind: 'directory' | 'file' | 'record' | 'marker'
): RecoveryIdentity {
  const item = fields(value, ['dev', 'ino', 'uid', 'mode'])
  if (
    !natural(item.dev) ||
    !natural(item.ino) ||
    item.ino === 0 ||
    !natural(item.uid, 0xffffffff) ||
    !natural(item.mode, 0o177777) ||
    (item.mode & 0o170000) !== (kind === 'directory' || kind === 'record' ? 0o040000 : 0o100000) ||
    (item.mode & 0o7022) !== 0 ||
    (kind === 'record' && (item.mode & 0o7777) !== 0o700) ||
    (kind === 'marker' && (item.mode & 0o7777) !== 0o600)
  )
    return fail()
  return { dev: item.dev, ino: item.ino, uid: item.uid, mode: item.mode }
}
function asset(value: unknown, root: string): RecoveryAsset | null {
  if (value === null) return null
  const item = fields(value, ['sha256', 'identity'])
  if (!sha(item.sha256)) return fail()
  return {
    sha256: item.sha256,
    identity: identity(item.identity, directoryRoots.has(root) ? 'directory' : 'file')
  }
}
function plan(value: unknown): BackupRestorePlan {
  const item = fields(value, [
    'id',
    'baselineSHA256',
    'targetSHA256',
    'archiveSHA256',
    'files',
    'replacedFiles',
    'removedFiles',
    'containsSecrets',
    'preparedAt'
  ])
  if (
    typeof item.id !== 'string' ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(item.id) ||
    !sha(item.baselineSHA256) ||
    !sha(item.targetSHA256) ||
    !sha(item.archiveSHA256) ||
    !natural(item.files, BACKUP_MAX_FILES) ||
    !natural(item.replacedFiles, item.files) ||
    !natural(item.removedFiles, BACKUP_MAX_FILES) ||
    !natural(item.preparedAt, Number.MAX_SAFE_INTEGER - 60000) ||
    item.containsSecrets !== true
  )
    return fail()
  return {
    id: item.id,
    baselineSHA256: item.baselineSHA256,
    targetSHA256: item.targetSHA256,
    archiveSHA256: item.archiveSHA256,
    files: item.files,
    replacedFiles: item.replacedFiles,
    removedFiles: item.removedFiles,
    containsSecrets: true,
    preparedAt: item.preparedAt
  }
}
const sameIdentity = (left: RecoveryIdentity, right: RecoveryIdentity): boolean =>
  left.dev === right.dev &&
  left.ino === right.ino &&
  left.uid === right.uid &&
  left.mode === right.mode

// Read legacy metadata conservatively. A valid v1 record still contains no
// persisted baseline/layout proof and must never be promoted to v2 recovery.
export function legacyRecoveryJournal(value: unknown): LegacyRecoveryJournal {
  const item = fields(value, ['version', 'plan', 'phase', 'completed'])
  if (
    item.version !== 1 ||
    typeof item.phase !== 'string' ||
    !['staged', 'applying', 'applied', 'uncertain'].includes(item.phase) ||
    !Array.isArray(item.completed) ||
    item.completed.length > recoveryRoots.length ||
    item.completed.some((root, index) => root !== recoveryRoots[index]) ||
    (item.phase === 'staged' && item.completed.length !== 0) ||
    (item.phase === 'applied' && item.completed.length !== recoveryRoots.length)
  )
    return fail()
  return {
    version: 1,
    plan: plan(item.plan),
    phase: item.phase as LegacyRecoveryJournal['phase'],
    completed: [...item.completed] as string[]
  }
}

// Pure structural validation. File ownership, content, archives and actual
// pre-/post-intent layouts must independently be verified by the store.
export function recoveryJournal(value: unknown): RecoveryJournal {
  const item = fields(
    value,
    [
      'version',
      'plan',
      'baselineArchiveSHA256',
      'directoryIdentity',
      'phase',
      'direction',
      'roots',
      'completed'
    ],
    ['intent', 'marker']
  )
  if (
    item.version !== 2 ||
    !sha(item.baselineArchiveSHA256) ||
    typeof item.phase !== 'string' ||
    !['staged', 'applying', 'applied', 'uncertain', 'rolling-back', 'rolled-back'].includes(
      item.phase
    ) ||
    (item.direction !== 'resume' && item.direction !== 'rollback') ||
    !Array.isArray(item.roots) ||
    item.roots.length !== recoveryRoots.length ||
    !Array.isArray(item.completed) ||
    item.completed.length > recoveryRoots.length ||
    item.completed.some((root, index) => root !== recoveryRoots[index])
  )
    return fail()
  const phase = item.phase as RecoveryPhase,
    direction = item.direction as RecoveryAction
  if (
    (['staged', 'applying', 'applied'].includes(phase) && direction !== 'resume') ||
    (['rolling-back', 'rolled-back'].includes(phase) && direction !== 'rollback')
  )
    return fail()
  const roots = item.roots.map((raw, index): RecoveryRootState => {
    const entry = fields(raw, ['root', 'before', 'after', 'baseline', 'target']),
      root = recoveryRoots[index]
    if (entry.root !== root) return fail()
    const before = asset(entry.before, root),
      after = asset(entry.after, root)
    if (
      (before === null
        ? entry.baseline !== null
        : entry.baseline !== 'current' && entry.baseline !== 'original') ||
      (after === null
        ? entry.target !== null
        : entry.target !== 'candidate' &&
          entry.target !== 'current' &&
          entry.target !== 'displaced') ||
      (entry.baseline === 'current' && entry.target === 'current') ||
      (direction === 'resume' && entry.target === 'displaced')
    )
      return fail()
    return {
      root,
      before,
      after,
      baseline: entry.baseline as RecoveryRootState['baseline'],
      target: entry.target as RecoveryRootState['target']
    }
  })
  const result: RecoveryJournal = {
    version: 2,
    plan: plan(item.plan),
    baselineArchiveSHA256: item.baselineArchiveSHA256,
    directoryIdentity: identity(item.directoryIdentity, 'record'),
    phase,
    direction,
    roots,
    completed: [...item.completed] as string[]
  }
  if (Object.hasOwn(item, 'intent')) {
    const intent = fields(item.intent, ['action', 'root', 'from', 'to', 'identity', 'sha256'])
    if (
      intent.action !== direction ||
      typeof intent.root !== 'string' ||
      !sha(intent.sha256) ||
      !['applying', 'rolling-back', 'uncertain'].includes(phase)
    )
      return fail()
    const root = roots.find((root) => root.root === intent.root)
    if (!root) return fail()
    let expected: RecoveryAsset | null | undefined
    if (direction === 'resume' && intent.from === 'current' && intent.to === 'original')
      expected = root.baseline === 'current' ? root.before : undefined
    else if (direction === 'resume' && intent.from === 'candidate' && intent.to === 'current')
      expected = root.target === 'candidate' && root.baseline !== 'current' ? root.after : undefined
    else if (direction === 'rollback' && intent.from === 'current' && intent.to === 'displaced')
      expected = root.target === 'current' ? root.after : undefined
    else if (direction === 'rollback' && intent.from === 'original' && intent.to === 'current')
      expected = root.baseline === 'original' && root.target !== 'current' ? root.before : undefined
    if (!expected) return fail()
    const checkedIdentity = identity(
      intent.identity,
      directoryRoots.has(root.root) ? 'directory' : 'file'
    )
    if (!sameIdentity(checkedIdentity, expected.identity) || intent.sha256 !== expected.sha256)
      return fail()
    result.intent = {
      action: direction,
      root: root.root,
      from: intent.from as RecoverySlot,
      to: intent.to as RecoverySlot,
      identity: checkedIdentity,
      sha256: intent.sha256
    }
  }
  if (Object.hasOwn(item, 'marker')) {
    const marker = fields(item.marker, ['name', 'identity', 'sha256'])
    if (
      (marker.name !== 'recheck-pending' && marker.name !== 'recovery-pending') ||
      !sha(marker.sha256)
    )
      return fail()
    result.marker = {
      name: marker.name,
      identity: identity(marker.identity, 'marker'),
      sha256: marker.sha256
    }
  }
  if (
    (phase === 'staged' &&
      (result.intent ||
        result.completed.length ||
        roots.some(
          (root) =>
            root.baseline !== (root.before ? 'current' : null) ||
            root.target !== (root.after ? 'candidate' : null)
        ))) ||
    (phase === 'applied' &&
      (result.intent ||
        result.completed.length !== recoveryRoots.length ||
        roots.some(
          (root) =>
            root.baseline !== (root.before ? 'original' : null) ||
            root.target !== (root.after ? 'current' : null)
        ))) ||
    (phase === 'rolled-back' &&
      (result.intent ||
        roots.some(
          (root) => root.baseline !== (root.before ? 'current' : null) || root.target === 'current'
        )))
  )
    return fail()
  return result
}
