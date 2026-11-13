import type { LocalProxyState } from './local-proxy'

export interface ConnectionSnapshot {
  connections: unknown[]
  download: number
  upload: number
}

export interface RuntimeLogLine {
  readonly sequence: number
  readonly text: string
}

export interface RuntimeLogSnapshot {
  readonly sequence: number
  readonly lines: readonly RuntimeLogLine[]
}

export interface NetworkInterfaceInfo {
  name: string
  addresses: { address: string; family: 'IPv4' | 'IPv6'; internal: boolean }[]
}

export interface RuntimeInfoSnapshot {
  process: Pick<
    LocalProxyState,
    'instanceId' | 'configurationRevision' | 'pid' | 'phase' | 'mode' | 'httpPort' | 'dedicated'
  >
  interfaces: NetworkInterfaceInfo[]
  traffic: { download: number; upload: number } | undefined
  memory?: number
  externalIpLookupWired: false
  remoteLatencyProbeWired: false
  warnings: string[]
}
