import { profileSelection, type RelayProfileSelection } from '../../shared/relay/runtime'
import { validateCoreMode } from '../../shared/relay/core'
import { healthURL } from '../../shared/relay/health'
import { stripProfileControls, type RelayStoredProfile } from '../../shared/relay/profiles'
import type { ProfileStore } from './profiles/store'
import type { createLocalProxyService } from './core/local-proxy-service'

type Item = Record<string, unknown>
const object = (value: unknown): value is Item =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string =>
  typeof value === 'string' &&
  !!value.trim() &&
  value.length <= 256 &&
  stripProfileControls(value) === value
const channels = new Set([
  'getControledMihomoConfig',
  'patchControledMihomoConfig',
  'patchMihomoConfig',
  'mihomoVersion',
  'mihomoProxies',
  'mihomoGroups',
  'mihomoProxyProviders',
  'mihomoRules',
  'mihomoChangeProxy',
  'mihomoProxyDelay',
  'mihomoUnfixedProxy',
  'mihomoCloseConnection',
  'mihomoCloseAllConnections',
  'getProfileConfig',
  'getCurrentProfileItem',
  'getProfileItem',
  'getProfileStr',
  'changeCurrentProfile',
  'getRuntimeConfig',
  'getRuntimeConfigStr'
])
export function createClashBackend(adapters: {
  local: Pick<
    ReturnType<typeof createLocalProxyService>,
    | 'state'
    | 'inspectLive'
    | 'action'
    | 'whenIdle'
    | 'connections'
    | 'logs'
    | 'closeConnection'
    | 'closeAllConnections'
  > &
    Partial<Pick<ReturnType<typeof createLocalProxyService>, 'prepareReload' | 'reload'>>
  profiles: Pick<ProfileStore, 'read' | 'list'>
  notify(): void
  readSelection?(): Promise<RelayProfileSelection | undefined>
  rememberSelection?(selection: RelayProfileSelection): Promise<void>
  beforeProfileChange?(): Promise<void>
}) {
  let selected: RelayProfileSelection | undefined
  let loaded = false,
    loading: Promise<void> | undefined,
    profileChanging = false,
    selectionEpoch = 0
  const selectionWaiters: (() => void)[] = []
  const selectionIdle = (): void => {
    if (!profileChanging && !loading) selectionWaiters.splice(0).forEach((resolve) => resolve())
  }
  const loadSelection = (): Promise<void> => {
    if (loaded || adapters.local.state().owned) return Promise.resolve()
    if (loading) return loading
    const epoch = selectionEpoch
    loading = (async () => {
      const value = await adapters.readSelection?.()
      if (value) await adapters.profiles.read(value)
      if (epoch === selectionEpoch) {
        selected = value
        loaded = true
      }
    })().finally(() => {
      loading = undefined
      selectionIdle()
    })
    return loading
  }
  let probes: Promise<unknown> = Promise.resolve(),
    queuedProbes = 0
  const profileItem = (profile: RelayStoredProfile) => ({
    id: profile.id,
    name: profile.name,
    type: 'local' as const,
    updated: Date.parse(profile.createdAt) || 0
  })
  const profile = async (id: unknown) => {
    if (typeof id !== 'string' || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(id))
      throw new Error('请选择自有配置ID。')
    const item = (await adapters.profiles.list()).profiles.find((p) => p.id === id)
    if (!item) throw new Error('配置副本不可用，请重新读取。')
    return adapters.profiles.read({ id: item.id, sha256: item.sha256 })
  }
  const currentId = (): string | undefined =>
    adapters.local.state().owned ? adapters.local.state().profileId : selected?.id
  const instance = (): string => {
    const state = adapters.local.state()
    if (
      !state.instanceId ||
      state.phase !== 'running' ||
      state.traffic !== 'listening' ||
      state.pending
    )
      throw new Error('请先明确启动本次自有HTTP代理，并等待当前操作结束。')
    return state.instanceId
  }
  const observedInstance = (target: unknown): void => {
    if (
      !object(target) ||
      Object.keys(target).sort().join(',') !== 'configurationRevision,instanceId'
    )
      throw new Error('连接快照身份无效，请重新读取。')
    const current = adapters.local.state()
    if (
      typeof target.instanceId !== 'string' ||
      target.instanceId !== instance() ||
      target.configurationRevision !== current.configurationRevision
    )
      throw new Error('本次实例或配置已变化，请重新读取连接。')
  }
  return {
    invalidateSelection(): void {
      if (profileChanging || loading || adapters.local.state().owned)
        throw new Error('当前配置选择或实例尚未结束。')
      ++selectionEpoch
      selected = undefined
      loaded = false
      adapters.notify()
    },
    isBusy: (): boolean => profileChanging || !!loading,
    whenIdle: (): Promise<void> =>
      profileChanging || loading
        ? new Promise((resolve) => selectionWaiters.push(resolve))
        : Promise.resolve(),
    handles: (channel: string): boolean => channels.has(channel),
    async invoke(channel: string, args: unknown[]): Promise<unknown> {
      if (!channels.has(channel)) throw new Error('此Clash能力尚未接入。')
      if (!Array.isArray(args) || args.length > 3) throw new Error('调用参数无效。')
      const none = (): void => {
        if (args.length && !(args.length === 1 && args[0] === undefined))
          throw new Error('本次只读接口不接受参数。')
      }
      if (channel === 'getProfileConfig') {
        if (args.length > 1 || (args[0] !== undefined && typeof args[0] !== 'boolean'))
          throw new Error('配置列表参数无效。')
        await loadSelection()
        const list = await adapters.profiles.list()
        return { current: currentId(), items: list.profiles.map(profileItem) }
      }
      if (
        channel === 'getCurrentProfileItem' ||
        channel === 'getProfileItem' ||
        channel === 'getProfileStr'
      ) {
        if (channel === 'getCurrentProfileItem') none()
        else if (args.length !== 1) throw new Error('请选择一个配置ID。')
        if (channel === 'getProfileStr' && typeof args[0] !== 'string')
          return (await adapters.profiles.read(profileSelection(args[0]))).text
        if (
          channel === 'getCurrentProfileItem' ||
          (channel === 'getProfileItem' && args[0] === undefined)
        )
          await loadSelection()
        const id =
          channel === 'getCurrentProfileItem'
            ? currentId()
            : channel === 'getProfileItem'
              ? (args[0] ?? currentId())
              : args[0]
        if (id === undefined) {
          if (channel === 'getProfileStr') throw new Error('请选择一个配置ID。')
          return null
        }
        const stored = await profile(id)
        return channel === 'getProfileStr' ? stored.text : profileItem(stored.profile)
      }
      if (channel === 'changeCurrentProfile') {
        if (profileChanging) throw new Error('请等待当前配置选择或热载结束。')
        profileChanging = true
        ++selectionEpoch
        try {
          if (args.length !== 1) throw new Error('请选择一个配置ID。')
          const stored =
            typeof args[0] === 'string'
              ? await profile(args[0])
              : await adapters.profiles.read(profileSelection(args[0]))
          const state = adapters.local.state()
          if (state.owned || state.pending) {
            if (
              !adapters.local.prepareReload ||
              !adapters.local.reload ||
              state.pending ||
              state.phase !== 'running' ||
              !state.httpPort
            )
              throw new Error('本次代理仍在运行且未具备可确认的热载条件；没有隐式停止或重启。')
            if (state.profileId === stored.profile.id) return
            await adapters.beforeProfileChange?.()
            const preparation = await adapters.local.prepareReload({
              profile: { id: stored.profile.id, sha256: stored.profile.sha256 },
              httpPort: state.httpPort,
              ...(state.ports ? { ports: state.ports } : {}),
              ...(state.dedicated
                ? {
                    dedicated: {
                      route: state.dedicated.route,
                      ...(state.dedicated.httpPort ? { httpPort: state.dedicated.httpPort } : {}),
                      ...(state.dedicated.socksPort ? { socksPort: state.dedicated.socksPort } : {})
                    }
                  }
                : {}),
              resolverMode: state.resolution?.mode ?? 'off'
            })
            const result = await adapters.local.reload({ evidenceId: preparation.evidenceId })
            adapters.notify()
            if (result.status === 'cancelled') return
            if (result.status !== 'reloaded')
              throw new Error('热载结果未确认，保留本次实例和证据；没有自动重启。')
          } else await adapters.beforeProfileChange?.()
          selected = { id: stored.profile.id, sha256: stored.profile.sha256 }
          loaded = true
          try {
            await adapters.rememberSelection?.(selected)
          } finally {
            adapters.notify()
          }
          return
        } finally {
          profileChanging = false
          selectionIdle()
        }
      }
      if (channel === 'patchControledMihomoConfig' || channel === 'patchMihomoConfig') {
        if (args.length !== 1 || !object(args[0]) || Object.keys(args[0]).join(',') !== 'mode')
          throw new Error('当前只接通本次核心的mode；端口／系统代理／TUN等另行配置。')
        const result = await adapters.local.action({
          action: 'mode',
          instanceId: instance(),
          mode: validateCoreMode(args[0].mode)
        })
        adapters.notify()
        if (!['modeChanged', 'refreshed', 'cancelled'].includes(result.status))
          throw new Error('模式切换结果未确认，请重新读取；没有自动重试或重启。')
        return
      }
      if (channel === 'mihomoChangeProxy' || channel === 'mihomoUnfixedProxy') {
        const select = channel === 'mihomoChangeProxy'
        if (args.length !== (select ? 2 : 1) || !text(args[0]) || (select && !text(args[1])))
          throw new Error('组或成员参数无效。')
        const result = await adapters.local.action(
          select
            ? { action: 'select', instanceId: instance(), group: args[0], member: args[1] }
            : { action: 'automatic', instanceId: instance(), group: args[0] }
        )
        adapters.notify()
        if (!['selected', 'automatic'].includes(result.status))
          throw new Error('组选取结果未确认，请重新读取。')
        return
      }
      if (channel === 'mihomoProxyDelay') {
        if (args.length < 1 || !text(args[0]) || (args[2] !== undefined && !text(args[2])))
          throw new Error('测速节点参数无效。')
        const target = healthURL(args[1] ?? 'https://www.gstatic.com/generate_204')
        const state = adapters.local.state(),
          id = state.instanceId,
          configurationRevision = state.configurationRevision
        if (!id || state.phase !== 'running' || state.traffic !== 'listening' || queuedProbes >= 64)
          throw new Error('本次核心未就绪或测速队列已满。')
        const member = args[0],
          provider = args[2]
        ++queuedProbes
        const run = async () => {
          await adapters.local.whenIdle()
          if (instance() !== id) throw new Error('实例已改变，丢弃旧测速请求。')
          if (adapters.local.state().configurationRevision !== configurationRevision)
            throw new Error('配置已改变，丢弃旧测速请求。')
          const result = await adapters.local.action({
            action: 'probe',
            instanceId: id,
            member,
            url: target,
            ...(provider === undefined ? {} : { provider })
          })
          adapters.notify()
          if (result.status !== 'tested' || !result.delay)
            throw new Error(
              result.status === 'cancelled'
                ? '已取消本次测速。'
                : '本次测速失败或未确认；没有直连重试。'
            )
          return { delay: result.delay }
        }
        const task = probes.then(run, run).finally(() => {
          --queuedProbes
        })
        probes = task.catch(() => undefined)
        return task
      }
      if (channel === 'mihomoCloseConnection') {
        if (![1, 2].includes(args.length) || !text(args[0])) throw new Error('连接标识参数无效。')
        if (args.length === 2) observedInstance(args[1])
        await adapters.local.closeConnection(args[0])
        adapters.notify()
        return
      }
      if (channel === 'mihomoCloseAllConnections') {
        if (args.length === 1 && args[0] !== undefined) observedInstance(args[0])
        else none()
        await adapters.local.closeAllConnections()
        adapters.notify()
        return
      }
      const includeHidden = channel === 'mihomoGroups'
      if (includeHidden) {
        if (args.length > 1 || (args[0] !== undefined && typeof args[0] !== 'boolean'))
          throw new Error('代理组参数无效。')
      } else none()
      const live = await adapters.local.inspectLive()
      if (channel === 'getControledMihomoConfig')
        return live?.config ?? { port: 0, tun: { enable: false } }
      if (channel === 'mihomoVersion')
        return live?.version ?? { version: 'Not running — Relay', meta: true }
      if (channel === 'mihomoProxies') return live?.proxies ?? { proxies: {} }
      if (channel === 'mihomoProxyProviders') return live?.providers ?? { providers: {} }
      if (channel === 'mihomoRules') return live?.rules ?? { rules: [] }
      if (channel === 'getRuntimeConfig' || channel === 'getRuntimeConfigStr') {
        if (!live) throw new Error('没有已确认运行的本次配置。')
        return channel === 'getRuntimeConfig' ? live.runtime : JSON.stringify(live.runtime, null, 2)
      }
      if (channel === 'mihomoGroups') {
        if (!live || live.config.mode === 'direct') return []
        if (!object(live.proxies.proxies) || !object(live.providers.providers))
          throw new Error('核心组或提供者结构未确认。')
        const nodes = new Map(Object.entries(live.proxies.proxies))
        for (const provider of Object.values(live.providers.providers)) {
          if (!object(provider) || !Array.isArray(provider.proxies))
            throw new Error('提供者节点未完整读取。')
          for (const node of provider.proxies)
            if (object(node) && text(node.name)) nodes.set(node.name, node)
        }
        const names = Array.isArray(live.runtime['proxy-groups'])
          ? live.runtime['proxy-groups'].map((g) => (object(g) ? g.name : undefined))
          : []
        if (!names.includes('GLOBAL')) names.push('GLOBAL')
        if (live.config.mode === 'global') {
          const index = names.indexOf('GLOBAL')
          names.splice(index, 1)
          names.unshift('GLOBAL')
        }
        return names
          .map((name) => {
            const group = typeof name === 'string' ? nodes.get(name) : undefined
            if (!object(group)) throw new Error('实际代理组缺失；没有删减后继续。')
            return group
          })
          .filter((group) => args[0] === true || !group.hidden)
          .map((group) => {
            if (!object(group) || !Array.isArray(group.all)) throw new Error('实际组成员未确认。')
            return {
              ...group,
              all: group.all.map((name) => {
                if (typeof name !== 'string' || !nodes.has(name))
                  throw new Error('实际组成员缺少节点记录；没有删减成员。')
                return nodes.get(name)
              })
            }
          })
      }
      throw new Error('本次请求未完成。')
    }
  }
}
