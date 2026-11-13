import { tunDigest } from '../../../shared/relay/tun'
import type { SmartStateSeedV1, SmartStateFile } from '../core/smart-state-schema'
import { validateSmartStateSeedMetadata } from './checked-execution'
import { createTunAssetChannel, type TunAssetIO, type TunAssetIdentity } from './asset-channel'

export interface TunSmartStateSnapshot {
  version: 1
  executionSHA256: string
  key: string
  previousRevision: string | null
  files: readonly SmartStateFile[]
  resultSHA256: string
  committedRevision?: string
  cleanupNonce?: string
}
interface Acknowledgement {
  executionSHA256: string
  key: string
  resultSHA256: string
  committedRevision: string
}
const object = (raw: unknown): raw is Record<string, unknown> =>
  !!raw && typeof raw === 'object' && !Array.isArray(raw)
const keys = (raw: Record<string, unknown>, names: string): boolean =>
  Object.keys(raw).sort().join(',') === names.split(',').sort().join(',')
const invalid = (): Error => new Error('Smart状态回执未确认；保留本次运行数据。')

// Only the separately inherited Smart pipe is delegated. Lifecycle restoration
// and the later control-channel cleanup proof remain outside this broker.
export function createTunSmartStateChannel(
  io: TunAssetIO,
  identity: TunAssetIdentity,
  executionSHA256: string,
  inputSeed: SmartStateSeedV1,
  collectCSV: boolean,
  timeout = 30000
) {
  const seed = structuredClone(inputSeed)
  validateSmartStateSeedMetadata(seed, collectCSV)
  if (!tunDigest(executionSHA256)) throw invalid()
  let exported: TunSmartStateSnapshot | undefined
  const channel = createTunAssetChannel<TunSmartStateSnapshot, Acknowledgement, never>(
    io,
    identity,
    {
      capability: 'smart-state-v1',
      frameByteLimit: 8192,
      label: 'Smart状态',
      mutation(raw) {
        if (
          !object(raw) ||
          !keys(raw, 'executionSHA256,key,resultSHA256,committedRevision') ||
          raw.executionSHA256 !== executionSHA256 ||
          raw.key !== seed.key ||
          !exported ||
          raw.resultSHA256 !== exported.resultSHA256 ||
          !tunDigest(raw.committedRevision)
        )
          throw invalid()
        return {
          executionSHA256,
          key: seed.key,
          resultSHA256: exported.resultSHA256,
          committedRevision: raw.committedRevision
        }
      },
      ticket() {
        throw invalid()
      },
      snapshot(raw, status) {
        const acknowledged = status === 'updated'
        if (
          !object(raw) ||
          !keys(
            raw,
            'version,executionSHA256,key,previousRevision,files,resultSHA256' +
              (acknowledged ? ',committedRevision,cleanupNonce' : '')
          ) ||
          raw.version !== 1 ||
          raw.executionSHA256 !== executionSHA256 ||
          raw.key !== seed.key ||
          raw.previousRevision !== seed.previousRevision ||
          !tunDigest(raw.resultSHA256) ||
          (acknowledged && (!tunDigest(raw.committedRevision) || !tunDigest(raw.cleanupNonce)))
        )
          throw invalid()
        const result = {
          version: 1 as const,
          key: seed.key,
          previousRevision: seed.previousRevision,
          files: raw.files
        }
        validateSmartStateSeedMetadata(result, collectCSV)
        return {
          ...result,
          executionSHA256,
          resultSHA256: raw.resultSHA256,
          ...(acknowledged
            ? {
                committedRevision: String(raw.committedRevision),
                cleanupNonce: String(raw.cleanupNonce)
              }
            : {})
        }
      },
      verifyCommit(reply, selected) {
        if (
          !exported ||
          reply.executionSHA256 !== selected.executionSHA256 ||
          reply.key !== selected.key ||
          reply.resultSHA256 !== selected.resultSHA256 ||
          reply.committedRevision !== selected.committedRevision ||
          !tunDigest(reply.cleanupNonce) ||
          JSON.stringify(reply.files) !== JSON.stringify(exported.files)
        )
          throw invalid()
      }
    },
    timeout
  )
  return {
    async export(signal: AbortSignal, assertOwner: () => void) {
      const result = await channel.read(signal, assertOwner)
      if (result.status === 'snapshot') exported = structuredClone(result.snapshot)
      return result
    },
    acknowledge(committedRevision: string, signal: AbortSignal, assertOwner: () => void) {
      return channel.replace(
        {
          executionSHA256,
          key: seed.key,
          resultSHA256: exported?.resultSHA256 ?? '',
          committedRevision
        },
        signal,
        assertOwner
      )
    },
    cancel: channel.cancel,
    invalidate: channel.invalidate,
    whenIdle: channel.whenIdle
  }
}
