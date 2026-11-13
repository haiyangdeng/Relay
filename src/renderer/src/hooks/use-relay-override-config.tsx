import { useEffect, useRef, useState } from 'react'
import {
  overrideLibraryReadRequest,
  overrideLibraryCreateRequest,
  overrideLibraryMetadataRequest,
  overrideLibraryBodyRequest,
  overrideLibraryContent,
  overrideLibraryRemoveRequest,
  overrideLibraryFetchRequest,
  overrideLibraryFetchEvidence,
  overrideLibraryBindRequest,
  overrideLibraryRefreshRequest,
  overrideLibraryOrderRequest,
  type OverrideLibraryInventory,
  type OverrideLibraryRecord,
  type OverrideLibrarySummary,
  type OverrideLibraryKind,
  type OverrideLibraryRemote,
  type OverrideLibraryBindings,
  type OverrideLibraryTarget,
  type OverrideLibraryFetchPlan,
  type OverrideLibraryFetchResult
} from '../../../shared/relay/override-library'
import type { RelayProfileInventory } from '../../../shared/relay/profiles'
import { relayProfileRead } from '../components/relay/profile-read-queue'

export class OverrideLibraryRefreshError extends Error {
  constructor() {
    super(
      '本次库写入已确认，但刷新失败；草稿保留，请关闭编辑器后重新读取核对，不要重复提交旧修订。'
    )
    this.name = 'OverrideLibraryRefreshError'
  }
}
type Ref = OverrideLibraryBindings['globalRefs'][number]
const usable = (item: OverrideLibrarySummary): boolean =>
  !!item.bodyRevision && item.bodyState !== 'missing' && item.bodyState !== 'stale'

