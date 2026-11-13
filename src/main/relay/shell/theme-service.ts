import { randomUUID } from 'crypto'
import { performance } from 'perf_hooks'
import type { LocalProxyState } from '../../../shared/relay/local-proxy'
import { shellThemeLibrary, type RelayShellTheme } from '../../../shared/relay/shell'
import { officialThemeURL, type OnlineThemeResult } from '../../../shared/relay/shell-themes'
import { admitOnlineThemeArchive, type OnlineThemeAdmission } from './theme-admission'

export function createOnlineThemeService(adapters: {
  local(): LocalProxyState
  assertAvailable(): void
  confirm(owner: {
    instanceId: string
    configurationRevision: string
    httpPort: number
  }): Promise<boolean>
  download(proxyPort: number, signal: AbortSignal): Promise<Buffer>
  invalidated?(): void
  now?(): number
  monotonic?(): number
}) {
  type Owner = { instanceId: string; configurationRevision: string; httpPort: number; pid: number }
  let pending: AbortController | undefined
  let ready:
    | {
        id: string
        owner: Owner
        issuedWall: number
        issuedMono: number
        admission: OnlineThemeAdmission
      }
    | undefined
  let activeOwner: Owner | undefined
  const now = (): number => adapters.now?.() ?? Date.now()
  const monotonic = (): number => adapters.monotonic?.() ?? performance.now()
  const owner = (): Owner => {
    const state = adapters.local()
    if (
      !state.owned ||
      state.pending ||
      state.uncertain ||
      state.phase !== 'running' ||
      state.traffic !== 'listening' ||
      !state.instanceId ||
      !state.configurationRevision ||
      !Number.isSafeInteger(state.pid) ||
      !state.pid ||
      !Number.isSafeInteger(state.httpPort) ||
      !state.httpPort ||
      state.httpPort < 1024 ||
      state.httpPort > 65535
    )
      throw new Error('请先明确启动并核对本次自有普通HTTP实例。')
    return {
      instanceId: state.instanceId,
      configurationRevision: state.configurationRevision,
      httpPort: state.httpPort,
      pid: state.pid
    }
  }
  const check = (expected: Owner): void => {
    adapters.assertAvailable()
    if (JSON.stringify(owner()) !== JSON.stringify(expected))
      throw new Error('获取期间本次实例或配置已变化。')
  }
  const cancel = (): void => {
    const changed = !!pending || !!ready
    pending?.abort()
    ready = undefined
    if (changed) adapters.invalidated?.()
  }
  return {
    cancel,
    invalidateIfOwnerChanged(): void {
      if (!ready && !pending) return
      const bound = ready?.owner ?? activeOwner
      try {
        if (bound) check(bound)
      } catch {
        cancel()
      }
    },
    async acquire(): Promise<OnlineThemeResult> {
      if (pending) throw new Error('主题获取尚未结束。')
      adapters.assertAvailable()
      const expected = owner(),
        controller = new AbortController()
      ready = undefined
      pending = controller
      activeOwner = expected
      try {
        if (!(await adapters.confirm(expected))) return { status: 'cancelled' }
        if (controller.signal.aborted) return { status: 'cancelled' }
        check(expected)
        const bytes = await adapters.download(expected.httpPort, controller.signal)
        if (controller.signal.aborted) return { status: 'cancelled' }
        check(expected)
        const admission = admitOnlineThemeArchive(bytes),
          id = randomUUID()
        check(expected)
        ready = { id, owner: expected, issuedWall: now(), issuedMono: monotonic(), admission }
        return {
          status: 'ready',
          acquisitionId: id,
          sourceURL: officialThemeURL,
          archiveSHA256: admission.archiveSHA256,
          archiveSize: admission.archiveSize,
          candidates: admission.candidates.map(({ path, name, size, sha256 }) => ({
            path,
            name,
            size,
            sha256
          })),
          unsupported: admission.unsupported.map((item) => ({ ...item }))
        }
      } catch (error) {
        if (controller.signal.aborted) return { status: 'cancelled' }
        throw error
      } finally {
        if (pending === controller) {
          pending = undefined
          activeOwner = undefined
        }
      }
    },
    draft(input: unknown): RelayShellTheme[] {
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'acquisitionId,path,themes'
      )
        throw new Error('主题草稿消息无效。')
      const request = input as Record<string, unknown>
      if (!ready || pending || request.acquisitionId !== ready.id)
        throw new Error('主题候选已失效，请重新获取。')
      const wall = now(),
        mono = monotonic()
      if (
        !Number.isFinite(wall) ||
        !Number.isFinite(mono) ||
        wall < ready.issuedWall ||
        mono < ready.issuedMono ||
        wall - ready.issuedWall >= 300000 ||
        mono - ready.issuedMono >= 300000
      ) {
        cancel()
        throw new Error('主题候选已失效，请重新获取。')
      }
      try {
        check(ready.owner)
      } catch (error) {
        cancel()
        throw error
      }
      const candidate = ready.admission.candidates.find((item) => item.path === request.path)
      if (!candidate) throw new Error('主题候选不存在。')
      const themes = shellThemeLibrary(request.themes)
      const identity = (name: string): string => name.normalize('NFC').toLocaleLowerCase('en-US')
      if (themes.some((theme) => identity(theme.name) === identity(candidate.name)))
        throw new Error('同名主题已存在，未覆盖原方案。')
      return shellThemeLibrary([
        ...themes,
        { id: randomUUID(), name: candidate.name, css: candidate.css }
      ])
    }
  }
}
