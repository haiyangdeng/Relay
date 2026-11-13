import type { MenuItemConstructorOptions } from 'electron'
import {
  shellTrayProxyGroupStyles,
  type RelayShellTrayProxyGroupStyle
} from '../../../shared/relay/shell'
import type { LocalProxyState } from '../../../shared/relay/local-proxy'
import type { RelayStoredProfile } from '../../../shared/relay/profiles'
import type { RelayProfileSelection } from '../../../shared/relay/runtime'

export interface TrayWorkflowSnapshot {
  local: LocalProxyState
  profiles: RelayStoredProfile[]
  selectedId?: string
}
export type TrayNodeChoice = {
  instanceId: string
  configurationRevision: string
  group: string
} & ({ action: 'select'; member: string } | { action: 'automatic' })
function label(value: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 256 ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error('菜单名称未通过检查，请在工作区核对。')
  return value
}
const binding = (state: LocalProxyState): string =>
  JSON.stringify([
    state.owned,
    state.instanceId,
    state.pid,
    state.configurationRevision,
    state.profileId,
    state.phase
  ])
const ready = (state: LocalProxyState): boolean =>
  state.owned &&
  !state.pending &&
  !state.uncertain &&
  state.phase === 'running' &&
  state.traffic === 'listening' &&
  !!state.instanceId &&
  !!state.pid &&
  !!state.configurationRevision

