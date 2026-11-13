import { isAbsolute, join, normalize } from 'path'
import type { RelayStateContext } from '../context'

export const CORE_OWNER_CONTRACT = 'relay-ordinary-core-owner-v1'
const uuidPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
const shaPattern = /^[a-f0-9]{64}$/u
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('owner frame')
  return value as Record<string, unknown>
}
export function keys(value: Record<string, unknown>, expected: string): void {
  if (Object.keys(value).sort().join(',') !== expected) throw new Error('owner keys')
}
export function uuid(value: unknown): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new Error('owner UUID')
  return value
}
export function sha(value: unknown): string {
  if (typeof value !== 'string' || !shaPattern.test(value)) throw new Error('owner SHA')
  return value
}
function clean(value: unknown, maximum = 1024): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > maximum ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    )
  )
    throw new Error('owner string')
  return value
}
function path(value: unknown): string {
  const text = clean(value)
  if (!isAbsolute(text) || normalize(text) !== text) throw new Error('owner path')
  return text
}
function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('owner Boolean')
  return value
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  )
    throw new Error('owner integer')
  return value
}
export interface OwnerProcessIdentity {
  pid: number
  uid: number
  bornSeconds: string
  bornMicroseconds: string
  executable: string
  resourceSHA256: string
  fileIdentity: string
}
export function identity(value: unknown): OwnerProcessIdentity {
  const input = record(value)
  keys(input, 'bornMicroseconds,bornSeconds,executable,fileIdentity,pid,resourceSHA256,uid')
  for (const name of ['bornSeconds', 'bornMicroseconds'])
    if (typeof input[name] !== 'string' || !/^(?:0|[1-9][0-9]{0,19})$/u.test(input[name]))
      throw new Error('owner birth')
  if (Number(input.bornMicroseconds) > 999999) throw new Error('owner birth')
  return {
    pid: integer(input.pid, 2, 0x7fffffff),
    uid: integer(input.uid, 0, 0xffffffff),
    bornSeconds: String(input.bornSeconds),
    bornMicroseconds: String(input.bornMicroseconds),
    executable: path(input.executable),
    resourceSHA256: sha(input.resourceSHA256),
    fileIdentity: clean(input.fileIdentity, 256)
  }
}
export interface OwnerSnapshot {
  version: 1
  contract: typeof CORE_OWNER_CONTRACT
  sessionId: string
  phase:
    | 'reserved'
    | 'starting'
    | 'ready'
    | 'detachPrepared'
    | 'detached'
    | 'stopping'
    | 'closed'
    | 'uncertain'
    | 'released'
  revision: string
  owner: OwnerProcessIdentity
  core: OwnerProcessIdentity | null
  coreLease: { token: string; directoryIdentity: string; ownerSHA256: string }
  runtime: {
    directory: string
    socket: string
    httpPort: number
    profileId: string
    sourceSHA256: string
    configurationSHA256: string | null
    mode: 'rule' | 'global' | 'direct'
    coreResourceSHA256: string
  }
  attachedMain: OwnerProcessIdentity | null
  controlLost: boolean
  detached: boolean
  released: boolean
  warnings: string[]
}
export interface OwnerReply {
  version: 1
  contract: typeof CORE_OWNER_CONTRACT
  requestId: string
  status: 'ok' | 'refused' | 'uncertain'
  connectionId: string
  clientNonce: string
  serverNonce: string
  sequence: number
  snapshot: OwnerSnapshot
  error?: string
  detach?: { evidenceId: string; revision: string; expiresAt: number }
}
export function ownerReply(value: unknown, context: RelayStateContext): OwnerReply {
  const input = record(value)
  const expected = [
    'clientNonce',
    'connectionId',
    'contract',
    'requestId',
    'sequence',
    'serverNonce',
    'snapshot',
    'status',
    'version'
  ]
  if (Object.hasOwn(input, 'error')) expected.push('error')
  if (Object.hasOwn(input, 'detach')) expected.push('detach')
  keys(input, expected.sort().join(','))
  if (
    input.version !== 1 ||
    input.contract !== CORE_OWNER_CONTRACT ||
    !['ok', 'refused', 'uncertain'].includes(String(input.status))
  )
    throw new Error('owner response')
  const raw = record(input.snapshot)
  keys(
    raw,
    'attachedMain,contract,controlLost,core,coreLease,detached,owner,phase,released,revision,runtime,sessionId,version,warnings'
  )
  if (
    raw.version !== 1 ||
    raw.contract !== CORE_OWNER_CONTRACT ||
    ![
      'reserved',
      'starting',
      'ready',
      'detachPrepared',
      'detached',
      'stopping',
      'closed',
      'uncertain',
      'released'
    ].includes(String(raw.phase))
  )
    throw new Error('owner phase')
  const lease = record(raw.coreLease),
    runtime = record(raw.runtime)
  keys(lease, 'directoryIdentity,ownerSHA256,token')
  keys(
    runtime,
    'configurationSHA256,coreResourceSHA256,directory,httpPort,mode,profileId,socket,sourceSHA256'
  )
  const directory = join(context.stateRoot, 'CoreOwner/.session')
  if (
    path(runtime.directory) !== directory ||
    path(runtime.socket) !== join(directory, 'api.sock') ||
    Buffer.byteLength(join(directory, 'owner.sock')) > 103 ||
    !['rule', 'global', 'direct'].includes(String(runtime.mode))
  )
    throw new Error('owner fixed runtime')
  if (!Array.isArray(raw.warnings) || raw.warnings.length > 16) throw new Error('owner warnings')
  const snapshot: OwnerSnapshot = {
    version: 1,
    contract: CORE_OWNER_CONTRACT,
    sessionId: uuid(raw.sessionId),
    phase: raw.phase as OwnerSnapshot['phase'],
    revision: sha(raw.revision),
    owner: identity(raw.owner),
    core: raw.core === null ? null : identity(raw.core),
    coreLease: {
      token: uuid(lease.token),
      directoryIdentity: clean(lease.directoryIdentity, 256),
      ownerSHA256: sha(lease.ownerSHA256)
    },
    runtime: {
      directory,
      socket: join(directory, 'api.sock'),
      httpPort: integer(runtime.httpPort, 1024, 65535),
      profileId: uuid(runtime.profileId),
      sourceSHA256: sha(runtime.sourceSHA256),
      configurationSHA256:
        runtime.configurationSHA256 === null ? null : sha(runtime.configurationSHA256),
      mode: runtime.mode as OwnerSnapshot['runtime']['mode'],
      coreResourceSHA256: sha(runtime.coreResourceSHA256)
    },
    attachedMain: raw.attachedMain === null ? null : identity(raw.attachedMain),
    controlLost: bool(raw.controlLost),
    detached: bool(raw.detached),
    released: bool(raw.released),
    warnings: raw.warnings.map((warning) => clean(warning, 512))
  }
  if (
    snapshot.coreLease.token !== snapshot.sessionId ||
    (['ready', 'detachPrepared', 'detached'].includes(snapshot.phase) &&
      (!snapshot.core || !snapshot.runtime.configurationSHA256)) ||
    (snapshot.phase === 'detached' && !snapshot.detached) ||
    (snapshot.detached && !['detached', 'uncertain'].includes(snapshot.phase)) ||
    snapshot.released !== (snapshot.phase === 'released')
  )
    throw new Error('owner inconsistent facts')
  let detach: OwnerReply['detach']
  if (input.detach !== undefined) {
    const grant = record(input.detach)
    keys(grant, 'evidenceId,expiresAt,revision')
    detach = {
      evidenceId: uuid(grant.evidenceId),
      revision: sha(grant.revision),
      expiresAt: integer(grant.expiresAt, 1, Number.MAX_SAFE_INTEGER)
    }
  }
  return {
    version: 1,
    contract: CORE_OWNER_CONTRACT,
    requestId: uuid(input.requestId),
    status: input.status as OwnerReply['status'],
    connectionId: uuid(input.connectionId),
    clientNonce: sha(input.clientNonce),
    serverNonce: sha(input.serverNonce),
    sequence: integer(input.sequence, 0, Number.MAX_SAFE_INTEGER),
    snapshot,
    ...(input.error === undefined ? {} : { error: clean(input.error, 128) }),
    ...(detach ? { detach } : {})
  }
}
