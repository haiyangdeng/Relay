import { useEffect, useRef, useState } from 'react'
import type { RelayProfileInventory } from '../../../../shared/relay/profiles'
import type {
  SubStoreAdvancedStart,
  SubStoreConversion,
  SubStoreItem,
  SubStoreState
} from '../../../../shared/relay/substore'
import type { IsolatedProbeTargets } from '../../../../shared/relay/isolated-probes'

export function RelaySubStorePanel({
  busy,
  onBusy
}: {
  busy: boolean
  onBusy(value: boolean): void
}): React.JSX.Element {
  const [state, setState] = useState<SubStoreState>(),
    [profiles, setProfiles] = useState<RelayProfileInventory>(),
    [profile, setProfile] = useState(''),
    [targets, setTargets] = useState<IsolatedProbeTargets>(),
    [target, setTarget] = useState(''),
    [backendMode, setBackendMode] = useState<'local' | 'remote'>('local'),
    [backendURL, setBackendURL] = useState(''),
    [allowLan, setAllowLan] = useState(false),
    [syncCron, setSyncCron] = useState(''),
    [downloadCron, setDownloadCron] = useState(''),
    [uploadCron, setUploadCron] = useState(''),
    [subscriptions, setSubscriptions] = useState<SubStoreItem[]>([]),
    [collections, setCollections] = useState<SubStoreItem[]>([]),
    [kind, setKind] = useState<'subscription' | 'collection'>('subscription'),
    [selected, setSelected] = useState(''),
    [conversion, setConversion] = useState<SubStoreConversion>(),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState(''),
    operation = useRef(false),
    mounted = useRef(true),
    epoch = useRef(0)
  useEffect(() => {
    mounted.current = true
    const lifecycle = epoch
    return () => {
      mounted.current = false
      ++lifecycle.current
    }
  }, [])
  const locked = busy || pending || !!state?.pending,
    running = state?.phase === 'running'
  const changed = (): void => {
    ++epoch.current
    setConversion(undefined)
  }
  const request = (): SubStoreAdvancedStart => {
    const selected = profiles?.profiles.find((row) => row.id === profile)
    if (!selected || !target) throw new Error('请选择保存的静态出站。')
    return {
      profile: { id: selected.id, sha256: selected.sha256 },
      target,
      mode: backendMode,
      backendURL: backendMode === 'remote' ? backendURL : '',
      allowLan: backendMode === 'local' && allowLan,
      syncCron: backendMode === 'local' ? syncCron : '',
      downloadCron: backendMode === 'local' ? downloadCron : '',
      uploadCron: backendMode === 'local' ? uploadCron : ''
    }
  }
  const action = async (
    type:
      | 'profiles'
      | 'targets'
      | 'read'
      | 'acquire'
      | 'start'
      | 'stop'
      | 'open'
      | 'list'
      | 'convert'
      | 'save'
      | 'recover'
  ): Promise<void> => {
    if (operation.current || busy) return
    operation.current = true
    setPending(true)
    onBusy(true)
    const at = epoch.current,
      current = (): boolean => mounted.current && at === epoch.current
    if (type !== 'save') setConversion(undefined)
    try {
      let update = (): void => {}
      if (type === 'profiles') {
        const next = (await window.electron.ipcRenderer.invoke(
          'relayProfileList'
        )) as RelayProfileInventory
        update = () => setProfiles(next)
      } else if (type === 'targets') {
        const selected = profiles?.profiles.find((row) => row.id === profile)
        if (!selected) throw new Error()
        const next = await window.electron.ipcRenderer.invoke('relayIsolatedProbeTargets', {
          id: selected.id,
          sha256: selected.sha256
        })
        update = () => {
          setTargets(next)
          setTarget('')
        }
      } else if (type === 'read') {
        const next = (await window.electron.ipcRenderer.invoke(
          'relaySubStoreState'
        )) as SubStoreState
        update = () => setState(next)
      } else if (type === 'acquire' || type === 'start')
        await window.electron.ipcRenderer.invoke(
          type === 'acquire' ? 'relaySubStoreAdvancedAcquire' : 'relaySubStoreAdvancedStart',
          request()
        )
      else if (type === 'stop') await window.electron.ipcRenderer.invoke('relaySubStoreStop')
      else if (type === 'recover') await window.electron.ipcRenderer.invoke('relaySubStoreRecover')
      else if (type === 'open') await window.electron.ipcRenderer.invoke('relaySubStoreOpen')
      else if (type === 'list') {
        const list = (await window.electron.ipcRenderer.invoke('relaySubStoreList')) as {
          subscriptions: SubStoreItem[]
          collections: SubStoreItem[]
        }
        update = () => {
          setSubscriptions(list.subscriptions)
          setCollections(list.collections)
          setSelected('')
        }
      } else if (type === 'convert') {
        const next = (await window.electron.ipcRenderer.invoke('relaySubStoreConvert', {
          kind,
          name: selected
        })) as SubStoreConversion
        if (!current()) return
        const saved = await window.electron.ipcRenderer.invoke('relaySubStoreSave', {
          evidenceId: next.evidenceId
        })
        if (
          !saved ||
          typeof saved !== 'object' ||
          !('id' in saved) ||
          typeof saved.id !== 'string' ||
          !('sha256' in saved) ||
          typeof saved.sha256 !== 'string'
        )
          throw new Error('转换结果未保存。')
        update = () => setConversion(undefined)
      } else {
        const plan = conversion
        setConversion(undefined)
        await window.electron.ipcRenderer.invoke('relaySubStoreSave', {
          evidenceId: plan?.evidenceId
        })
      }
      if (current()) {
        update()
        setNotice(
          type === 'targets'
            ? '已读取保存节点，尚未解析或启动核心。'
            : type === 'convert'
              ? '已转换并保存独立配置，请在配置列表中查看。'
              : type === 'save'
                ? '保存操作已返回；请核对私有配置列表。'
                : '本次Sub-Store操作已返回。'
        )
      }
    } catch {
      if (current()) {
        setConversion(undefined)
        setNotice(
          'Sub-Store操作未完成。请核对保存静态节点、固定资源、只读网络观察与收尾状态；没有使用在用核心端口或直连回退。'
        )
      }
    } finally {
      try {
        const next = (await window.electron.ipcRenderer.invoke(
          'relaySubStoreState'
        )) as SubStoreState
        if (current()) setState(next)
      } catch {
        if (current()) setState(undefined)
      }
      operation.current = false
      if (mounted.current) setPending(false)
      onBusy(false)
    }
  }
  return (
    <section className="relay-panel">
      <h2>Sub-Store · 独立订阅管理</h2>
      <p>
        固定官方前后端资源保存在Relay私有目录；默认不运行。选择保存的静态节点，创建独立核心与本机出站守门，不使用在用核心的配置、健康记录或代理端口。不修改系统代理、DNS、TUN或Claude配置；环境事实不明或变化时撤销后续出站。
      </p>
      <button disabled={locked || running} onClick={() => void action('profiles')}>
        读取已保存配置
      </button>
      <select
        aria-label="Sub-Store独立出口配置"
        disabled={locked || running}
        value={profile}
        onChange={(event) => {
          changed()
          setProfile(event.target.value)
          setTarget('')
          setTargets(undefined)
        }}
      >
        <option value="">选择保存配置</option>
        {profiles?.profiles.map((row) => (
          <option key={row.id} value={row.id}>
            {row.name}
          </option>
        ))}
      </select>
      <button disabled={locked || running || !profile} onClick={() => void action('targets')}>
        读取静态出站
      </button>
      <select
        aria-label="Sub-Store静态出站"
        disabled={locked || running}
        value={target}
        onChange={(event) => {
          changed()
          setTarget(event.target.value)
        }}
      >
        <option value="">选择静态节点</option>
        {targets?.nodes.map((name) => (
          <option key={name}>{name}</option>
        ))}
      </select>
      <label>
        后端方式
        <select
          disabled={locked || running}
          value={backendMode}
          onChange={(event) => {
            changed()
            setBackendMode(event.target.value as 'local' | 'remote')
          }}
        >
          <option value="local">本次本地后端</option>
          <option value="remote">自定义远端后端</option>
        </select>
      </label>
      {backendMode === 'remote' ? (
        <label>
          后端HTTPS基址（可含专用访问路径）
          <input
            type="url"
            disabled={locked || running}
            value={backendURL}
            onChange={(event) => {
              changed()
              setBackendURL(event.target.value)
            }}
            placeholder="https://example.com/private-path"
          />
        </label>
      ) : (
        <>
          <label>
            <input
              type="checkbox"
              disabled={locked || running}
              checked={allowLan}
              onChange={(event) => {
                changed()
                setAllowLan(event.target.checked)
              }}
            />
            本次允许局域网访问（默认关闭）
          </label>
          <p>
            局域网访问使用HTTP和本次私密管理路径；链接具有管理权限，只发给可信设备。三类定时任务为空时关闭，填写有效5段cron后在本次明确启动时启用；主窗隐藏、导航或挂起会撤销后续出站；结束本次服务即停止，不自动恢复。
          </p>
          <label>
            定时同步
            <input
              disabled={locked || running}
              value={syncCron}
              onChange={(event) => {
                changed()
                setSyncCron(event.target.value)
              }}
              placeholder="例如 0 */6 * * *"
            />
          </label>
          <label>
            定时下载备份
            <input
              disabled={locked || running}
              value={downloadCron}
              onChange={(event) => {
                changed()
                setDownloadCron(event.target.value)
              }}
            />
          </label>
          <label>
            定时上传备份
            <input
              disabled={locked || running}
              value={uploadCron}
              onChange={(event) => {
                changed()
                setUploadCron(event.target.value)
              }}
            />
          </label>
        </>
      )}
      <p>
        自定义后端经本机转发层和相同独立出口，管理窗口只访问自有本机地址；不载入远端网页，不开放Relay权限。只支持公网目标，不直接访问内网后端或订阅。外部TUN变化无法由观察原子阻止；检测到变化不自动重试。
      </p>
      <div className="relay-action">
        <button disabled={locked} onClick={() => void action('read')}>
          读取Sub-Store状态
        </button>
        <button disabled={locked || running || !target} onClick={() => void action('acquire')}>
          获取固定前后端资源…
        </button>
        <button
          disabled={locked || running || !state?.resourcesReady || !target}
          onClick={() => void action('start')}
        >
          启动本次Sub-Store…
        </button>
        <button disabled={locked || !running} onClick={() => void action('open')}>
          打开隔离管理窗口
        </button>
        <button
          disabled={locked || !state || !['running', 'failed', 'uncertain'].includes(state.phase)}
          onClick={() => void action('stop')}
        >
          结束本次Sub-Store
        </button>
        <button
          disabled={!pending}
          onClick={() => {
            void window.electron.ipcRenderer
              .invoke('relaySubStoreCancel')
              .catch(() => setNotice('取消未确认，请等待本次操作结束。'))
          }}
        >
          取消本次操作
        </button>
      </div>
      <button
        disabled={locked || !state?.recovery?.canArchive}
        onClick={() => void action('recover')}
      >
        归档已退出的旧会话记录…
      </button>
      {state?.recovery && (
        <p>
          旧会话子进程 {state.recovery.pid ?? '无法确认'}
          {state.recovery.egressPID ? ` 与独立核心 ${state.recovery.egressPID}` : ''}：
          {state.recovery.canArchive
            ? '进程已不存在，可确认归档记录'
            : '仍存在或状态未知，禁止归档和接管'}
        </p>
      )}
      {state?.mode && (
        <p>
          本次后端：{state.mode === 'remote' ? `远端 ${state.backendOrigin ?? ''}` : '本地'} ·
          局域网{state.allowLan ? '已开放' : '关闭'}
        </p>
      )}
      {state?.lanURL && (
        <label>
          本次敏感管理链接（手动复制给可信设备）
          <input readOnly value={state.lanURL} />
        </label>
      )}
      {state && (
        <p>
          状态：{state.phase} · 资源{state.resourcesReady ? '已校验' : '未就绪'} · 后端
          {state.backendVersion}／前端{state.frontendVersion}
          {state.pid ? ` · 自有PID ${state.pid}` : ''}
        </p>
      )}
      <p>
        在管理窗口完成订阅与集合编辑后，读取本次列表；转换结果单独保存到Relay私有配置，不自动切换或热载。
      </p>
      <button disabled={locked || !running} onClick={() => void action('list')}>
        读取本次订阅与集合
      </button>
      <label>
        来源类型
        <select
          disabled={locked || !running}
          value={kind}
          onChange={(event) => {
            setKind(event.target.value as typeof kind)
            setSelected('')
            setConversion(undefined)
          }}
        >
          <option value="subscription">订阅</option>
          <option value="collection">集合</option>
        </select>
      </label>
      <label>
        选择来源
        <select
          value={selected}
          disabled={locked || !running}
          onChange={(event) => {
            setSelected(event.target.value)
            setConversion(undefined)
          }}
        >
          <option value="">请选择</option>
          {(kind === 'subscription' ? subscriptions : collections).map((item) => (
            <option key={item.name} value={item.name}>
              {item.displayName ?? item.name}
            </option>
          ))}
        </select>
      </label>
      <div className="relay-action">
        <button disabled={locked || !running || !selected} onClick={() => void action('convert')}>
          转换并保存配置
        </button>
      </div>
      {conversion && (
        <p>
          {conversion.name} · {conversion.bytes}字节 · SHA256 {conversion.sha256}；尚未保存或启用。
        </p>
      )}
      {state?.warnings.map((warning) => (
        <p key={warning}>{warning}</p>
      ))}
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}
