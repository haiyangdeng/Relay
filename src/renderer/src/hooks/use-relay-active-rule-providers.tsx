import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { profileSelection, type RelayProfileSelection } from '../../../shared/relay/runtime'
import { resourceDescriptor, type ResourceInfo } from '../../../shared/relay/resources'
import {
  tunRuleProviderName,
  type TunRuleProviderEntry,
  type TunRuleProvidersResult,
  type TunRuleProvidersSnapshot
} from '../../../shared/relay/tun-rule-providers'

const isolatedSessions = new Set<string>(),
  isolationListeners = new Set<() => void>()
let isolationRevision = 0
const isolate = (sessionId: string): void => {
  if (isolatedSessions.has(sessionId)) return
  isolatedSessions.add(sessionId)
  isolationRevision++
  isolationListeners.forEach((listener) => listener())
}
const subscribeIsolation = (listener: () => void) => {
  isolationListeners.add(listener)
  return () => {
    isolationListeners.delete(listener)
  }
}
const object = (raw: unknown): raw is Record<string, unknown> =>
  !!raw && typeof raw === 'object' && !Array.isArray(raw)
const hash = (raw: unknown): raw is string => typeof raw === 'string' && /^[a-f0-9]{64}$/u.test(raw)
const integer = (raw: unknown, max = Number.MAX_SAFE_INTEGER): raw is number =>
  typeof raw === 'number' && Number.isSafeInteger(raw) && raw >= 0 && raw <= max
const kind = (raw: unknown): raw is TunRuleProviderEntry['kind'] =>
  raw === 'rule-yaml' || raw === 'rule-text' || raw === 'rule-mrs'

export function checkedRuleProvidersSnapshot(
  raw: unknown,
  owner: string
): TunRuleProvidersSnapshot {
  if (
    !object(raw) ||
    !['snapshot', 'updated', 'unchanged'].includes(String(raw.status)) ||
    raw.sessionId !== owner ||
    !object(raw.snapshot)
  )
    throw new Error('运行文件回执未匹配。')
  const value = raw.snapshot
  if (
    value.sessionId !== owner ||
    !hash(value.configurationRevision) ||
    !hash(value.generationSHA256) ||
    !Array.isArray(value.providers) ||
    value.providers.length > 200 ||
    !Array.isArray(value.groups) ||
    value.groups.length > 200
  )
    throw new Error('运行文件回执范围无效。')
  const providers: TunRuleProviderEntry[] = value.providers.map((item: unknown) => {
    if (
      !object(item) ||
      !kind(item.kind) ||
      !['domain', 'ipcidr', 'classical'].includes(String(item.behavior)) ||
      (item.kind === 'rule-mrs' && item.behavior === 'classical') ||
      !hash(item.fileSHA256) ||
      !integer(item.bytes, 128 * 1024 * 1024) ||
      !item.bytes ||
      !integer(item.ruleCount)
    )
      throw new Error('提供者公开条目无效。')
    return {
      name: tunRuleProviderName(item.name),
      kind: item.kind,
      behavior: item.behavior as TunRuleProviderEntry['behavior'],
      fileSHA256: item.fileSHA256,
      bytes: item.bytes,
      ruleCount: item.ruleCount
    }
  })
  const names = new Set(providers.map((row) => row.name)),
    seen = new Set<string>()
  if (names.size !== providers.length) throw new Error('提供者名称重复。')
  const groups = value.groups.map((group: unknown) => {
    if (!Array.isArray(group) || !group.length || group.length > 200)
      throw new Error('关联组无效。')
    return group.map((rawName: unknown) => {
      const name = tunRuleProviderName(rawName)
      if (!names.has(name) || seen.has(name)) throw new Error('关联组与完整列表不匹配。')
      seen.add(name)
      return name
    })
  })
  if (seen.size !== names.size) throw new Error('关联组缺少提供者。')
  return {
    sessionId: owner,
    configurationRevision: value.configurationRevision,
    generationSHA256: value.generationSHA256,
    providers,
    groups
  }
}
function cachedRules(raw: unknown): ResourceInfo[] {
  if (!object(raw) || !Array.isArray(raw.resources) || raw.resources.length > 10000)
    throw new Error('缓存列表未确认。')
  return raw.resources.flatMap((item: unknown) => {
    if (!object(item)) throw new Error('缓存条目无效。')
    if (!kind(item.kind)) return []
    const descriptor = resourceDescriptor({
        name: item.name,
        kind: item.kind,
        behavior: item.behavior,
        selector: item.selector
      }),
      selected = profileSelection({ id: item.id, sha256: item.sha256 })
    if (
      !integer(item.size, 128 * 1024 * 1024) ||
      !item.size ||
      typeof item.createdAt !== 'string' ||
      item.integrity !== 'notChecked'
    )
      throw new Error('缓存摘要未确认。')
    return [
      {
        ...descriptor,
        ...selected,
        size: item.size,
        createdAt: item.createdAt,
        integrity: 'notChecked' as const
      }
    ]
  })
}
type Work = { epoch: number; owner?: string; hash: string; historyKey: unknown }
type QueuedRuleReplacement = { provider: string; resource: ResourceInfo }
type ReplaceRule = (
  provider: string,
  resource: RelayProfileSelection,
  snapshot: TunRuleProvidersSnapshot
) => Promise<TunRuleProvidersResult | undefined>

