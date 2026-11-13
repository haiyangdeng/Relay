import type { RelayCoreMode } from '../../../shared/relay/core'
import { startOwnedCore } from './owned-runtime'
import { isolatedCoreConfiguration } from './configuration'

export { coreEnvironment, isolatedCoreConfiguration } from './configuration'
export interface RelayIsolatedCore {
  readonly pid: number
  readonly version: string
  readonly directory: string
  readonly socket: string
  state(): 'running' | 'stopping' | 'stopped' | 'unexpectedExit'
  read(endpoint: 'version' | 'configs'): Promise<Record<string, unknown>>
  stop(): Promise<void>
}
export async function startIsolatedCore(
  resourceRoot: string,
  mode: RelayCoreMode = 'rule',
  registerCleanup?: (stop: () => Promise<void>) => void
): Promise<RelayIsolatedCore> {
  return startOwnedCore(
    resourceRoot,
    JSON.stringify(isolatedCoreConfiguration(mode)),
    'inert',
    registerCleanup
  )
}
