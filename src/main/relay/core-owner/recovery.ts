import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import type { RelayStateContext } from '../context'
import {
  CORE_OWNER_CONTRACT,
  keys,
  record,
  sha,
  uuid,
  identity,
  type OwnerProcessIdentity
} from './protocol'

export interface ClosedOwnerWitness {
  sessionId: string
  owner: OwnerProcessIdentity
}

export interface CoreOwnerRecovery {
  status: 'clear' | 'liveOrUnknown' | 'stale' | 'archived' | 'uncertain'
  canArchive: boolean
  revision: string | null
  sessionId: string | null
  warnings: string[]
  closedOwnerWitness?: ClosedOwnerWitness & { absent: boolean }
}
export async function recoverCoreOwner(
  executable: string,
  context: RelayStateContext,
  expectedRevision?: string,
  closedOwnerWitness?: ClosedOwnerWitness
): Promise<CoreOwnerRecovery> {
  const requestId = randomUUID()
  const action = expectedRevision === undefined ? 'inspect' : 'archive'
  if (expectedRevision !== undefined) sha(expectedRevision)
  if (closedOwnerWitness) {
    if (action !== 'inspect') throw new Error('Closed-owner proof is readonly')
    uuid(closedOwnerWitness.sessionId)
    identity(closedOwnerWitness.owner)
  }
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--recover'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: { HOME: context.home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'en_US.UTF-8' }
    })
    let bytes = Buffer.alloc(0),
      stderr = 0,
      expired = false,
      settled = false
    const fail = (): void => {
      if (settled) return
      settled = true
      expired = true
      clearTimeout(timer)
      reject(new Error('持久owner恢复事实未确认；保留记录，不重试或按PID操作。'))
    }
    const timer = setTimeout(() => {
      expired = true
      fail()
    }, 15000)
    // Never kill a timed-out archive or repeat it. The helper's actual exit and
    // fixed journals remain authoritative; C05 also sees a still-live helper.
    child.on('error', fail)
    child.stdin.on('error', fail)
    child.stdout.on('error', fail)
    child.stdout.on('aborted', fail)
    child.stdout.on('close', () => {
      if (!child.stdout.readableEnded) fail()
    })
    child.stderr.on('error', fail)
    child.stdout.on('data', (chunk: Buffer) => {
      if (expired || settled) return // Drain subsequent output without retaining it.
      if (chunk.length > 65536 - bytes.length) {
        expired = true
        fail()
      } else bytes = Buffer.concat([bytes, chunk])
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (expired || settled) return
      stderr += chunk.length
      if (stderr > 65536) {
        expired = true
        fail()
      }
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (settled) return
      if (expired || code !== 0) {
        fail()
        return
      }
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
        if (!text.endsWith('\n') || text.indexOf('\n') !== text.length - 1) throw new Error()
        const input = record(JSON.parse(text))
        keys(
          input,
          closedOwnerWitness
            ? 'canArchive,closedOwnerWitness,contract,requestId,revision,sessionId,status,version,warnings'
            : 'canArchive,contract,requestId,revision,sessionId,status,version,warnings'
        )
        if (
          input.version !== 1 ||
          input.contract !== CORE_OWNER_CONTRACT ||
          input.requestId !== requestId ||
          typeof input.canArchive !== 'boolean' ||
          !['clear', 'liveOrUnknown', 'stale', 'archived', 'uncertain'].includes(
            String(input.status)
          ) ||
          !Array.isArray(input.warnings) ||
          input.warnings.length > 16 ||
          input.warnings.some((warning) => typeof warning !== 'string' || warning.length > 512)
        )
          throw new Error()
        const revision = input.revision === null ? null : sha(input.revision),
          sessionId = input.sessionId === null ? null : uuid(input.sessionId)
        if (
          input.canArchive !== (input.status === 'stale') ||
          (input.canArchive && (!revision || !sessionId)) ||
          (action === 'inspect' && input.status === 'archived')
        )
          throw new Error()
        let proof: CoreOwnerRecovery['closedOwnerWitness']
        if (closedOwnerWitness) {
          const witness = record(input.closedOwnerWitness)
          keys(witness, 'absent,owner,sessionId')
          const owner = identity(witness.owner)
          if (
            witness.sessionId !== closedOwnerWitness.sessionId ||
            typeof witness.absent !== 'boolean' ||
            (Object.keys(owner) as (keyof OwnerProcessIdentity)[]).some(
              (key) => owner[key] !== closedOwnerWitness.owner[key]
            )
          )
            throw new Error('Closed owner witness changed')
          proof = { sessionId: closedOwnerWitness.sessionId, owner, absent: witness.absent }
        }
        settled = true
        resolve({
          status: input.status as CoreOwnerRecovery['status'],
          canArchive: input.canArchive,
          revision,
          sessionId,
          warnings: [...input.warnings] as string[],
          ...(proof ? { closedOwnerWitness: proof } : {})
        })
      } catch {
        fail()
      }
    })
    child.stdin.end(
      JSON.stringify({
        version: 1,
        contract: CORE_OWNER_CONTRACT,
        requestId,
        action,
        context,
        ...(closedOwnerWitness ? { closedOwnerWitness } : {}),
        ...(expectedRevision === undefined ? {} : { expectedRevision })
      }) + '\n'
    )
  })
}