// Opening the tray menu reads a snapshot; only clicking a choice changes state.
// Menu callbacks carry
// a generation and source/instance identity; no PID or arbitrary path is accepted.
export function createTrayWorkflows(adapters: {
  load(): Promise<TrayWorkflowSnapshot>
  local(): LocalProxyState
  showCurrentProxyInTray?: boolean
  proxyInTray?: boolean
  trayProxyGroupStyle?: RelayShellTrayProxyGroupStyle
  chooseProfile(selection: RelayProfileSelection): Promise<void>
  chooseNode(choice: TrayNodeChoice): Promise<void>
  publish(items: MenuItemConstructorOptions[]): void
  assertIdle(): void
  report(message: string): void
}) {
  let generation = 0,
    pending = false,
    disposed = false,
    showCurrentProxyInTray = adapters.showCurrentProxyInTray ?? false,
    groupStyle = adapters.trayProxyGroupStyle ?? 'default',
    proxyInTray = adapters.proxyInTray === undefined ? true : adapters.proxyInTray
  if (!shellTrayProxyGroupStyles.includes(groupStyle)) throw new Error('托盘代理组布局未支持。')
  if (typeof proxyInTray !== 'boolean') throw new Error('托盘代理组开关必须为布尔值。')
  let cached: { epoch: number; snapshot: TrayWorkflowSnapshot; render(): void } | undefined
  let opening: Promise<void> | undefined
  const waiters: (() => void)[] = []
  const present = (items: MenuItemConstructorOptions[]): void => {
    if (!disposed) adapters.publish(items)
  }
  const launch = (operation: () => Promise<void>): void => {
    void operation().catch(() => {
      if (!disposed) adapters.report('托盘操作未确认，请重新读取菜单或到工作区核对；没有自动重试。')
    })
  }
  const initial = (message = '正在读取配置…'): void => {
    cached = undefined
    present([{ label: message, enabled: false }])
  }
  const groupLabel = (snapshot: TrayWorkflowSnapshot, index: number): string => {
    const group = snapshot.local.groups[index],
      name = label(group.name)
    if (
      !showCurrentProxyInTray ||
      !ready(snapshot.local) ||
      !group.confirmed ||
      typeof group.now !== 'string' ||
      !group.members.includes(group.now)
    )
      return name
    try {
      return label(`${name} | ${label(group.now)}`)
    } catch {
      return name
    }
  }
  const invalidate = (): void => {
    ++generation
    initial('配置已变化，重新打开菜单即可刷新')
  }
  const check = (epoch: number, snapshot: TrayWorkflowSnapshot): LocalProxyState => {
    if (disposed || generation !== epoch || pending) throw new Error('菜单已失效。')
    adapters.assertIdle()
    const current = adapters.local()
    if (current.pending || current.uncertain || binding(current) !== binding(snapshot.local))
      throw new Error('本次实例已变化。')
    return current
  }
  const run = async (
    epoch: number,
    snapshot: TrayWorkflowSnapshot,
    operation: (current: LocalProxyState) => Promise<void>
  ): Promise<void> => {
    const current = check(epoch, snapshot)
    pending = true
    initial('托盘操作进行中…')
    try {
      await operation(current)
    } finally {
      pending = false
      invalidate()
      waiters.splice(0).forEach((resolve) => resolve())
    }
  }
  async function refresh(): Promise<void> {
    if (disposed || pending) throw new Error('托盘操作尚未结束。')
    adapters.assertIdle()
    pending = true
    const epoch = ++generation
    initial('正在读取本次配置与节点…')
    let failed = false
    try {
      const snapshot = structuredClone(await adapters.load())
      if (disposed || epoch !== generation) return
      if (binding(adapters.local()) !== binding(snapshot.local) || adapters.local().pending)
        throw new Error('读取期间实例已变化。')
      if (snapshot.profiles.length > 200 || snapshot.local.groups.length > 100)
        throw new Error('菜单条目过多，请使用工作区。')
      const profileItems: MenuItemConstructorOptions[] = snapshot.profiles.map((profile) => ({
        label: label(profile.name),
        type: 'radio',
        checked: snapshot.selectedId === profile.id,
        click: () =>
          launch(() =>
            run(epoch, snapshot, async () => {
              await adapters.chooseProfile({ id: profile.id, sha256: profile.sha256 })
            })
          )
      }))
      let members = 0
      const nodeItems: MenuItemConstructorOptions[] = snapshot.local.groups.map((group) => {
        members += group.members.length
        if (members > 1000 || new Set(group.members).size !== group.members.length)
          throw new Error('节点菜单过大或成员重复，请使用工作区。')
        const selectable = group.selectable === true || group.type === 'select'
        const automatic = ['url-test', 'fallback', 'smart'].includes(group.type ?? '')
        const enabled =
          ready(snapshot.local) && group.confirmed && (selectable || !!(automatic && group.fixed))
        return {
          label: label(group.name),
          enabled,
          submenu: [
            ...(automatic && group.fixed
              ? [
                  {
                    label: '恢复自动选择',
                    click: () =>
                      launch(() =>
                        run(epoch, snapshot, async (current) => {
                          const actual = current.groups.find((item) => item.name === group.name)
                          const { instanceId, configurationRevision } = snapshot.local
                          if (
                            !ready(current) ||
                            !actual?.confirmed ||
                            !['url-test', 'fallback', 'smart'].includes(actual.type ?? '') ||
                            !actual.fixed ||
                            !instanceId ||
                            !configurationRevision
                          )
                            throw new Error('自动组固定状态已变化。')
                          await adapters.chooseNode({
                            action: 'automatic',
                            instanceId,
                            configurationRevision,
                            group: group.name
                          })
                        })
                      )
                  },
                  { type: 'separator' as const }
                ]
              : []),
            ...group.members.map((member): MenuItemConstructorOptions => ({
              // Existing own-Core summaries already carry the last history
              // sample. Rendering it never initiates a health check.
              label: (() => {
                const name = label(member),
                  delay = group.health?.find((item) => item.name === member)?.delay
                return typeof delay === 'number' && Number.isSafeInteger(delay) && delay >= 0
                  ? `${name} (${delay === 0 ? 'Timeout' : `${delay}ms`})`
                  : name
              })(),
              enabled: selectable,
              type: 'radio',
              checked: group.now === member,
              click: () =>
                launch(() =>
                  run(epoch, snapshot, async (current) => {
                    const actual = current.groups.find((item) => item.name === group.name)
                    if (
                      !ready(current) ||
                      !actual?.confirmed ||
                      !actual.members.includes(member) ||
                      !(actual.selectable === true || actual.type === 'select')
                    )
                      throw new Error('组成员已变化。')
                    const { instanceId, configurationRevision } = snapshot.local
                    if (!instanceId || !configurationRevision) throw new Error('实例身份未确认。')
                    await adapters.chooseNode({
                      action: 'select',
                      instanceId,
                      configurationRevision,
                      group: group.name,
                      member
                    })
                  })
                )
            }))
          ]
        }
      })
      const render = (): void => {
        nodeItems.forEach((item, index) => {
          item.label = groupLabel(snapshot, index)
        })
        present([
          ...(!proxyInTray
            ? []
            : groupStyle === 'submenu'
              ? [
                  {
                    label: '代理组',
                    enabled: ready(snapshot.local),
                    submenu: nodeItems.length
                      ? nodeItems
                      : [{ label: '暂无可选择组', enabled: false }]
                  }
                ]
              : [...(nodeItems.length ? nodeItems : [{ label: '暂无可选择组', enabled: false }])]),
          {
            label: '订阅配置',
            submenu: profileItems.length
              ? profileItems
              : [{ label: '暂无可用配置', enabled: false }]
          }
        ])
      }
      cached = { epoch, snapshot, render }
      render()
    } catch (error) {
      failed = true
      throw error
    } finally {
      pending = false
      if (epoch !== generation || failed)
        initial(failed ? '菜单暂不可用，重新打开可重试' : '配置已变化，重新打开菜单即可刷新')
      waiters.splice(0).forEach((resolve) => resolve())
    }
  }
  const renderCached = (): void => {
    if (disposed || !cached || pending) return
    const current = adapters.local()
    if (
      cached.epoch !== generation ||
      current.pending ||
      current.uncertain ||
      ready(current) !== ready(cached.snapshot.local) ||
      binding(current) !== binding(cached.snapshot.local)
    ) {
      invalidate()
      return
    }
    cached.render()
  }
  initial()
  return {
    open(): Promise<void> {
      if (disposed) return Promise.resolve()
      if (opening) return opening
      opening = (async () => {
        if (pending) await new Promise<void>((resolve) => waiters.push(resolve))
        if (disposed) return
        try {
          await refresh()
        } catch {
          if (!disposed) initial('菜单暂不可用，重新打开可重试')
        }
      })().finally(() => {
        opening = undefined
      })
      return opening
    },
    setCurrentProxyVisible(visible: boolean): void {
      if (disposed) return
      showCurrentProxyInTray = visible
      renderCached()
    },
    setProxyGroupsVisible(visible: boolean): void {
      if (disposed) return
      if (typeof visible !== 'boolean') throw new Error('托盘代理组开关必须为布尔值。')
      proxyInTray = visible
      renderCached()
    },
    setGroupStyle(style: RelayShellTrayProxyGroupStyle): void {
      if (disposed) return
      if (!shellTrayProxyGroupStyles.includes(style)) throw new Error('托盘代理组布局未支持。')
      groupStyle = style
      renderCached()
    },
    refresh,
    invalidate,
    isBusy: (): boolean => pending,
    whenIdle: (): Promise<void> =>
      pending ? new Promise((resolve) => waiters.push(resolve)) : Promise.resolve(),
    dispose(): void {
      disposed = true
      cached = undefined
      ++generation
    }
  }
}
