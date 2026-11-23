import { webUtils } from 'electron'
import type { SubStoreAdvancedStart, SubStoreState } from '../shared/relay/substore'
import type { RelayProfileSelection } from '../shared/relay/runtime'
import type {
  IsolatedProbeRequest,
  IsolatedProbeTargets,
  IsolatedProbePlan,
  IsolatedProbeResult,
  IsolatedProbeState
} from '../shared/relay/isolated-probes'
import type {
  ConnectionAppInfo,
  ConnectionAppInfoRequest
} from '../shared/relay/connection-app-info'
import type { RelayLibraryInventory, RelayLibraryChange } from '../shared/relay/library'
import type { TunIpcApi } from '../shared/relay/tun'
import type {
  RelayLoginItemResult,
  RelayLoginItemState,
  RelayShellTheme
} from '../shared/relay/shell'
import type { TrafficHistoryOwner, TrafficHistoryState } from '../shared/relay/traffic-history'
import type { RelaySimpleIpcApi } from '../shared/relay/simple'
import type { RelaySimpleSourcesIpcApi } from '../shared/relay/simple-sources'
import type { RelaySimpleConfigurationIpcApi } from '../shared/relay/simple-configuration'
import type { RelaySimplePublicationIpcApi } from '../shared/relay/simple-publication'
import type { ReadonlyFloatingBridge } from './relay-floating'

type IpcListener = (event: Electron.IpcRendererEvent, ...args: unknown[]) => void
type IpcUnsubscribe = () => void

type RelayTypedIpcApi = TunIpcApi &
  RelaySimpleIpcApi &
  RelaySimpleSourcesIpcApi &
  RelaySimpleConfigurationIpcApi &
  RelaySimplePublicationIpcApi & {
    relayLoginItemState(): Promise<RelayLoginItemState>
    enableAutoRun(): Promise<RelayLoginItemResult>
    disableAutoRun(): Promise<RelayLoginItemResult>
    relayShellThemeFilesImport(): Promise<RelayShellTheme[] | undefined>
    relayShellTrayIconImport(): Promise<string | undefined>
    relaySubStoreAdvancedAcquire(request: SubStoreAdvancedStart): Promise<SubStoreState>
    relaySubStoreAdvancedStart(request: SubStoreAdvancedStart): Promise<SubStoreState>
    relayIsolatedProbeTargets(profile: RelayProfileSelection): Promise<IsolatedProbeTargets>
    relayIsolatedProbePrepare(request: IsolatedProbeRequest): Promise<IsolatedProbePlan>
    relayIsolatedProbeRun(request: { evidenceId: string }): Promise<IsolatedProbeResult>
    relayIsolatedProbeCancel(request: { evidenceId: string }): Promise<boolean>
    relayIsolatedProbeCleanup(): Promise<IsolatedProbeState>
    relayIsolatedProbeState(): Promise<IsolatedProbeState>
    relayConnectionAppInfo(request: ConnectionAppInfoRequest): Promise<ConnectionAppInfo>
    relayLibraryList(): Promise<RelayLibraryInventory>
    relayLibraryChange(request: RelayLibraryChange): Promise<RelayLibraryInventory>
    relayTrafficHistoryState(): Promise<TrafficHistoryState>
    relayTrafficHistoryReadTun(): Promise<TrafficHistoryState>
    relayTrafficHistoryRecord(owner: TrafficHistoryOwner): Promise<TrafficHistoryState>
    relayTrafficHistoryStop(): Promise<TrafficHistoryState>
    relayTrafficHistoryRetry(): Promise<TrafficHistoryState>
    relayTrafficHistoryImportAuthorize(): Promise<boolean>
  }

interface SafeIpcRenderer {
  invoke: {
    <Channel extends keyof RelayTypedIpcApi>(
      channel: Channel,
      ...args: Parameters<RelayTypedIpcApi[Channel]>
    ): ReturnType<RelayTypedIpcApi[Channel]>
    (channel: string, ...args: unknown[]): Promise<unknown>
  }
  send: (channel: string, ...args: unknown[]) => void
  on: (channel: string, listener: IpcListener) => IpcUnsubscribe
  removeListener: (channel: string, listener: IpcListener) => void
  removeAllListeners: (channel: string) => void
}

interface ElectronAPI {
  ipcRenderer: SafeIpcRenderer
  process: {
    platform: NodeJS.Platform
  }
}

declare global {
  interface Window {
    relayFloatingTraffic?: ReadonlyFloatingBridge
    electron: ElectronAPI
    api: { webUtils: typeof webUtils }
  }
}
