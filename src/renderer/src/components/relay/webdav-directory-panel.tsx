import { useEffect, useRef, useState } from 'react'
import type {
  RelayBackupAccount,
  RelayBackupAccountInventory
} from '../../../../shared/relay/backup-accounts'
import type {
  RelayWebdavDirectoryPlan,
  RelayWebdavDirectoryResult,
  WebdavDirectoryRejection
} from '../../../../shared/relay/backup-directory'

const reasonLabel: Record<WebdavDirectoryRejection, string> = {
  authentication: '身份认证未通过',
  forbidden: '服务器拒绝此权限',
  parentMissing: '父目录不存在，请先在服务器端建立父目录',
  parentNotCollection: '父目标未确认是目录集合',
  targetNotCollection: '目标已存在且未确认是目录集合',
  unverified: '目录状态未能验证',
  locked: '服务器锁定此目标',
  unsupported: '服务器不支持此目录操作',
  storage: '服务器存储条件未满足',
  protocol: '服务器响应未通过目录协议检查'
}
function resultLabel(result: RelayWebdavDirectoryResult): string {
  if ('reason' in result) return `本次目录操作未完成：${reasonLabel[result.reason]}。`
  if (result.status === 'uncertain')
    return '目录写入结果未确认，可能已经创建；请先核对远端，不自动重试。'
  if (result.status === 'cancelled')
    return result.submitted
      ? '操作已取消，但有写入提交标记；请先核对远端，不自动重试。'
      : '本次目录操作已取消，未提交目录写入。'
  return result.status === 'created'
    ? '末层目录已创建，并确认目标是目录集合。'
    : '目标目录已存在，并确认是目录集合；未覆盖已有内容。'
}
const leafName = (url?: string): string => {
  if (!url) return ''
  try {
    return new URL(url).pathname.split('/').at(-2) ?? ''
  } catch {
    return ''
  }
}

