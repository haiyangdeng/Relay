import { createRequire } from 'module'
import { randomUUID } from 'crypto'
import {
  guardManagementSnapshot,
  type GuardManagementAction,
  type GuardManagementSnapshot
} from '../../../shared/relay/guard-management'

interface GuardAddon {
  request(json: string): Promise<string>
  invalidateIntents(): void
  terminalLease?(json: string): Promise<string>
}
export class GuardNativeUnavailable extends Error {}
export interface GuardNativeBridge {
  request(
    action: Exclude<GuardManagementAction, 'prepare'>,
    assertCurrent?: () => void
  ): Promise<GuardManagementSnapshot>
  bind(
    input: {
      instanceID: string
      configuration: string
      pid: number
    },
    assertCurrent?: () => void,
    onSubmitted?: () => void
  ): Promise<GuardManagementSnapshot>
  verifyScoped(input?: {
    instanceID: string
    configuration: string
    pid: number
  }): Promise<GuardManagementSnapshot>
  revokeScoped(): Promise<GuardManagementSnapshot>
  invalidateIntents(): void
  pending(): boolean
}

// Main-only fixed resource inspector. Renderer cannot supply loader arguments.
export function createGuardNativeBridge(adapters: {
  inspect(): Promise<{ path: string; trusted: true; resourceSHA256: string }>
  require?(path: string): unknown
}): GuardNativeBridge & { terminalLease(json: string): Promise<string> } {
  let addon: GuardAddon | undefined,
    loaded: string | undefined,
    inFlight = 0
  const load = async (): Promise<GuardAddon> => {
    let resource: Awaited<ReturnType<typeof adapters.inspect>>
    try {
      resource = await adapters.inspect()
    } catch {
      throw new GuardNativeUnavailable('原生过滤管理发布资源不可用。')
    }
    if (
      !resource ||
      resource.trusted !== true ||
      !resource.path.startsWith('/') ||
      !resource.path.endsWith('/RelayGuard.node') ||
      resource.path.includes('\0') ||
      !/^[a-f0-9]{64}$/u.test(resource.resourceSHA256)
    )
      throw new GuardNativeUnavailable('当前原生过滤管理资源尚未通过发布身份核验。')
    const identity = resource.path + ':' + resource.resourceSHA256
    if (loaded && loaded !== identity)
      throw new GuardNativeUnavailable('已加载宿主与当前签名资源不同，请保留现场。')
    if (!addon) {
      let value: unknown
      try {
        value = (adapters.require ?? createRequire(import.meta.url))(resource.path)
      } catch {
        throw new GuardNativeUnavailable('原生过滤管理宿主未能加载。')
      }
      if (
        !value ||
        typeof value !== 'object' ||
        typeof (value as Partial<GuardAddon>).request !== 'function' ||
        typeof (value as Partial<GuardAddon>).invalidateIntents !== 'function'
      )
        throw new GuardNativeUnavailable('原生过滤管理接口未配对。')
      addon = value as GuardAddon
      loaded = identity
    }
    return addon
  }
  const send = async (
    action: string,
    input?: { instanceID: string; configuration: string; pid: number },
    assertCurrent?: () => void,
    onSubmitted?: () => void
  ): Promise<GuardManagementSnapshot> => {
    ++inFlight
    try {
      // The already loaded host may only be reused to remove its own proof.
      // A changed resource must never strand an existing proof during cleanup.
      const current =
          (action === 'revoke' || action === 'revokeScopedCore') && addon ? addon : await load(),
        id = randomUUID()
      assertCurrent?.()
      // Native system approval has no artificial timeout or retry. The main
      // process retains the addon/controller and blocks exit while pending.
      const request = JSON.stringify({ version: 1, id, action, ...input })
      onSubmitted?.()
      const text = await current.request(request)
      if (typeof text !== 'string' || Buffer.byteLength(text) > 16384)
        throw new Error('过滤管理回执过大。')
      const raw: unknown = JSON.parse(text)
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Error('过滤管理回执未知。')
      const {
        version,
        id: receivedID,
        action: receivedAction,
        ...snapshot
      } = raw as Record<string, unknown>
      if (version !== 1 || receivedID !== id || receivedAction !== action)
        throw new Error('过滤管理回执不属于本次请求。')
      const result = guardManagementSnapshot(snapshot)
      // The binding coordinator inspects a matching receipt before its final
      // intent check so cleanup can distinguish an admitted proof from a refusal.
      if (action !== 'bind') assertCurrent?.()
      return result
    } finally {
      --inFlight
    }
  }
  return {
    async terminalLease(json) {
      const action: unknown = JSON.parse(json)?.action
      const current = (action === 'close' || action === 'stop') && addon ? addon : await load()
      if (typeof current.terminalLease !== 'function')
        throw new GuardNativeUnavailable('当前宿主没有终端租约接口。')
      return current.terminalLease(json)
    },
    pending: () => inFlight > 0,
    invalidateIntents: () => addon?.invalidateIntents(),
    request: (action, assertCurrent) => send(action, undefined, assertCurrent),
    bind: (input, assertCurrent, onSubmitted) => send('bind', input, assertCurrent, onSubmitted),
    verifyScoped: (input) => send(input ? 'verifyScopedCore' : 'scopedCoreStatus', input),
    revokeScoped: () => send('revokeScopedCore')
  }
}
