import {
  SMART_TOOLS_CAPABILITY,
  SMART_TOOLS_FRAME_BYTES,
  smartCacheAcceptance,
  smartToolsDefinition,
  smartWeightsSnapshot,
  type SmartToolsDefinition,
  type SmartToolsSnapshot
} from '../../../shared/relay/smart-tools'
import { createTunAssetChannel, type TunAssetIdentity, type TunAssetIO } from './asset-channel'

// FD9/10 only. No control, capture, rule, asset, state-CAS or lifecycle fallback.
export function createTunSmartToolsChannel(
  io: TunAssetIO,
  identity: TunAssetIdentity,
  input: SmartToolsDefinition,
  timeout = 30000
) {
  const definition = smartToolsDefinition(structuredClone(input))
  if (definition.configurationRevision !== identity.runtimeConfigurationSHA256)
    throw new Error('Smart工具配置与继承管道绑定不符。')
  const channel = createTunAssetChannel<SmartToolsSnapshot, Record<string, never>, never>(
    io,
    identity,
    {
      capability: SMART_TOOLS_CAPABILITY,
      frameByteLimit: SMART_TOOLS_FRAME_BYTES,
      label: 'Smart工具',
      mutation(raw) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length)
          throw new Error('清理操作不接收路径、配置名或任意Core接口。')
        return {}
      },
      ticket() {
        throw new Error('Smart工具不消费资源票据。')
      },
      snapshot(raw, status) {
        return status === 'snapshot'
          ? smartWeightsSnapshot(raw, definition)
          : smartCacheAcceptance(raw, definition)
      },
      verifyCommit(snapshot) {
        smartCacheAcceptance(snapshot, definition)
      }
    },
    timeout
  )
  return {
    weights: channel.read,
    // Accepted means exact fixed-Core HTTP204 only, never durable zero/CSV flush.
    clearCache: (signal: AbortSignal, assertOwner: () => void) =>
      channel.replace({}, signal, assertOwner),
    invalidate: channel.invalidate,
    isAvailable: channel.isAvailable,
    isBusy: channel.isBusy,
    whenIdle: channel.whenIdle
  }
}
