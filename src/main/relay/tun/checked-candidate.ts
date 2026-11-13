import {
  tunHelperObservation,
  tunNetworkObservation,
  tunPlanRequest,
  type TunHelperObservation,
  type TunNetworkObservation,
  type TunPlanRequest
} from '../../../shared/relay/tun'
import { profileEvidence } from '../../../shared/relay/profiles'
import type { CheckedConfigurationSnapshot } from '../configuration/service'
import { resourceHash } from '../resources/source'
import type { TunPlanEvidence } from './plan'
import { prepareTunDescriptorRuntime, tunDescriptorRuntimeIsCurrent } from './runtime'
import type { TunSessionCandidate } from './service'

export interface TunCheckedNativeObservation {
  helper: TunHelperObservation
  network: TunNetworkObservation
}

// Main-process bridge from one successful complete-parser check to the exact
// private TUN candidate. The lookup is populated by trusted complete-check IPC
// results; a renderer cannot substitute a source path, bytes, UID or native state.
export function createCheckedTunCandidateReader(adapters: {
  resolveEvidenceId(
    request: Readonly<TunPlanRequest>
  ): string | undefined | Promise<string | undefined>
  takeChecked(request: { evidenceId: string }): Promise<CheckedConfigurationSnapshot>
  observeNative(): Promise<TunCheckedNativeObservation>
  // Reobserve the original baseline, excluding only positively held effects of
  // this candidate. Do not refresh authorization timestamps or ignore unrelated
  // changes merely because acquiring the candidate added its own interface.
  recheckNative(expected: TunCheckedNativeObservation): Promise<void>
  expectedHelperSHA256: string
  expectedCoreSHA256: string
  currentUID: number
  now?(): number
}): (request: unknown) => Promise<TunSessionCandidate> {
  const now = adapters.now ?? Date.now,
    expectedHelperSHA256 = adapters.expectedHelperSHA256,
    expectedCoreSHA256 = adapters.expectedCoreSHA256,
    currentUID = adapters.currentUID
  return async (raw) => {
    const request = tunPlanRequest(raw),
      evidenceId = await adapters.resolveEvidenceId(request)
    if (!evidenceId) throw new Error('没有与本次摘要一致的完整配置检查，请先重新检查。')
    const checked = await adapters.takeChecked({ evidenceId: profileEvidence({ evidenceId }) })
    if (
      checked.configurationSHA256 !== request.configurationSHA256 ||
      checked.bundleSHA256 !== request.bundleSHA256 ||
      resourceHash(Buffer.from(checked.configuration)) !== request.configurationSHA256
    )
      throw new Error('已检查的私有配置或资源包与本次请求摘要不一致。')
    await checked.recheck()
    const native = await adapters.observeNative(),
      original = {
        helper: tunHelperObservation(native.helper),
        network: tunNetworkObservation(native.network)
      },
      evidence: TunPlanEvidence = {
        configurationExpiresAt: checked.expiresAt,
        configuration: checked.configuration,
        assets: checked.assets.map(({ bytes, ...asset }) => {
          if (!Buffer.isBuffer(bytes)) throw new Error('已检查的资源正文类型无效。')
          return { ...structuredClone(asset), bytes: Buffer.from(bytes) }
        }),
        pins: structuredClone(checked.pins),
        parser: structuredClone(checked.parser),
        ...structuredClone(original),
        expectedHelperSHA256,
        expectedCoreSHA256,
        currentUID
      },
      runtime = prepareTunDescriptorRuntime(request, evidence, now())
    const current = (): void => {
      if (!tunDescriptorRuntimeIsCurrent(runtime, request, evidence, now()))
        throw new Error('已检查的TUN候选、资源或原生准备时效已变化。')
    }
    return {
      evidence,
      async recheck(): Promise<void> {
        current()
        await checked.recheck()
        current()
        await adapters.recheckNative(structuredClone(original))
        current()
      }
    }
  }
}
