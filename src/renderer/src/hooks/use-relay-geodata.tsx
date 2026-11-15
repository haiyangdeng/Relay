import { useEffect, useRef, useState } from 'react'
import type {
  GeoOriginInfo,
  GeoOriginInventory,
  GeoOriginOperationResult,
  GeoOriginRecord,
  GeoOriginServiceState,
  GeoResourceKind
} from '../../../shared/relay/geo-origins'
import type { ConfigurationEditRecord } from '../../../shared/relay/configuration-edit'
import type { GeoSchedulerState, GeoScheduleArmResult } from '../../../shared/relay/geo-scheduler'
import type { TunResourcesResult, TunResourcesSnapshot } from '../../../shared/relay/tun-resources'
import {
  geoDraft,
  readGeoSettings,
  geoMode,
  geoModeDocument,
  geoModeRecord,
  geoSaveRequest,
  type GeoOriginDraft
} from '../utils/relay-geo-config'
import type { GeoMode } from '../components/resources/geo-data-view'

type Work = { epoch: number; kind: string; invalid?: boolean }
const selection = (info: GeoOriginInfo) => ({ id: info.id, revision: info.revision })
const checkedSnapshot = (raw: TunResourcesResult, sessionId: string): TunResourcesSnapshot => {
  if (
    !['snapshot', 'updated', 'unchanged'].includes(raw.status) ||
    !('snapshot' in raw) ||
    raw.sessionId !== sessionId ||
    raw.snapshot.sessionId !== sessionId ||
    !/^[a-f0-9]{64}$/u.test(raw.snapshot.configurationRevision) ||
    !/^[a-f0-9]{64}$/u.test(raw.snapshot.generationSHA256) ||
    !Array.isArray(raw.snapshot.resources) ||
    raw.snapshot.resources.length > 4
  )
    throw new Error('活动回执未确认')
  return structuredClone(raw.snapshot)
}
export function useRelayGeoData({
  busy,
  onBusy,
  tunSessionId,
  onModeChanged
}: {
  busy: boolean
  onBusy(value: boolean): void
  tunSessionId?: string
  onModeChanged?(): void
}) {
  const [inventory, setInventory] = useState<GeoOriginInventory>(),
    [urls, setURLs] = useState<Partial<Record<GeoResourceKind, string>>>({}),
    [kind, setKind] = useState<GeoResourceKind>('geoip-dat'),
    [draft, setDraft] = useState<GeoOriginDraft>(),
    [baseInfo, setBaseInfo] = useState<GeoOriginInfo>(),
    [isNew, setNew] = useState(false),
    [dirty, setDirty] = useState(false),
    [requiresRead, setRequiresRead] = useState(false),
    [operationState, setOperationState] = useState<GeoOriginServiceState>(),
    [pending, setPending] = useState(0),
    [notice, setNotice] = useState(''),
    [result, setResult] = useState<GeoOriginOperationResult>(),
    [modeBase, setModeBase] = useState<ConfigurationEditRecord>(),
    [mode, setMode] = useState<GeoMode>('inherit'),
    [modeDirty, setModeDirty] = useState(false),
    [modeRequiresRead, setModeRequiresRead] = useState(false),
    [snapshot, setSnapshot] = useState<TunResourcesSnapshot>(),
    [activeNotice, setActiveNotice] = useState(''),
    [quarantined, setQuarantined] = useState<string>(),
    [schedule, setSchedule] = useState<GeoSchedulerState>(),
    [schedulePending, setSchedulePending] = useState(false),
    [target, setTarget] = useState<'cache' | 'tun'>('cache')
  const mounted = useRef(true),
    epoch = useRef(0),
    work = useRef<Work | undefined>(undefined),
    owned = useRef(0),
    ownsBusy = useRef(false),
    callbacks = useRef({ onBusy, onModeChanged }),
    session = useRef(tunSessionId),
    lastSession = useRef(tunSessionId),
    activeEpoch = useRef(0),
    cancelPending = useRef(false),
    scheduleReading = useRef(false),
    grantRevision = useRef(0)
  callbacks.current = { onBusy, onModeChanged }
  session.current = tunSessionId
  const info = inventory?.origins.find((i) => i.descriptor.kind === kind)
  const alive = (op: Work) =>
    mounted.current && !op.invalid && op.epoch === epoch.current && work.current === op
  const enter = () => {
    if (owned.current++ === 0 && !busy) {
      ownsBusy.current = true
      callbacks.current.onBusy(true)
    }
    if (mounted.current) setPending(owned.current)
  }
  const leave = () => {
    owned.current--
    if (mounted.current) setPending(owned.current)
    if (!owned.current && ownsBusy.current) {
      ownsBusy.current = false
      callbacks.current.onBusy(false)
    }
  }
  useEffect(() => {
    mounted.current = true
    const invalidateEpoch = (): void => {
      ++epoch.current
      ++activeEpoch.current
    }
    const invalidate = () => {
      invalidateEpoch()
      setInventory(undefined)
      setURLs({})
      setDraft(undefined)
      setBaseInfo(undefined)
      setNew(false)
      setDirty(false)
      setRequiresRead(true)
      setOperationState(undefined)
      setResult(undefined)
      setModeBase(undefined)
      setMode('inherit')
      setModeDirty(false)
      setModeRequiresRead(true)
      setSnapshot(undefined)
      setSchedule(undefined)
      setTarget('cache')
      setNotice('界面范围已失效；未恢复权限，请显式重读。在途操作等待真实收尾。')
      callbacks.current.onModeChanged?.()
    }
    const remove = window.electron.ipcRenderer.on('relayBackupPreparationsInvalidated', invalidate),
      restored = window.electron.ipcRenderer.on('relayDataRestored', invalidate),
      runtime = window.electron.ipcRenderer.on('relayTunUpdated', () => {
        if (work.current?.kind === 'readActive' || work.current?.kind === 'replace') return
        // Arm's own verified owner read emits the same hint. Forget cached
        // generation, but let its receipt bind to the still-current owner;
        // real owner changes, view invalidation and Stop retain their latches.
        if (work.current?.kind !== 'arm') ++activeEpoch.current
        setSnapshot(undefined)
        setActiveNotice('运行观察已变化，请显式重读；已隔离的未知会话仍不能被重读收养。')
      })
    return () => {
      mounted.current = false
      invalidateEpoch()
      remove()
      restored()
      runtime()
    }
  }, [])
  useEffect(() => {
    if (lastSession.current !== tunSessionId) {
      lastSession.current = tunSessionId
      ++activeEpoch.current
      setSnapshot(undefined)
      setQuarantined(undefined)
      setTarget('cache')
      setActiveNotice('TUN持有范围已变化，请显式读取新会话；不会沿用旧代际。')
    }
  }, [tunSessionId])
  const run = async (label: string, action: (op: Work) => Promise<void>) => {
    if (busy || work.current || owned.current) return
    const op = { epoch: epoch.current, kind: label }
    work.current = op
    enter()
    try {
      await action(op)
    } catch {
      if (alive(op)) setNotice('本次操作未完整确认；没有自动重试，请显式重读。草稿保留。')
    } finally {
      if (work.current === op) work.current = undefined
      leave()
    }
  }
  const choose = (next: GeoResourceKind) => {
    if (busy || owned.current) return
    if (dirty) {
      setNotice('请先保存当前来源，或点击“放弃修改”，再切换数据库。')
      return
    }
    ++epoch.current
    setKind(next)
    setDraft(undefined)
    setBaseInfo(undefined)
    setNew(false)
    setDirty(false)
    setRequiresRead(false)
    setResult(undefined)
    setOperationState(undefined)
    setNotice('正在读取所选数据库设置。')
  }
  const change = (next: GeoOriginDraft) => {
    if (busy || owned.current || requiresRead || !draft) return
    setDraft(next)
    setDirty(true)
    setSnapshot(undefined)
  }
  const list = () =>
    run('list', async (op) => {
      const next = (await window.electron.ipcRenderer.invoke(
        'relayGeoOriginList'
      )) as GeoOriginInventory
      if (!alive(op)) return
      if (
        !next ||
        !Array.isArray(next.origins) ||
        !Number.isSafeInteger(next.incomplete) ||
        !Array.isArray(next.warnings)
      )
        throw new Error('元数据未确认')
      setInventory(next)
      const current = next.origins.find((i) => i.descriptor.kind === kind)
      if (baseInfo && (!current || current.revision !== baseInfo.revision)) setRequiresRead(true)
      setNotice('已读取安全来源摘要；未读取完整URL或请求头，也未获取正文。')
    })
  const readSettings = () =>
    run('readSettings', async (op) => {
      setURLs({})
      const { inventory: next, urls: nextURLs } = await readGeoSettings((channel, ...args) =>
        window.electron.ipcRenderer.invoke(channel, ...args)
      )
      if (!alive(op)) return
      setInventory(next)
      setURLs(nextURLs)
      const current = next.origins.find((origin) => origin.descriptor.kind === kind)
      if (baseInfo && (!current || current.revision !== baseInfo.revision)) setRequiresRead(true)
      setNotice('已读取保存的数据库地址，未下载或更新数据库。')
    })
  const read = () =>
    run('read', async (op) => {
      if (!info) throw new Error('请先读列表')
      try {
        const record = (await window.electron.ipcRenderer.invoke(
          'relayGeoOriginRead',
          selection(info)
        )) as GeoOriginRecord
        const projected = geoDraft(kind, record)
        if (record.info.id !== info.id || record.info.revision !== info.revision)
          throw new Error('来源已变化')
        if (!alive(op)) return
        setDraft(projected)
        setURLs((current) => ({ ...current, [kind]: projected.url }))
        setBaseInfo(record.info)
        setNew(false)
        setDirty(false)
        setRequiresRead(false)
        setResult(undefined)
        setNotice('已显式读取私有来源；修改后独立确认保存，不获取或热换。')
      } catch {
        if (alive(op)) {
          setRequiresRead(true)
          setNotice('来源详情读取未确认；草稿保留，未采纳新修订，请重新读取。')
        }
      }
    })
  const create = () => {
    if (busy || owned.current || !inventory || inventory.incomplete || info) return
    ++epoch.current
    setDraft(geoDraft(kind))
    setBaseInfo(undefined)
    setNew(true)
    setDirty(true)
    setRequiresRead(false)
    setResult(undefined)
    setNotice('新来源草稿使用官方数据库地址；尚未保存、获取或授权。')
  }
  const discard = async () => {
    if (busy || owned.current) return
    if (info) await read()
    else {
      setDraft(undefined)
      setBaseInfo(undefined)
      setNew(false)
      setDirty(false)
      setRequiresRead(false)
      setNotice('已放弃未保存的来源草稿。')
    }
  }
  const operate = async (op: Work, action: 'save' | 'fetch') => {
    let input: unknown
    try {
      if (action === 'save') {
        const form = draft
        if (!form || requiresRead || (!baseInfo && !isNew)) return
        input = geoSaveRequest(kind, form, baseInfo)
      } else {
        const selected = info
        if (!selected || dirty) return
        input = selection(selected)
      }
    } catch {
      setNotice('请修正来源URL、固定端口、请求头JSON、选择器、摘要或小时周期；未发送保存请求。')
      return
    }
    const sourceId = action === 'save' ? baseInfo?.id : info?.id
    let settled = false
    const promise = window.electron.ipcRenderer
      .invoke(action === 'save' ? 'relayGeoOriginSave' : 'relayGeoOriginFetch', input)
      .then(
        (value) => {
          settled = true
          return { ok: true as const, value: value as GeoOriginOperationResult }
        },
        () => {
          settled = true
          return { ok: false as const }
        }
      )
    // State is safe metadata and has a separate read lane. Capture the exact ID;
    // no cancellation is sent before it belongs to this held UI operation.
    const status = alive(op)
      ? window.electron.ipcRenderer
          .invoke('relayGeoOriginState')
          .then((raw) => {
            const state = raw as GeoOriginServiceState
            if (
              alive(op) &&
              !settled &&
              state.pending &&
              !state.automatic &&
              state.originId === sourceId
            )
              setOperationState(state)
          })
          .catch(() => {})
      : Promise.resolve()
    const output = await promise
    await status
    if (!alive(op)) return
    setOperationState(undefined)
    if (!output.ok) {
      if (action === 'save') {
        ++grantRevision.current
        setSchedule(undefined)
      }
      setRequiresRead(true)
      setNotice('保存／获取结果未知；草稿保留，请重新读取，不重试旧修订。')
      return
    }
    const next = output.value
    if (action === 'save' && (next.status === 'saved' || next.status === 'uncertain')) {
      ++grantRevision.current
      setSchedule(undefined)
    }
    setResult(next)
    const acceptedInfo = next.origin
    if (acceptedInfo) {
      setInventory((previous) =>
        previous
          ? {
              ...previous,
              origins: [...previous.origins.filter((i) => i.id !== acceptedInfo.id), acceptedInfo]
            }
          : undefined
      )
    }
    if (next.status === 'saved' || next.status === 'updated') {
      setBaseInfo(undefined)
      setNew(false)
      setDirty(false)
      setRequiresRead(true)
      setNotice(
        next.status === 'saved'
          ? '已确认保存定义；私有详情未由摘要回填，请显式重读后继续编辑。自动意图不是权限。'
          : '已检查并更新缓存head；未更新活动数据库。编辑定义前请显式重读。'
      )
    } else if (next.status === 'uncertain') {
      setRequiresRead(true)
      setNotice('写入结果不确定；已有资料保留，不自动重试，请显式重读。')
    } else if (action === 'save' && next.status === 'failed') {
      setRequiresRead(true)
      setNotice('保存未通过或来源已变化；草稿保留，请重新读取，不重试旧修订。')
    } else setNotice(next.warnings.join(' ') || '本次已取消或失败；未启用权限。')
  }
  const save = () => run('save', (op) => operate(op, 'save'))
  const fetch = () => run('fetch', (op) => operate(op, 'fetch'))
  const cancel = async () => {
    const id = operationState?.operationId,
      op = work.current
    if (!id || !op || !alive(op) || cancelPending.current) return
    cancelPending.current = true
    enter()
    try {
      await window.electron.ipcRenderer.invoke('relayGeoOriginCancel', { operationId: id })
      if (alive(op)) setNotice('本次取消已排空；真实操作结果单独显示。')
    } catch {
      if (alive(op)) setNotice('取消未确认；等待实际操作收尾，不自动重试。')
    } finally {
      cancelPending.current = false
      leave()
    }
  }
  const readMode = () =>
    run('readMode', async (op) => {
      callbacks.current.onModeChanged?.()
      if (!alive(op)) return
      try {
        const next = geoModeRecord(
            (await window.electron.ipcRenderer.invoke(
              'relayConfigEditRead'
            )) as ConfigurationEditRecord
          ),
          value = geoMode(next.document)
        if (!alive(op)) return
        setModeBase(next)
        setMode(value)
        setModeDirty(false)
        setModeRequiresRead(false)
        setNotice('已读取受控模式草稿；来源定义和活动数据库未改变。')
      } catch {
        if (alive(op)) {
          setModeRequiresRead(true)
          setNotice('模式草稿读取未确认；旧草稿保留，必须重新读取。')
        }
      }
    })
  const changeMode = (value: GeoMode) => {
    if (busy || owned.current || !modeBase || modeRequiresRead) return
    setMode(value)
    setModeDirty(value !== geoMode(modeBase.document))
    callbacks.current.onModeChanged?.()
  }
  const saveMode = () =>
    run('saveMode', async (op) => {
      if (!modeBase || modeRequiresRead || !modeDirty) return
      callbacks.current.onModeChanged?.()
      if (!alive(op)) return
      const document = geoModeDocument(modeBase.document, mode)
      try {
        const next = geoModeRecord(
          (await window.electron.ipcRenderer.invoke('relayConfigEditSave', {
            document,
            expectedRevision: modeBase.revision
          })) as ConfigurationEditRecord
        )
        if (geoMode(next.document) !== mode) throw new Error('模式回执未匹配')
        if (!alive(op)) return
        setModeBase(next)
        setModeDirty(false)
        setNotice('DB／DAT受控草稿已保存；未热载或改变当前实例，仍需独立准备及应用。')
      } catch {
        if (alive(op)) {
          setModeRequiresRead(true)
          setNotice('模式保存结果未确认；完整草稿保留，禁止用旧CAS重试，请重读。')
        }
      }
    })
  const active = async (changing: boolean) =>
    run(changing ? 'replace' : 'readActive', async (op) => {
      const owner = tunSessionId,
        at = activeEpoch.current
      if (
        !owner ||
        quarantined === owner ||
        (changing && (!snapshot || snapshot.sessionId !== owner || !info?.head || dirty))
      )
        return
      const held = snapshot,
        selected = info
      let input: unknown = { sessionId: owner }
      if (changing) {
        if (!held || !selected) return
        input = {
          sessionId: owner,
          configurationRevision: held.configurationRevision,
          expectedGenerationSHA256: held.generationSHA256,
          origin: selection(selected)
        }
      }
      setSnapshot(undefined)
      try {
        const output = (await window.electron.ipcRenderer.invoke(
          changing ? 'relayTunResourceReplace' : 'relayTunResourcesRead',
          input
        )) as TunResourcesResult
        if (!alive(op) || session.current !== owner || at !== activeEpoch.current) return
        if (
          output.status === 'snapshot' ||
          output.status === 'updated' ||
          output.status === 'unchanged'
        ) {
          setSnapshot(checkedSnapshot(output, owner))
          setActiveNotice(
            output.status === 'snapshot'
              ? '已读取本次活动代际；缓存head与它是不同证据。'
              : '活动替换已收到独立回执；未修改来源head或历史快照。'
          )
        } else {
          if (output.status === 'uncertain') setQuarantined(owner)
          setActiveNotice(
            output.status === 'unsupported'
              ? '此会话未证实新资源能力，只允许缓存工作；不会探测旧控制通道或自动回退。'
              : output.status === 'uncertain'
                ? '本会话活动结果不确定，已隔离；不能再次读取并收养旧代际，不自动重试或回滚。'
                : `本次活动操作：${output.status}；旧表已清除，请显式重新读取。`
          )
        }
      } catch {
        if (alive(op) && session.current === owner) {
          setActiveNotice(
            '活动入口或回执未确认，旧表已清除；请显式核对，不自动重试或改用本地代理。已由服务隔离的未知会话不会被重读收养。'
          )
        }
      }
    })
  const readSchedule = async () => {
    if (scheduleReading.current) return
    const at = epoch.current,
      revision = grantRevision.current
    scheduleReading.current = true
    setSchedulePending(true)
    enter()
    try {
      const next = (await window.electron.ipcRenderer.invoke(
        'relayGeoScheduleState'
      )) as GeoSchedulerState
      if (mounted.current && at === epoch.current && revision === grantRevision.current) {
        setSchedule(next)
        setNotice('已读取本会话授权缓存；保存的自动意图不等于活动权限。')
      }
    } catch {
      if (mounted.current && at === epoch.current && revision === grantRevision.current)
        setNotice('授权缓存读取未确认；没有恢复或改变权限。')
    } finally {
      scheduleReading.current = false
      if (mounted.current) setSchedulePending(false)
      leave()
    }
  }
  const arm = () =>
    run('arm', async (op) => {
      if (
        !info ||
        dirty ||
        !info.autoIntent.requested ||
        (target === 'tun' &&
          (!tunSessionId ||
            !snapshot ||
            snapshot.sessionId !== tunSessionId ||
            quarantined === tunSessionId))
      )
        return
      const owner = tunSessionId,
        at = activeEpoch.current,
        revision = ++grantRevision.current
      const output = (await window.electron.ipcRenderer.invoke('relayGeoScheduleArm', {
        origin: selection(info),
        target: target === 'cache' ? { kind: 'cache' } : { kind: 'tun', sessionId: tunSessionId }
      })) as GeoScheduleArmResult
      if (
        alive(op) &&
        revision === grantRevision.current &&
        (target === 'cache' || (owner === session.current && at === activeEpoch.current))
      ) {
        ++grantRevision.current
        setSchedule(output.state)
        setNotice(`本次授权：${output.status}；保存／恢复意图不会自动启动。`)
      }
    })
  const disarm = async (id: string) => {
    if (cancelPending.current) return
    // Stopping an authority invalidates its late arm/state reply, not an
    // unrelated admitted source write or mode CAS and its actual receipt.
    if (work.current?.kind === 'arm') work.current.invalid = true
    const at = epoch.current,
      revision = ++grantRevision.current
    cancelPending.current = true
    enter()
    try {
      const next = (await window.electron.ipcRenderer.invoke('relayGeoScheduleDisarm', {
        id
      })) as GeoSchedulerState
      if (mounted.current && at === epoch.current && revision === grantRevision.current) {
        ++grantRevision.current
        setSchedule(next)
        setNotice('已停用此来源本次授权并等待实际工作收尾；保存意图和已有缓存仍保留。')
      }
    } catch {
      if (mounted.current && at === epoch.current)
        setNotice('停用未确认；请等待实际工作，未自动重试。')
    } finally {
      cancelPending.current = false
      leave()
    }
  }
  return {
    inventory,
    urls,
    kind,
    choose,
    draft,
    change,
    baseInfo,
    isNew,
    dirty,
    requiresRead,
    operationState,
    pending,
    notice,
    result,
    info,
    list,
    readSettings,
    read,
    create,
    discard,
    save,
    fetch,
    cancel,
    mode,
    modeBase,
    modeDirty,
    modeRequiresRead,
    readMode,
    changeMode,
    saveMode,
    snapshot: snapshot?.sessionId === tunSessionId ? snapshot : undefined,
    activeNotice:
      lastSession.current === tunSessionId ? activeNotice : 'TUN持有范围已变化，请显式读取新会话。',
    quarantined,
    active,
    readSchedule,
    schedule,
    schedulePending,
    target,
    setTarget,
    arm,
    disarm
  }
}
