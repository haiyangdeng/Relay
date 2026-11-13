// Read-only network and process info for the owned local proxy runtime.
//
// Batch 32 surface: connections, logs, real-time traffic totals, local network
// interfaces and owned-core process identity — all read from real data, never
// fabricated. External IP lookup (fetchIPInfo) and remote latency probes are
// deliberately NOT wired here: they would call external services without an
// explicit per-instance user authorisation, which the project forbids. The
// owned-core live totals (download/upload from the connections endpoint) stand
// in for the real-time stat until a streaming ws sampler is added.
import { networkInterfaces } from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import type { LocalProxyState } from '../../../shared/relay/local-proxy'
import type { NetworkInterfaceInfo, RuntimeInfoSnapshot } from '../../../shared/relay/observability'
export type { NetworkInterfaceInfo, RuntimeInfoSnapshot } from '../../../shared/relay/observability'

const execFileAsync = promisify(execFile)
export async function readProcessMemory(pid: number): Promise<number | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], {
      timeout: 1000,
      maxBuffer: 1024,
      encoding: 'utf8'
    })
    const value = stdout.trim()
    if (!/^\d+$/.test(value)) return undefined
    const bytes = Number(value) * 1024
    return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined
  } catch {
    return undefined
  }
}

export function readNetworkInterfaces(): NetworkInterfaceInfo[] {
  const result: NetworkInterfaceInfo[] = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (!Array.isArray(entries) || !entries.length) continue
    const addresses: NetworkInterfaceInfo['addresses'] = []
    for (const entry of entries)
      if (entry && (entry.family === 'IPv4' || entry.family === 'IPv6'))
        addresses.push({
          address: entry.address,
          family: entry.family,
          internal: !!entry.internal
        })
    if (!addresses.length) continue
    result.push({ name, addresses })
  }
  return result
}

export function createRuntimeInfoService(adapters: {
  state(): LocalProxyState
  connections(): Promise<{ download: number; upload: number } | undefined>
  memory?(pid: number): Promise<number | undefined>
}) {
  return {
    async inspect(): Promise<RuntimeInfoSnapshot> {
      const state = adapters.state()
      const interfaces = readNetworkInterfaces()
      let traffic: { download: number; upload: number } | undefined
      try {
        traffic = await adapters.connections()
      } catch {
        traffic = undefined
      }
      const warnings: string[] = []
      if (state.phase === 'running' && traffic === undefined)
        warnings.push('本次自有核心连接总数未能读取；不替代真实流量统计。')
      let memory: number | undefined
      if (
        state.owned &&
        state.phase === 'running' &&
        !state.pending &&
        !state.uncertain &&
        state.pid
      ) {
        memory = await (adapters.memory ?? readProcessMemory)(state.pid)
        const after = adapters.state()
        if (
          after.instanceId !== state.instanceId ||
          after.configurationRevision !== state.configurationRevision ||
          after.pid !== state.pid ||
          after.phase !== state.phase ||
          !after.owned ||
          after.pending ||
          after.uncertain
        )
          memory = undefined
      }
      return {
        process: {
          instanceId: state.instanceId,
          configurationRevision: state.configurationRevision,
          pid: state.pid,
          phase: state.phase,
          mode: state.mode,
          httpPort: state.httpPort,
          dedicated: state.dedicated
        },
        interfaces,
        traffic,
        ...(memory === undefined ? {} : { memory }),
        externalIpLookupWired: false,
        remoteLatencyProbeWired: false,
        warnings
      }
    }
  }
}