export function RelayWebdavDirectoryPanel({
  busy,
  onBusy
}: {
  busy: boolean
  onBusy(value: boolean): void
}): React.JSX.Element {
  const [accounts, setAccounts] = useState<RelayBackupAccount[]>(),
    [incomplete, setIncomplete] = useState(0),
    [selected, setSelected] = useState(''),
    [readAt, setReadAt] = useState(''),
    [plan, setPlan] = useState<RelayWebdavDirectoryPlan>(),
    [executing, setExecuting] = useState(false),
    [pending, setPending] = useState(false),
    [cancelling, setCancelling] = useState(false),
    [outcome, setOutcome] = useState<{
      plan: RelayWebdavDirectoryPlan
      result: RelayWebdavDirectoryResult
    }>(),
    [notice, setNotice] = useState(''),
    selectedRef = useRef<RelayBackupAccount | undefined>(undefined),
    proofRef = useRef<RelayWebdavDirectoryPlan | undefined>(undefined),
    operation = useRef(false),
    cancellingRef = useRef(false),
    ownedOperations = useRef(0),
    viewEpoch = useRef(0),
    lifecycleEpoch = useRef(0),
    cancellation = useRef<Promise<void>>(Promise.resolve())
  const account = accounts?.find((item) => item.id === selected),
    locked = busy || pending || cancelling,
    leaf = leafName(account?.directoryURL)
  useEffect(() => {
    const lifecycle = lifecycleEpoch,
      view = viewEpoch
    const remove = window.electron.ipcRenderer.on('relayBackupPreparationsInvalidated', () => {
      lifecycleEpoch.current++
      viewEpoch.current++
      proofRef.current = undefined
      selectedRef.current = undefined
      setPlan(undefined)
      setAccounts(undefined)
      setSelected('')
      setIncomplete(0)
      setReadAt('')
      setOutcome(undefined)
      setNotice('目录准备已撤销，请重新读取账号；在途写入仍需等待真实执行结果。')
    })
    return () => {
      lifecycle.current++
      view.current++
      remove()
    }
  }, [])
  const takeBusy = (): boolean => {
    if (!ownedOperations.current && busy) return false
    if (!ownedOperations.current) onBusy(true)
    ownedOperations.current++
    return true
  }
  const releaseBusy = (owned: boolean): void => {
    if (owned && --ownedOperations.current === 0) onBusy(false)
  }
  const cancelProof = (current?: RelayWebdavDirectoryPlan): Promise<void> => {
    if (!current) return cancellation.current.catch(() => {})
    const lifecycle = lifecycleEpoch.current,
      next = cancellation.current
        .catch(() => {})
        .then(async () => {
          if (lifecycle !== lifecycleEpoch.current) return
          await window.electron.ipcRenderer.invoke('relayBackupDirectoryCancel', {
            evidenceId: current.evidenceId
          })
        })
    cancellation.current = next
    return next
  }
  const clearPlan = (): Promise<void> => {
    const current = proofRef.current
    proofRef.current = undefined
    setPlan(undefined)
    return cancelProof(current)
  }
  const choose = (id: string): void => {
    const ticket = ++viewEpoch.current,
      lifecycle = lifecycleEpoch.current
    void clearPlan().catch(() => {
      if (ticket === viewEpoch.current && lifecycle === lifecycleEpoch.current)
        setNotice('旧目录准备取消未确认，请重新核对后再准备。')
    })
    selectedRef.current = accounts?.find((item) => item.id === id)
    setSelected(id)
    setOutcome(undefined)
    setNotice('已选择保存的公开目录设置；尚未解密凭据或联网。')
  }
  const run = async (action: 'read' | 'create'): Promise<void> => {
    if (operation.current || locked) return
    const chosen = selectedRef.current
    if (action === 'create' && (!chosen || !leafName(chosen.directoryURL))) return
    operation.current = true
    setPending(true)
    setOutcome(undefined)
    const owned = takeBusy(),
      ticket = ++viewEpoch.current,
      lifecycle = lifecycleEpoch.current
    let dispatched = false,
      prepared: RelayWebdavDirectoryPlan | undefined
    const current = (): boolean =>
      ticket === viewEpoch.current && lifecycle === lifecycleEpoch.current
    setNotice(action === 'read' ? '正在读取账号公开设置…' : '正在核对并创建所选账号的末层目录…')
    try {
      await clearPlan()
      if (!current()) return
      if (action === 'read') {
        const inventory = (await window.electron.ipcRenderer.invoke(
          'relayBackupAccountList'
        )) as RelayBackupAccountInventory
        if (!current()) return
        setAccounts(
          inventory.accounts.filter((item) => item.provider === 'webdav' && item.state === 'active')
        )
        setIncomplete(inventory.incomplete)
        selectedRef.current = undefined
        setSelected('')
        setReadAt(new Date().toISOString())
        setNotice('已读取公开账号设置，请选择账号；没有解密密码、联网或创建目录。')
      } else if (chosen) {
        prepared = (await window.electron.ipcRenderer.invoke('relayBackupDirectoryPrepare', {
          id: chosen.id,
          revision: chosen.revision
        })) as RelayWebdavDirectoryPlan
        if (
          !current() ||
          selectedRef.current?.id !== chosen.id ||
          selectedRef.current?.revision !== chosen.revision
        ) {
          if (lifecycle === lifecycleEpoch.current) await cancelProof(prepared)
          return
        }
        proofRef.current = prepared
        setPlan(prepared)
        setExecuting(true)
        dispatched = true
        const result = (await window.electron.ipcRenderer.invoke('relayBackupDirectoryExecute', {
          evidenceId: prepared.evidenceId
        })) as RelayWebdavDirectoryResult
        // A consumed write still reports its real terminal result after hide or
        // cancellation. This cannot publish a new executable preparation.
        setOutcome({ plan: prepared, result })
        setNotice('本次目录执行已结束，请核对下方实际结果。')
      }
    } catch {
      if (!dispatched && !current()) return
      proofRef.current = undefined
      setPlan(undefined)
      if (action === 'read') {
        setAccounts(undefined)
        setIncomplete(0)
        selectedRef.current = undefined
        setSelected('')
        setReadAt('')
      }
      setNotice(
        dispatched
          ? '目录执行结果未确认，请先核对远端；不会自动重试或改用其他目录。'
          : '账号读取或目录准备未确认，请重新核对账号修订、目标和当前操作状态。'
      )
    } finally {
      if (proofRef.current?.evidenceId === prepared?.evidenceId) proofRef.current = undefined
      setPlan(undefined)
      setExecuting(false)
      operation.current = false
      setPending(false)
      releaseBusy(owned)
    }
  }
  const cancel = async (): Promise<void> => {
    const current = proofRef.current
    if (!current || cancellingRef.current) return
    cancellingRef.current = true
    setCancelling(true)
    viewEpoch.current++
    const owned = takeBusy(),
      lifecycle = lifecycleEpoch.current
    setNotice('正在撤销本次目录操作权限，并等待匹配的在途操作结束…')
    try {
      await clearPlan()
      if (lifecycle !== lifecycleEpoch.current) return
      setNotice('本次目录操作权限已撤销；若曾提交写入，请以下方真实执行结果为准。')
    } catch {
      if (lifecycle !== lifecycleEpoch.current) return
      setNotice('目录取消结果未确认，请核对远端和执行结果；不会自动重试。')
    } finally {
      cancellingRef.current = false
      setCancelling(false)
      releaseBusy(owned)
    }
  }
  return (
    <section className="relay-panel">
      <h2>创建WebDAV账号目录末层</h2>
      <p>
        从已保存且启用的WebDAV账号读取固定目标。父目录必须已存在，仅创建末层目录，不递归创建、不覆盖已有内容。保存账号、备份上传或定时备份不会自动执行此操作。
      </p>
      <p>
        点击创建后核对本机范围并执行；主进程使用保存密码及指定本地HTTP代理，拒绝重定向，不回填密码，也不接受其他URL或路径。
      </p>
      <button disabled={locked} onClick={() => void run('read')}>
        读取可创建目录的WebDAV账号
      </button>
      {readAt && <p>公开账号设置读取于：{readAt}；不代表凭据有效或远端目录已存在。</p>}
      {incomplete > 0 && <p>有{incomplete}条账号记录未能确认，不会用于目录创建。</p>}
      {accounts && !accounts.length && <p>没有已保存且启用的WebDAV账号，请先保存账号。</p>}
      <fieldset disabled={locked}>
        <label>
          创建目录账号{' '}
          <select
            aria-label="创建目录账号"
            value={selected}
            onChange={(event) => choose(event.target.value)}
          >
            <option value="">请选择已保存的WebDAV账号</option>
            {accounts?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </label>
        {account && (
          <div>
            <p>固定目录：{account.directoryURL}</p>
            <p>末层名称（URL编码）：{leaf || '根目录无需创建'}</p>
            <p>
              公开用户名：{account.username} · 指定HTTP代理端口：{account.proxyPort}
            </p>
          </div>
        )}
        <button disabled={!account || !leaf} onClick={() => void run('create')}>
          创建账号目录末层
        </button>
      </fieldset>
      {plan && (
        <div>
          <p>
            本次账号：{plan.name} · 修订：{plan.revision}
          </p>
          <p>本次MKCOL目标：{plan.directoryURL}</p>
          <p>必须已存在的父目录：{plan.parentURL}</p>
          <p>
            公开用户名：{plan.username} · 固定HTTP代理端口：{plan.proxyPort}
          </p>
          <p>
            准备有效期至：{new Date(plan.expiresAt).toLocaleString()}
            。只创建此末层，不递归、不覆盖。
          </p>
        </div>
      )}
      {(plan || executing) && (
        <button disabled={cancelling || !proofRef.current} onClick={() => void cancel()}>
          撤销本次目录操作权限
        </button>
      )}
      {outcome && (
        <div>
          <h3>本次目录执行结果</h3>
          <p>执行目标：{outcome.plan.directoryURL}</p>
          <p>{resultLabel(outcome.result)}</p>
          {'verifiedAt' in outcome.result && (
            <p>目录确认时间：{new Date(outcome.result.verifiedAt).toLocaleString()}</p>
          )}
          {'httpStatus' in outcome.result && outcome.result.httpStatus !== undefined && (
            <p>服务器响应码：{outcome.result.httpStatus}（以实际结果分类为准）</p>
          )}
        </div>
      )}
      {!accounts && !readAt && <p>初始渲染不读取账号、不解密密码、不联网，也不会创建目录。</p>}
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}