export async function replaceQueuedRuleProviders(
  plan: readonly QueuedRuleReplacement[],
  snapshot: TunRuleProvidersSnapshot,
  replace: ReplaceRule,
  canContinue: () => boolean
) {
  const groups = new Set<string[]>()
  for (const { provider, resource } of plan) {
    const row = snapshot.providers.find((item) => item.name === provider),
      group = snapshot.groups.find((names) => names.includes(provider))
    if (
      !row ||
      !group ||
      groups.has(group) ||
      row.kind !== resource.kind ||
      row.behavior !== resource.behavior
    )
      throw new Error('列表必须对应不同的当前运行文件，并选择匹配的私有规则缓存。')
    groups.add(group)
  }
  const completed: string[] = []
  let current = snapshot
  for (const { provider, resource } of plan) {
    if (!canContinue()) return { completed, stopped: { provider, status: 'cancelled' } }
    const output = await replace(provider, { id: resource.id, sha256: resource.sha256 }, current)
    if (!output || (output.status !== 'updated' && output.status !== 'unchanged'))
      return { completed, stopped: { provider, status: output?.status ?? 'cancelled' } }
    current = output.snapshot
    completed.push(provider)
  }
  return { completed, snapshot: current }
}

const resultStatuses = new Set([
  'snapshot',
  'updated',
  'unchanged',
  'busy',
  'cancelled',
  'uncertain',
  'stale',
  'expired',
  'unsupported',
  'unavailable'
])
export function useRelayActiveRuleProviders({
  busy,
  onBusy,
  tunSessionId
}: {
  busy: boolean
  onBusy(value: boolean): void
  tunSessionId?: string
}) {
  useSyncExternalStore(
    subscribeIsolation,
    () => isolationRevision,
    () => 0
  )
  const [snapshot, setSnapshot] = useState<TunRuleProvidersSnapshot>(),
    [rows, setRows] = useState<TunRuleProviderEntry[]>([]),
    [groups, setGroups] = useState<string[][]>([]),
    [resources, setResources] = useState<ResourceInfo[]>([]),
    [provider, setProvider] = useState(''),
    [resourceId, setResourceId] = useState(''),
    [queue, setQueue] = useState<QueuedRuleReplacement[]>([]),
    [filter, setFilter] = useState(''),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState(''),
    [readAt, setReadAt] = useState<number>(),
    mounted = useRef(false),
    epoch = useRef(0),
    work = useRef<Work | undefined>(undefined),
    session = useRef(tunSessionId),
    lastSession = useRef(tunSessionId),
    currentBusy = useRef(busy),
    callback = useRef(onBusy),
    ownsBusy = useRef(false)
  session.current = tunSessionId
  currentBusy.current = busy
  callback.current = onBusy
  const clear = (): void => {
    ++epoch.current
    setSnapshot(undefined)
    setRows([])
    setGroups([])
    setResources([])
    setProvider('')
    setResourceId('')
    setQueue([])
    setFilter('')
    setReadAt(undefined)
    setNotice('界面范围已失效；在途操作等待真实收尾，未知会话隔离不因清空界面而解除。')
  }
  useEffect(() => {
    mounted.current = true
    const invalidateEpoch = () => {
        ++epoch.current
      },
      invalidate = () => clear(),
      visibility = () => {
        if (document.hidden) clear()
      },
      remove = window.electron.ipcRenderer.on('relayBackupPreparationsInvalidated', invalidate),
      restored = window.electron.ipcRenderer.on('relayDataRestored', invalidate),
      runtime = window.electron.ipcRenderer.on('relayTunUpdated', () => {
        // Our own operation emits busy hints. The service still checks held
        // owner; a changed parent session invalidates the reply independently.
        if (!work.current) {
          ++epoch.current
          setSnapshot(undefined)
        }
      })
    window.addEventListener('hashchange', invalidate)
    document.addEventListener('visibilitychange', visibility)
    return () => {
      mounted.current = false
      invalidateEpoch()
      remove()
      restored()
      runtime()
      window.removeEventListener('hashchange', invalidate)
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [])
  useEffect(() => {
    if (lastSession.current !== tunSessionId) {
      lastSession.current = tunSessionId
      clear()
    }
  }, [tunSessionId])
  const alive = (op: Work) =>
    mounted.current &&
    work.current === op &&
    epoch.current === op.epoch &&
    session.current === op.owner &&
    window.location.hash === op.hash &&
    window.history.state?.key === op.historyKey &&
    !document.hidden
  const run = async (action: 'read' | 'cache' | 'replace' | 'replaceQueue') => {
    if (currentBusy.current || work.current) return
    const owner = session.current,
      selected = rows.find((row) => row.name === provider),
      cached = resources.find((item) => item.id === resourceId),
      held = snapshot
    if (action !== 'cache' && (!owner || isolatedSessions.has(owner))) return
    if (action === 'replaceQueue' && (!held || held.sessionId !== owner || !queue.length)) return
    if (
      action === 'replace' &&
      (!held ||
        held.sessionId !== owner ||
        !selected ||
        !cached ||
        cached.kind !== selected.kind ||
        cached.behavior !== selected.behavior)
    )
      return
    const op = {
      epoch: epoch.current,
      owner,
      hash: window.location.hash,
      historyKey: window.history.state?.key as unknown
    }
    work.current = op
    ownsBusy.current = true
    setPending(true)
    let replacingInvoked = false,
      completedInQueue = 0
    const readReceipt = (output: unknown, expectedRevision?: string): TunRuleProvidersResult => {
      if (
        !owner ||
        !object(output) ||
        output.sessionId !== owner ||
        !resultStatuses.has(String(output.status))
      )
        throw new Error('会话回执未匹配。')
      const status = output.status as TunRuleProvidersResult['status']
      if (status === 'uncertain') isolate(owner)
      if (status !== 'snapshot' && status !== 'updated' && status !== 'unchanged')
        return { status, sessionId: owner }
      const next = checkedRuleProvidersSnapshot(output, owner)
      if (
        expectedRevision &&
        (status === 'snapshot' || next.configurationRevision !== expectedRevision)
      )
        throw new Error('替换回执未匹配原配置修订。')
      return { status, sessionId: owner, snapshot: next }
    }
    const replace: ReplaceRule = async (name, resource, basis) => {
      if (!alive(op)) return
      replacingInvoked = true
      const output = readReceipt(
        await window.electron.ipcRenderer.invoke('relayTunRuleProviderReplace', {
          sessionId: owner,
          configurationRevision: basis.configurationRevision,
          expectedGenerationSHA256: basis.generationSHA256,
          provider: name,
          resource
        }),
        basis.configurationRevision
      )
      replacingInvoked = false
      return output
    }
    const showSnapshot = (next: TunRuleProvidersSnapshot): void => {
      setSnapshot(next)
      setRows(next.providers)
      setGroups(next.groups)
      setReadAt(Date.now())
      if (provider && !next.providers.some((row) => row.name === provider)) {
        setProvider('')
        setResourceId('')
      }
    }
    try {
      callback.current(true)
      if (!alive(op)) return
      setSnapshot(undefined)
      setNotice('等待本次显式操作；未授予后续自动刷新权限。')
      if (action === 'cache') {
        const next = cachedRules(await window.electron.ipcRenderer.invoke('relayResourceList'))
        if (!alive(op)) return
        setResources(next)
        setNotice('已读取私有规则缓存摘要；选择变化后需重新读取活动回执。')
        return
      }
      if (action === 'replaceQueue' && held) {
        const result = await replaceQueuedRuleProviders(
          queue,
          held,
          async (...args) => {
            const receipt = await replace(...args)
            if (alive(op) && (receipt?.status === 'updated' || receipt?.status === 'unchanged')) {
              completedInQueue++
              setQueue((current) => current.filter((item) => item.provider !== args[0]))
            }
            return receipt
          },
          () => alive(op)
        )
        if (!alive(op)) return
        if (result.snapshot) showSnapshot(result.snapshot)
        setNotice(
          !result.stopped
            ? `已逐项确认并核对 ${result.completed.length} 项运行文件。`
            : result.stopped.status === 'uncertain'
              ? `已核对 ${result.completed.length} 项。${result.stopped.provider} 的结果不确定，本会话已隔离，后续项目未提交。`
              : `已核对 ${result.completed.length} 项。${result.stopped.provider} 返回 ${result.stopped.status}，后续项目未提交。请显式重读。`
        )
        return
      }
      const output =
        action === 'read'
          ? readReceipt(
              await window.electron.ipcRenderer.invoke('relayTunRuleProvidersRead', {
                sessionId: owner
              })
            )
          : held && selected && cached
            ? await replace(selected.name, { id: cached.id, sha256: cached.sha256 }, held)
            : undefined
      if (!output || !alive(op)) return
      if ('snapshot' in output) {
        showSnapshot(output.snapshot)
        if (action === 'replace' && selected && cached) {
          const group = output.snapshot.groups.find((names) => names.includes(selected.name))
          setQueue((current) =>
            current.filter(
              (item) => !group?.includes(item.provider) || item.resource.sha256 !== cached.sha256
            )
          )
        }
        setNotice(
          output.status === 'snapshot'
            ? '已读取本地运行文件回执；未检查Core内存策略摘要。'
            : '已收到本地运行文件操作回执；Core公开接口没有内存正文摘要，不能据此作此声明。'
        )
      } else {
        setNotice(
          output.status === 'uncertain'
            ? '本会话结果不确定，已隔离；不自动重试、回滚或采纳未知结果。'
            : output.status === 'unsupported'
              ? '当前会话尚不支持提供者刷新；可继续管理私有缓存。'
              : `本次操作：${String(output.status)}；请显式重读，未自动重试。`
        )
      }
    } catch {
      if (replacingInvoked && owner) isolate(owner)
      if (alive(op))
        setNotice(
          action === 'replace' || action === 'replaceQueue'
            ? replacingInvoked
              ? (action === 'replaceQueue' ? `已核对 ${completedInQueue} 项。` : '') +
                '替换回执未确认，本会话已隔离；后续项目未提交。'
              : '替换计划未通过当前范围检查，请显式重读。'
            : '元数据读取未确认，旧操作回执已清除；没有自动重试。'
        )
    } finally {
      if (work.current === op) work.current = undefined
      if (mounted.current) setPending(false)
      if (ownsBusy.current) {
        ownsBusy.current = false
        callback.current(false)
      }
    }
  }
  const chooseProvider = (value: string): void => {
    ++epoch.current
    setProvider(value)
    setResourceId('')
    setSnapshot(undefined)
    setNotice('提供者选择已改变，请选择匹配缓存并显式重读活动回执。')
  }
  const chooseResource = (value: string): void => {
    ++epoch.current
    setResourceId(value)
    setSnapshot(undefined)
    setNotice('缓存选择已改变，旧操作回执已清除；请显式重读后再确认。')
  }
  const enqueue = (): void => {
    const row = rows.find((item) => item.name === provider),
      cached = resources.find((item) => item.id === resourceId),
      group = groups.find((names) => names.includes(provider))
    if (
      work.current ||
      currentBusy.current ||
      !row ||
      !cached ||
      !group ||
      cached.kind !== row.kind ||
      cached.behavior !== row.behavior
    )
      return
    setQueue((current) => [
      ...current.filter((item) => !group.includes(item.provider)),
      { provider, resource: cached }
    ])
    setNotice('已加入待替换列表。每个运行文件需单独确认。')
  }
  return {
    snapshot: snapshot?.sessionId === tunSessionId ? snapshot : undefined,
    rows,
    groups,
    resources,
    provider,
    resourceId,
    queue,
    enqueue,
    removeQueued: (name: string) =>
      setQueue((current) => current.filter((item) => item.provider !== name)),
    filter,
    setFilter,
    chooseProvider,
    chooseResource,
    pending,
    notice,
    readAt,
    quarantined: !!tunSessionId && isolatedSessions.has(tunSessionId),
    read: () => run('read'),
    listCache: () => run('cache'),
    replace: () => run('replace'),
    replaceQueue: () => run('replaceQueue')
  }
}
