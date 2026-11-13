import type { NetworkTopologyConnection } from '../network/network-topology'
import { observedConnectionLimit } from './runtime-info'

export function runtimeTopologyConnections(rows: readonly unknown[]): NetworkTopologyConnection[] {
  return rows.slice(0, observedConnectionLimit).flatMap((raw): NetworkTopologyConnection[] => {
    if (!raw || typeof raw !== 'object') return []
    const value = raw as Record<string, unknown>
    if (
      !value.metadata ||
      typeof value.metadata !== 'object' ||
      typeof value.upload !== 'number' ||
      !Number.isFinite(value.upload) ||
      value.upload < 0 ||
      typeof value.download !== 'number' ||
      !Number.isFinite(value.download) ||
      value.download < 0
    )
      return []
    const meta = value.metadata as Record<string, unknown>
    const chains = Array.isArray(value.chains)
      ? value.chains.filter((name): name is string => typeof name === 'string' && name.length > 0)
      : []
    return [
      {
        metadata: {
          sourceIP: typeof meta.sourceIP === 'string' ? meta.sourceIP : undefined,
          sourcePort:
            typeof meta.sourcePort === 'string' || typeof meta.sourcePort === 'number'
              ? meta.sourcePort
              : undefined
        },
        upload: value.upload,
        download: value.download,
        rule: typeof value.rule === 'string' && value.rule ? value.rule : '未知规则',
        rulePayload: typeof value.rulePayload === 'string' ? value.rulePayload : undefined,
        chains: chains.length ? chains : ['未知出站']
      }
    ]
  })
}