export function useRelayOverrideConfig({
  busy,
  onBusy,
  onBindingsChanged
}: {
  busy: boolean
  onBusy(value: boolean): void
  onBindingsChanged?(): void
}) {
  const [inventory, setInventory] = useState<OverrideLibraryInventory>(),
    [bindings, setBindings] = useState<OverrideLibraryBindings>(),
    [profiles, setProfiles] = useState<RelayProfileInventory>(),
    [target, setTarget] = useState<OverrideLibraryTarget>(),
    [fetchPlan, setFetchPlan] = useState<OverrideLibraryFetchPlan>(),
    [pending, setPending] = useState(false),
    [cancelling, setCancelling] = useState(false),
    [notice, setNotice] = useState(''),
    [requiresRead, setRequiresRead] = useState(false),
    epoch = useRef(0),
    operations = useRef(0),
    ownsBusy = useRef(false),
    fetching = useRef<OverrideLibraryFetchPlan | undefined>(undefined),
    cancellingRef = useRef(false),
    targetSequence = useRef(0),
    executingFetch = useRef<string | undefined>(undefined),
    fetchOutcome = useRef<{ id: string; status: 'updated' | 'cancelled' } | undefined>(undefined)
  useEffect(() => {
    const invalidateEpoch = (): void => {
      epoch.current++
      fetching.current = undefined
    }
    const invalidate = (): void => {
      invalidateEpoch()
      setFetchPlan(undefined)
      setInventory(undefined)
      setBindings(undefined)
      setProfiles(undefined)
      setTarget(undefined)
      setNotice('覆写库上下文已失效，请重新读取；在途操作等待真实收尾。')
    }
    const remove = window.electron.ipcRenderer.on('relayBackupPreparationsInvalidated', invalidate),
      restored = window.electron.ipcRenderer.on('relayDataRestored', invalidate)
    return () => {
      invalidateEpoch()
      remove()
      restored()
    }
  }, [])
  const begin = (): void => {
    if (operations.current++ === 0) {
      ownsBusy.current = !busy
      if (ownsBusy.current) onBusy(true)
    }
    setPending(true)
  }
  const end = (): void => {
    if (--operations.current !== 0) return
    setPending(false)
    if (ownsBusy.current) onBusy(false)
    ownsBusy.current = false
  }
  const cancelOldFetch = async (): Promise<void> => {
    const plan = fetching.current
    fetching.current = undefined
    setFetchPlan(undefined)
    if (plan)
      await window.electron.ipcRenderer.invoke(
        'relayOverrideLibraryFetchCancel',
        overrideLibraryFetchEvidence({ evidenceId: plan.evidenceId })
      )
  }
  const run = async <T,>(
    callback: (check: () => void) => Promise<T>,
    keepFetch = false,
    allowStale = false
  ): Promise<T> => {
    if (busy || operations.current) throw new Error('请等待当前操作结束。')
    if (requiresRead && !allowStale) throw new OverrideLibraryRefreshError()
    begin()
    const generation = epoch.current,
      check = (): void => {
        if (generation !== epoch.current) throw new Error('覆写上下文已失效。')
      }
    try {
      if (!keepFetch) {
        await cancelOldFetch()
        check()
      }
      return await callback(check)
    } catch (error) {
      if (generation === epoch.current)
        setNotice(
          error instanceof OverrideLibraryRefreshError
            ? error.message
            : '写入或读取结果未确认；草稿保留，请核对修订后重读，没有自动获取或应用运行配置。'
        )
      if (error instanceof OverrideLibraryRefreshError) throw error
      throw new Error('覆写操作未确认，草稿保留；请核对修订或重新读取。')
    } finally {
      end()
    }
  }
  const list = async (check: () => void): Promise<OverrideLibraryInventory> => {
    const result = (await window.electron.ipcRenderer.invoke(
      'relayOverrideLibraryList'
    )) as OverrideLibraryInventory
    check()
    setInventory(result)
    return result
  }
  const refreshAfterWrite = async (check: () => void): Promise<void> => {
    check()
    setNotice('本次库写入已由主进程确认，正在刷新公开状态；请等待收尾，不要重复提交。')
    try {
      await list(check)
    } catch {
      check()
      setRequiresRead(true)
      throw new OverrideLibraryRefreshError()
    }
  }
  const acceptBindings = (result: OverrideLibraryBindings): void => {
    // A global/order ack must not erase the separately selected profile's old snapshots.
    setBindings((current) =>
      !result.target && current?.target
        ? { ...result, target: current.target, profileRefs: current.profileRefs }
        : result
    )
    onBindingsChanged?.()
  }
  const requireInventory = (): OverrideLibraryInventory => {
    if (!inventory) throw new Error('请先读取覆写库。')
    return inventory
  }
  const requireBindings = (): OverrideLibraryBindings => {
    if (!bindings) throw new Error('请先读取覆写引用。')
    return bindings
  }
  const selection = (
    profileId: string
  ): Pick<OverrideLibraryTarget, 'id' | 'sha256'> | undefined => {
    if (!profileId) return undefined
    const profile = profiles?.profiles.find((item) => item.id === profileId)
    if (!profile) throw new Error('请选择已保存配置。')
    return { id: profile.id, sha256: profile.sha256 }
  }
  const read = (): Promise<void> =>
    run(
      async (check) => {
        await list(check)
        const result = (await window.electron.ipcRenderer.invoke(
          'relayOverrideLibraryBindingsRead',
          {}
        )) as OverrideLibraryBindings
        check()
        setBindings(result)
        setTarget(undefined)
        const saved = await relayProfileRead('relayProfileList')
        check()
        setProfiles(saved)
        setRequiresRead(false)
        setNotice('已读取私有覆写库和引用；库正文变化不会自动更新已存引用或运行实例。')
      },
      false,
      true
    )
  const selectTarget = (id: string): Promise<void> => {
    const sequence = ++targetSequence.current
    return run(async (check) => {
      const selected = selection(id),
        result = (await window.electron.ipcRenderer.invoke(
          'relayOverrideLibraryBindingsRead',
          selected ? { target: selected } : {}
        )) as OverrideLibraryBindings
      check()
      if (
        sequence !== targetSequence.current ||
        (selected
          ? result.target?.id !== selected.id || result.target?.sha256 !== selected.sha256
          : result.target !== undefined)
      )
        throw new Error('所选配置上下文变化。')
      setTarget(result.target)
      setBindings(result)
      setNotice('已读取此作用域的引用快照；调整选择后须显式保存，历史配置不会随库head自动更新。')
    })
  }
  const createLocal = (kind: OverrideLibraryKind): Promise<void> =>
    run(async (check) => {
      await window.electron.ipcRenderer.invoke(
        'relayOverrideLibraryCreate',
        overrideLibraryCreateRequest({
          expectedLibraryRevision: requireInventory().revision,
          name: kind === 'js' ? '新建JavaScript覆写' : '新建YAML覆写',
          kind,
          type: 'local',
          content: kind === 'js' ? 'function main(config) { return config }\n' : '{}\n'
        })
      )
      check()
      await refreshAfterWrite(check)
      setNotice('本地覆写已保存为未使用定义；编辑正文不会执行脚本或热载核心。')
    })
  const createRemote = (
    name: string,
    kind: OverrideLibraryKind,
    remote: OverrideLibraryRemote
  ): Promise<void> =>
    run(async (check) => {
      await window.electron.ipcRenderer.invoke(
        'relayOverrideLibraryCreate',
        overrideLibraryCreateRequest({
          expectedLibraryRevision: requireInventory().revision,
          name,
          kind,
          type: 'remote',
          remote
        })
      )
      check()
      await refreshAfterWrite(check)
      setNotice('仅已保存远端定义，尚未获取正文；需另行准备并确认单次获取。')
    })
  const readItem = (id: string): Promise<OverrideLibraryRecord> =>
    run(async (check) => {
      const result = (await window.electron.ipcRenderer.invoke(
        'relayOverrideLibraryRead',
        overrideLibraryReadRequest({ id, expectedLibraryRevision: requireInventory().revision })
      )) as OverrideLibraryRecord
      check()
      return result
    })
  const saveMetadata = (
    record: OverrideLibraryRecord,
    name: string,
    remote?: OverrideLibraryRemote
  ): Promise<void> =>
    run(async (check) => {
      await window.electron.ipcRenderer.invoke(
        'relayOverrideLibrarySaveMetadata',
        overrideLibraryMetadataRequest({
          id: record.item.id,
          expectedLibraryRevision: record.revision,
          expectedMetadataRevision: record.item.metadataRevision,
          name,
          ...(remote ? { remote } : {})
        })
      )
      check()
      await refreshAfterWrite(check)
      setNotice('元信息已保存；未获取远端，旧缓存和历史引用未改写。')
    })
  const saveBody = (record: OverrideLibraryRecord, content: string): Promise<void> =>
    run(async (check) => {
      overrideLibraryContent(content, record.item.kind)
      await window.electron.ipcRenderer.invoke(
        'relayOverrideLibrarySaveBody',
        overrideLibraryBodyRequest({
          id: record.item.id,
          expectedLibraryRevision: record.revision,
          expectedBodyRevision: record.item.bodyRevision,
          content
        })
      )
      check()
      await refreshAfterWrite(check)
      setNotice('库正文已保存为新修订；已有引用快照与运行实例不自动更新。')
    })
  const remove = (item: OverrideLibrarySummary): Promise<void> =>
    run(async (check) => {
      await window.electron.ipcRenderer.invoke(
        'relayOverrideLibraryRemove',
        overrideLibraryRemoveRequest({
          id: item.id,
          expectedLibraryRevision: requireInventory().revision,
          expectedMetadataRevision: item.metadataRevision,
          expectedBodyRevision: item.bodyRevision
        })
      )
      check()
      await refreshAfterWrite(check)
      setNotice('未使用的库定义已移除；不会删除历史配置正文或热载核心。')
    })
  const reorder = (ids: string[]): Promise<void> =>
    run(async (check) => {
      const result = (await window.electron.ipcRenderer.invoke(
        'relayOverrideLibraryOrder',
        overrideLibraryOrderRequest({ expectedEditRevision: requireBindings().editRevision, ids })
      )) as OverrideLibraryBindings
      check()
      acceptBindings(result)
      setNotice('库顺序与全局执行顺序已保存；正文引用修订保持原样，没有热载。')
    })
  const global = (item: OverrideLibrarySummary, enabled: boolean): Promise<void> =>
    run(async (check) => {
      const current = requireBindings(),
        refs = current.globalRefs.filter((ref) => ref.id !== item.id)
      if (enabled) {
        if (!usable(item)) throw new Error('该定义还没有可用的当前正文。')
        refs.push(
          current.globalRefs.find((ref) => ref.id === item.id) ?? {
            id: item.id,
            bodyRevision: item.bodyRevision
          }
        )
      }
      const order = current.order
      refs.sort((a, b) => {
        const ai = order.indexOf(a.id),
          bi = order.indexOf(b.id)
        return (ai < 0 ? Number.MAX_SAFE_INTEGER : ai) - (bi < 0 ? Number.MAX_SAFE_INTEGER : bi)
      })
      const result = (await window.electron.ipcRenderer.invoke(
        'relayOverrideLibraryBind',
        overrideLibraryBindRequest({ expectedEditRevision: current.editRevision, refs })
      )) as OverrideLibraryBindings
      check()
      acceptBindings(result)
      setNotice('全局选择已保存；已有引用仍使用原正文修订，需更新时请显式更新引用。')
    })
  const bindProfile = (refs: Ref[]): Promise<void> =>
    run(async (check) => {
      if (!target) throw new Error('请选择配置级作用域。')
      const result = (await window.electron.ipcRenderer.invoke(
        'relayOverrideLibraryBind',
        overrideLibraryBindRequest({
          expectedEditRevision: requireBindings().editRevision,
          target,
          refs
        })
      )) as OverrideLibraryBindings
      check()
      acceptBindings(result)
      setNotice('仅已保存此配置的有序引用；其它配置、旧历史及全局原值保留。')
    })
  const refresh = (ids: string[], profile = false): Promise<void> =>
    run(async (check) => {
      const current = requireBindings(),
        refs = profile ? current.profileRefs : current.globalRefs
      if (profile && !target) throw new Error('请选择配置。')
      const updated = ids.map((id) => {
        const old = refs.find((ref) => ref.id === id),
          item = inventory?.items.find((entry) => entry.id === id)
        if (!old || !item || !usable(item)) throw new Error('引用或当前正文不可用。')
        return { id, expectedOldBodyRevision: old.bodyRevision, bodyRevision: item.bodyRevision }
      })
      const result = (await window.electron.ipcRenderer.invoke(
        'relayOverrideLibraryRefresh',
        overrideLibraryRefreshRequest({
          expectedEditRevision: current.editRevision,
          ...(profile ? { target } : {}),
          refs: updated
        })
      )) as OverrideLibraryBindings
      check()
      acceptBindings(result)
      setNotice('仅已显式更新所选引用到库新修订；其他历史与运行实例保持原样。')
    })
  const prepareFetch = (item: OverrideLibrarySummary): Promise<void> =>
    run(async (check) => {
      const plan = (await window.electron.ipcRenderer.invoke(
        'relayOverrideLibraryFetchPrepare',
        overrideLibraryFetchRequest({
          id: item.id,
          expectedLibraryRevision: requireInventory().revision,
          expectedMetadataRevision: item.metadataRevision,
          expectedBodyRevision: item.bodyRevision
        })
      )) as OverrideLibraryFetchPlan
      check()
      fetching.current = plan
      fetchOutcome.current = undefined
      setFetchPlan(plan)
      setNotice('单次获取已准备；尚未请求网络，需单独确认，仅更新库缓存。')
    })
  const executeFetch = (): Promise<void> =>
    run(async (check) => {
      const plan = fetching.current
      if (!plan || Date.now() >= plan.expiresAt || Date.now() < plan.expiresAt - 60000)
        throw new Error('单次获取准备已过期。')
      setFetchPlan(undefined)
      executingFetch.current = plan.evidenceId
      try {
        const result = (await window.electron.ipcRenderer.invoke(
          'relayOverrideLibraryFetchExecute',
          overrideLibraryFetchEvidence({ evidenceId: plan.evidenceId })
        )) as OverrideLibraryFetchResult
        check()
        fetching.current = undefined
        fetchOutcome.current = { id: plan.evidenceId, status: result.status }
        if (result.status === 'updated') {
          await refreshAfterWrite(check)
          setNotice('本次获取已更新库缓存；已有引用、历史与在用核心未自动更新。')
        } else setNotice('已取消获取；库缓存与现有引用保留。')
      } finally {
        if (fetching.current?.evidenceId === plan.evidenceId) fetching.current = undefined
        if (executingFetch.current === plan.evidenceId) executingFetch.current = undefined
      }
    }, true)
  const cancelFetch = async (): Promise<void> => {
    const plan = fetching.current
    if (!plan || cancellingRef.current) return
    cancellingRef.current = true
    setCancelling(true)
    const wasExecuting = executingFetch.current === plan.evidenceId
    begin()
    fetching.current = undefined
    setFetchPlan(undefined)
    const generation = epoch.current
    try {
      await window.electron.ipcRenderer.invoke(
        'relayOverrideLibraryFetchCancel',
        overrideLibraryFetchEvidence({ evidenceId: plan.evidenceId })
      )
      if (generation === epoch.current) {
        const outcome =
          fetchOutcome.current?.id === plan.evidenceId ? fetchOutcome.current.status : undefined
        setNotice(
          outcome === 'updated'
            ? '本次缓存写入已确认；撤销不回滚已完成写入，引用与运行实例未自动改变。'
            : wasExecuting
              ? outcome === 'cancelled'
                ? '单次获取已取消；原请求已收尾，引用与运行实例保留。'
                : '已请求撤销本次获取，请等待原操作真实结果；已入场写入不会回滚。'
              : '单次获取准备已清除，没有发起新的获取；引用与运行实例保留。'
        )
      }
    } catch {
      if (generation === epoch.current)
        setNotice('取消未确认；旧准备已清除，请人工核对缓存，不自动重试。')
    } finally {
      cancellingRef.current = false
      setCancelling(false)
      end()
    }
  }
  return {
    inventory,
    bindings,
    profiles,
    target,
    fetchPlan,
    pending,
    cancelling,
    notice,
    locked: busy || pending || requiresRead,
    readLocked: busy || pending,
    requiresRead,
    read,
    selectTarget,
    createLocal,
    createRemote,
    readItem,
    saveMetadata,
    saveBody,
    remove,
    reorder,
    global,
    bindProfile,
    refresh,
    prepareFetch,
    executeFetch,
    cancelFetch,
    canCancelFetch: !!fetching.current && !cancelling,
    usable
  }
}
export type RelayOverrideConfig = ReturnType<typeof useRelayOverrideConfig>
