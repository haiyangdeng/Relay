import { useEffect, useRef, useState } from 'react'
import {
  backupAccountRemoteRequest,
  backupAccountRuntimeRequest,
  backupAccountSaveRequest,
  type RelayBackupAccount,
  type RelayBackupAccountInventory
} from '../../../../shared/relay/backup-accounts'
import type {
  RelayRemoteArchiveFormat,
  RelayRemoteBackupPlan,
  RelayRemoteBackupRequest,
  RelayRemoteBackupResult
} from '../../../../shared/relay/backup-remote'
import type {
  RelayRuntimeGistPlan,
  RelayRuntimeGistSource,
  RelayRuntimeGistResult
} from '../../../../shared/relay/runtime-gist'
import {
  runtimeGistDiscoveryRequest,
  runtimeGistDiscoveryEvidence,
  type RelayRuntimeGistDiscoveryPlan,
  type RelayRuntimeGistDiscoveryResult
} from '../../../../shared/relay/runtime-gist-discovery'
import { RelayRuntimeGistSourcePicker } from './runtime-gist-source'

export function RuntimeGistDiscoveryResults({
  result,
  disabled,
  onSelect,
  onNextPage
}: {
  result: Extract<RelayRuntimeGistDiscoveryResult, { status: 'listed' }>
  disabled: boolean
  onSelect(id: string): void
  onNextPage(page: number): void
}): React.JSX.Element {
  const nextPage = result.nextPage
  return (
    <div aria-label="旧运行Gist候选结果">
      <p>
        第{result.page}页，扫描{result.scanned}项，匹配{result.entries.length}个未验证候选；检查时间{' '}
        {new Date(result.checkedAt).toISOString()}
        。这里只读取本页元数据，不代表正文、所有权或写权限已验证。
      </p>
      {result.entries.length === 0 && <p>本页没有匹配候选；不会自动新建或继续翻页。</p>}
      {result.entries.map((entry) => (
        <div key={entry.id}>
          <p>
            {entry.id} · {entry.updatedAt} · 远端声明{entry.payloadBytes}字节 · 未验证候选
          </p>
          <button disabled={disabled} onClick={() => onSelect(entry.id)}>
            填入运行配置目标ID {entry.id}
          </button>
        </div>
      ))}
      {nextPage !== undefined && (
        <button disabled={disabled} onClick={() => onNextPage(nextPage)}>
          填写下一页页码（点击查找时读取）
        </button>
      )}
      {result.budgetReached ? (
        <p>已到客户端页码预算，仍可能有后续；不能视为已列完。</p>
      ) : (
        !result.moreAvailable && <p>本次响应未报告后续页面，不代表全账户完整枚举。</p>
      )}
    </div>
  )
}

export function RelayBackupAccountPanel({
  busy,
  remoteBusy,
  tunSessionId,
  onBusy,
  onPrepared,
  onRuntimePrepared,
  onInvalidate
}: {
  busy: boolean
  remoteBusy?: boolean
  tunSessionId?: string
  onBusy(value: boolean): void
  onPrepared(plan: RelayRemoteBackupPlan, result: RelayRemoteBackupResult): void
  onRuntimePrepared?(plan: RelayRuntimeGistPlan, result: RelayRuntimeGistResult): void
  onInvalidate?(): void
}): React.JSX.Element {
  const [runtimeSource, setRuntimeSource] = useState<RelayRuntimeGistSource>(),
    [inventory, setInventory] = useState<RelayBackupAccountInventory>(),
    [selected, setSelected] = useState<RelayBackupAccount>(),
    [provider, setProvider] = useState<'webdav' | 'gist'>('webdav'),
    [name, setName] = useState(''),
    [proxyPort, setProxyPort] = useState('17891'),
    [directoryURL, setDirectoryURL] = useState(''),
    [username, setUsername] = useState(''),
    [password, setPassword] = useState(''),
    [emptyPassword, setEmptyPassword] = useState(false),
    [token, setToken] = useState(''),
    [recipient, setRecipient] = useState(''),
    [archiveFormat, setArchiveFormat] = useState<RelayRemoteArchiveFormat>('relay-envelope'),
    [direction, setDirection] = useState<RelayRemoteBackupRequest['action']>('upload'),
    [filename, setFilename] = useState(''),
    [gistId, setGistId] = useState(''),
    [page, setPage] = useState('1'),
    [discoveryPage, setDiscoveryPage] = useState('1'),
    [discoveryPlan, setDiscoveryPlan] = useState<RelayRuntimeGistDiscoveryPlan>(),
    [discoveryResult, setDiscoveryResult] =
      useState<Extract<RelayRuntimeGistDiscoveryResult, { status: 'listed' }>>(),
    [discoveryCancelPending, setDiscoveryCancelPending] = useState(false),
    [secretKey, setSecretKey] = useState(''),
    [etag, setETag] = useState(''),
    [requiresRefresh, setRequiresRefresh] = useState(false),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState(''),
    operation = useRef(false),
    ownedOperations = useRef(0),
    ownsGlobalBusy = useRef(false),
    discoveryEvidence = useRef<string | undefined>(undefined),
    discoveryCancelling = useRef(false),
    generation = useRef(0),
    lifecycleEpoch = useRef(0),
    selectedRef = useRef<RelayBackupAccount | undefined>(undefined),
    cancellation = useRef<Promise<void>>(Promise.resolve())
  const legacyZIP =
      provider === 'webdav' && direction === 'download' && archiveFormat === 'legacy-zip',
    locked = busy || pending,
    remoteLocked = (remoteBusy ?? busy) || pending,
    sourceUnavailable =
      runtimeSource?.kind === 'tun-managed' && runtimeSource.sessionId !== tunSessionId,
    disabledAccount = selected?.state === 'disabled',
    dirty =
      !!selected &&
      (name !== selected.name ||
        provider !== selected.provider ||
        Number(proxyPort) !== selected.proxyPort ||
        directoryURL !== (selected.directoryURL ?? '') ||
        username !== (selected.username ?? '') ||
        recipient !== (selected.recipient ?? '') ||
        !!password ||
        !!token ||
        emptyPassword),
    canPrepare = !!selected && !disabledAccount && !dirty && !requiresRefresh
  useEffect(() => {
    const invalidateLifecycle = (): void => {
      lifecycleEpoch.current++
      generation.current++
      discoveryEvidence.current = undefined
    }
    const remove = window.electron.ipcRenderer.on('relayBackupPreparationsInvalidated', () => {
      invalidateLifecycle()
      setDiscoveryPlan(undefined)
      setDiscoveryResult(undefined)
      setDiscoveryPage('1')
      setInventory(undefined)
      setRequiresRefresh(true)
      setPassword('')
      setToken('')
      setSecretKey('')
      setArchiveFormat('relay-envelope')
      setEmptyPassword(false)
      setNotice('账号准备已撤销，瞬态秘密已清空；请重新读取账号后再选择。')
    })
    return () => {
      invalidateLifecycle()
      remove()
    }
  }, [])
  const beginOwned = (): void => {
    if (ownedOperations.current++ === 0) {
      ownsGlobalBusy.current = !busy
      if (ownsGlobalBusy.current) onBusy(true)
    }
    setPending(true)
  }
  const endOwned = (): void => {
    if (--ownedOperations.current !== 0) return
    setPending(false)
    if (ownsGlobalBusy.current) onBusy(false)
    ownsGlobalBusy.current = false
  }
  const cancelPrepared = (discoveryId?: string): Promise<void> => {
    const epoch = lifecycleEpoch.current
    const next = cancellation.current
      .catch(() => {})
      .then(async () => {
        if (epoch !== lifecycleEpoch.current) return
        await window.electron.ipcRenderer.invoke('relayBackupRemoteCancel')
        if (epoch !== lifecycleEpoch.current) return
        await window.electron.ipcRenderer.invoke('relayRuntimeGistCancel')
        if (epoch !== lifecycleEpoch.current) return
        if (discoveryId)
          await window.electron.ipcRenderer.invoke(
            'relayRuntimeGistDiscoveryCancel',
            runtimeGistDiscoveryEvidence({ evidenceId: discoveryId })
          )
      })
    cancellation.current = next
    return next
  }
  const invalidate = (): void => {
    generation.current++
    const discoveryId = discoveryEvidence.current
    discoveryEvidence.current = undefined
    setDiscoveryPlan(undefined)
    setDiscoveryResult(undefined)
    onInvalidate?.()
    void cancelPrepared(discoveryId).catch(() =>
      setNotice('旧准备取消未确认，请重新核对后再操作。')
    )
  }
  const choose = (account?: RelayBackupAccount): void => {
    invalidate()
    selectedRef.current = account
    setSelected(account)
    setProvider(account?.provider ?? 'webdav')
    setName(account?.name ?? '')
    setProxyPort(String(account?.proxyPort ?? 17891))
    setDirectoryURL(account?.directoryURL ?? '')
    setUsername(account?.username ?? '')
    setRecipient(account?.recipient ?? '')
    setPassword('')
    setToken('')
    setEmptyPassword(false)
    setSecretKey('')
    setFilename('')
    setGistId('')
    setETag('')
    setPage('1')
    setDiscoveryPage('1')
    setDirection('upload')
    setArchiveFormat('relay-envelope')
    setRequiresRefresh(false)
    setNotice(
      account ? '已选择账号的公开设置，凭据不会回填。' : '填写新账号；保存不会发起远程传输。'
    )
  }
  const remember = (account: RelayBackupAccount): void => {
    setInventory((current) => ({
      accounts: [...(current?.accounts ?? []).filter((item) => item.id !== account.id), account],
      incomplete: current?.incomplete ?? 0
    }))
    choose(account)
  }
  const action = async (
    kind: 'list' | 'save' | 'disable' | 'remote' | 'runtime'
  ): Promise<void> => {
    if (
      operation.current ||
      ownedOperations.current > 0 ||
      busy ||
      ((kind === 'remote' || kind === 'save' || kind === 'disable') && remoteBusy) ||
      (kind === 'runtime' && sourceUnavailable)
    )
      return
    if ((kind === 'remote' || kind === 'runtime') && !canPrepare) return
    operation.current = true
    beginOwned()
    invalidate()
    const epoch = generation.current,
      lifecycle = lifecycleEpoch.current,
      account = selected
    let mutationSent = false,
      remoteSent = false
    setNotice('正在处理本机账号设置或本次准备…')
    try {
      await cancelPrepared()
      if (lifecycle !== lifecycleEpoch.current) return
      if (kind === 'list') {
        const result = (await window.electron.ipcRenderer.invoke(
          'relayBackupAccountList'
        )) as RelayBackupAccountInventory
        if (lifecycle !== lifecycleEpoch.current) return
        setInventory(result)
        setRequiresRefresh(!!account)
        setNotice(`已读取${result.accounts.length}个账号的公开设置；请选择账号后编辑或准备传输。`)
      } else if (kind === 'save') {
        if (disabledAccount || requiresRefresh) return
        if (
          provider === 'webdav' &&
          !password &&
          !emptyPassword &&
          (!account || directoryURL !== account.directoryURL || username !== account.username)
        )
          throw new Error('请重新提供密码或明确使用空密码。')
        const request = backupAccountSaveRequest({
          ...(account ? { id: account.id, revision: account.revision } : {}),
          name,
          provider,
          proxyPort: Number(proxyPort),
          ...(provider === 'webdav'
            ? {
                directoryURL,
                username,
                ...(emptyPassword ? { password: '' } : password ? { password } : {})
              }
            : token
              ? { token }
              : {}),
          ...(recipient ? { recipient } : {})
        })
        mutationSent = true
        const result = (await window.electron.ipcRenderer.invoke(
          'relayBackupAccountSave',
          request
        )) as RelayBackupAccount
        if (lifecycle !== lifecycleEpoch.current) {
          setNotice('本机账号保存已返回；准备已撤销，请重新读取账号确认状态。')
          return
        }
        remember(result)
        setNotice('账号已在本机加密保存；尚未授权或发起远程传输。')
      } else if (kind === 'disable' && account && !disabledAccount && !requiresRefresh) {
        mutationSent = true
        const result = (await window.electron.ipcRenderer.invoke('relayBackupAccountDisable', {
          id: account.id,
          revision: account.revision
        })) as RelayBackupAccount
        if (lifecycle !== lifecycleEpoch.current) {
          setNotice('本机账号停用已返回；请重新读取账号确认状态。')
          return
        }
        remember(result)
        setNotice('账号已停用，不能再用于准备传输；本机历史加密记录仍保留。')
      } else if (account && (kind === 'remote' || (kind === 'runtime' && onRuntimePrepared))) {
        const selection = { id: account.id, revision: account.revision }
        const request =
          kind === 'runtime'
            ? backupAccountRuntimeRequest({
                ...selection,
                ...(runtimeSource ? { source: runtimeSource } : {}),
                ...(gistId ? { gistId } : {})
              })
            : backupAccountRemoteRequest({
                ...selection,
                action: direction,
                ...(provider === 'webdav' && direction !== 'list' ? { filename } : {}),
                ...(provider === 'gist' && direction === 'download' ? { gistId } : {}),
                ...(provider === 'gist' && direction === 'list' ? { page: Number(page) } : {}),
                ...(provider === 'webdav' && direction === 'download' ? { archiveFormat } : {}),
                ...(direction === 'download' && !legacyZIP && secretKey ? { secretKey } : {}),
                ...(direction === 'delete' ? { etag } : {})
              })
        const result = await window.electron.ipcRenderer.invoke(
          kind === 'remote'
            ? 'relayBackupAccountPrepareRemote'
            : 'relayBackupAccountPrepareRuntime',
          request
        )
        if (
          epoch !== generation.current ||
          selectedRef.current?.revision !== account.revision ||
          selectedRef.current?.id !== account.id
        ) {
          if (lifecycle === lifecycleEpoch.current)
            await window.electron.ipcRenderer.invoke(
              kind === 'remote' ? 'relayBackupRemoteCancel' : 'relayRuntimeGistCancel'
            )
          setNotice('账号选择已变化，本次准备已取消，请重新核对。')
          return
        }
        remoteSent = true
        if (kind === 'remote') {
          const plan = result as RelayRemoteBackupPlan
          const outcome = (await window.electron.ipcRenderer.invoke('relayBackupRemoteExecute', {
            evidenceId: plan.evidenceId
          })) as RelayRemoteBackupResult
          if (lifecycle !== lifecycleEpoch.current || epoch !== generation.current) return
          onPrepared(plan, outcome)
        } else {
          const plan = result as RelayRuntimeGistPlan
          const outcome = (await window.electron.ipcRenderer.invoke('relayRuntimeGistExecute', {
            evidenceId: plan.evidenceId
          })) as RelayRuntimeGistResult
          if (lifecycle !== lifecycleEpoch.current || epoch !== generation.current) return
          onRuntimePrepared?.(plan, outcome)
        }
        setNotice('本次操作已结束，实际结果见传输面板。')
      }
    } catch {
      if (mutationSent) {
        setInventory(undefined)
        setRequiresRefresh(!!account)
      }
      setNotice(
        remoteSent
          ? '远程执行结果未确认，请先核对远端后再操作；不会自动重试。'
          : '操作未确认；请核对输入或重新读取账号后再选择。凭据不会回填，没有自动传输或重试。'
      )
    } finally {
      if (kind === 'save') {
        setPassword('')
        setToken('')
        setEmptyPassword(false)
      }
      if (kind === 'remote') setSecretKey('')
      operation.current = false
      endOwned()
    }
  }
  const discoveryAction = async (): Promise<void> => {
    if (
      operation.current ||
      ownedOperations.current > 0 ||
      busy ||
      !canPrepare ||
      provider !== 'gist' ||
      !selected
    )
      return
    const account = selected
    operation.current = true
    beginOwned()
    invalidate()
    const epoch = generation.current,
      lifecycle = lifecycleEpoch.current
    const current = (): boolean =>
      lifecycle === lifecycleEpoch.current &&
      epoch === generation.current &&
      selectedRef.current?.id === account.id &&
      selectedRef.current?.revision === account.revision
    let plan: RelayRuntimeGistDiscoveryPlan | undefined
    setNotice('正在读取本页旧运行Gist候选元数据…')
    try {
      await cancelPrepared()
      if (!current()) return
      plan = (await window.electron.ipcRenderer.invoke(
        'relayRuntimeGistDiscoveryPrepare',
        runtimeGistDiscoveryRequest({
          id: account.id,
          revision: account.revision,
          page: Number(discoveryPage)
        })
      )) as RelayRuntimeGistDiscoveryPlan
      if (!current()) {
        if (lifecycle === lifecycleEpoch.current)
          await window.electron.ipcRenderer.invoke(
            'relayRuntimeGistDiscoveryCancel',
            runtimeGistDiscoveryEvidence({ evidenceId: plan.evidenceId })
          )
        return
      }
      if (Date.now() >= plan.expiresAt || Date.now() < plan.expiresAt - 60000)
        throw new Error('本页读取凭据已过期。')
      discoveryEvidence.current = plan.evidenceId
      setDiscoveryPlan(plan)
      const result = (await window.electron.ipcRenderer.invoke(
        'relayRuntimeGistDiscoveryExecute',
        runtimeGistDiscoveryEvidence({ evidenceId: plan.evidenceId })
      )) as RelayRuntimeGistDiscoveryResult
      if (!current()) return
      if (result.status === 'listed') {
        if (
          result.account.id !== account.id ||
          result.account.revision !== account.revision ||
          result.page !== plan.page
        )
          throw new Error('候选所属账号或页码变化。')
        setDiscoveryResult(result)
        setNotice('已读取本页未验证候选；没有默认选择、正文读取、创建、上传或同步授权。')
      } else setNotice('本页候选检查已取消。')
    } catch {
      if (current()) {
        setDiscoveryResult(undefined)
        setNotice('旧运行Gist候选检查未确认；请重新核对账号修订与页码，不自动重试或新建。')
      }
    } finally {
      if (discoveryEvidence.current === plan?.evidenceId) discoveryEvidence.current = undefined
      setDiscoveryPlan(undefined)
      operation.current = false
      endOwned()
    }
  }
  const cancelDiscovery = async (): Promise<void> => {
    const evidenceId = discoveryEvidence.current
    if (!evidenceId || discoveryCancelling.current) return
    discoveryCancelling.current = true
    setDiscoveryCancelPending(true)
    discoveryEvidence.current = undefined
    generation.current++
    setDiscoveryPlan(undefined)
    setDiscoveryResult(undefined)
    beginOwned()
    const lifecycle = lifecycleEpoch.current
    try {
      await window.electron.ipcRenderer.invoke(
        'relayRuntimeGistDiscoveryCancel',
        runtimeGistDiscoveryEvidence({ evidenceId })
      )
      if (lifecycle === lifecycleEpoch.current)
        setNotice('本页候选准备已取消；在途读取已收尾，不授予上传或同步权限。')
    } catch {
      if (lifecycle === lifecycleEpoch.current)
        setNotice('本页候选取消未确认，旧结果已清除；请人工核对，不自动重试。')
    } finally {
      discoveryCancelling.current = false
      setDiscoveryCancelPending(false)
      endOwned()
    }
  }
  return (
    <section className="relay-panel">
      <h3>已保存的备份账号</h3>
      <p>
        密码与Token在本机加密保存，不会回填到输入框。保存账号与单次传输授权分开；点击所选操作即执行，不自动调度。
      </p>
      <p>
        旧运行配置Gist候选需先选择已保存Gist账号，再点击查找。本页列表不代表可安全覆盖；填入ID不会自动上传、创建或启用同步。
      </p>
      <button disabled={locked} onClick={() => void action('list')}>
        读取已保存账号
      </button>
      <button disabled={locked} onClick={() => choose()}>
        新建备份账号
      </button>
      {inventory && (
        <>
          {inventory.incomplete > 0 && (
            <p>有{inventory.incomplete}条账号记录未能确认，请人工核对；不会自动认领。</p>
          )}
          <ul>
            {inventory.accounts.map((account) => (
              <li key={account.id}>
                <span>
                  {account.name} · {account.provider === 'webdav' ? 'WebDAV' : 'Gist'} ·{' '}
                  {account.state === 'active' ? '已保存' : '已停用'}
                </span>{' '}
                <button disabled={locked} onClick={() => choose(account)}>
                  选择{account.name}
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      <fieldset disabled={remoteLocked || disabledAccount} onChange={invalidate}>
        <label>
          账号名称 <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label>
          账号提供者{' '}
          <select
            aria-label="账号提供者"
            disabled={!!selected}
            value={provider}
            onChange={(event) => {
              setProvider(event.target.value as 'webdav' | 'gist')
              setPassword('')
              setToken('')
              setEmptyPassword(false)
            }}
          >
            <option value="webdav">WebDAV</option>
            <option value="gist">Gist</option>
          </select>
        </label>
        <label>
          账号代理端口{' '}
          <input
            inputMode="numeric"
            value={proxyPort}
            onChange={(event) => setProxyPort(event.target.value)}
          />
        </label>
        {provider === 'webdav' ? (
          <>
            <label>
              账号HTTPS目录{' '}
              <input
                value={directoryURL}
                placeholder="https://dav.example/Relay/"
                onChange={(event) => setDirectoryURL(event.target.value)}
              />
            </label>
            <label>
              账号用户名{' '}
              <input
                autoComplete="off"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
            <label>
              账号密码{selected ? '（留空沿用）' : ''}{' '}
              <input
                aria-label="账号密码"
                type="password"
                autoComplete="new-password"
                value={password}
                disabled={emptyPassword}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <label>
              <input
                type="checkbox"
                checked={emptyPassword}
                onChange={(event) => {
                  setEmptyPassword(event.target.checked)
                  setPassword('')
                }}
              />
              明确使用空密码
            </label>
            <p>目录须以斜杠结尾。更改目录或用户名时，请重新输入密码，或明确选择空密码。</p>
          </>
        ) : (
          <label>
            账号GitHub Token{selected ? '（留空沿用）' : ''}{' '}
            <input
              aria-label="账号GitHub Token"
              type="password"
              autoComplete="new-password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
        )}
        {!legacyZIP && (
          <label>
            账号AGE接收者（可选）{' '}
            <input
              value={recipient}
              placeholder="age1…"
              onChange={(event) => setRecipient(event.target.value)}
            />
          </label>
        )}
      </fieldset>
      <button
        disabled={remoteLocked || disabledAccount || requiresRefresh || !name.trim()}
        onClick={() => void action('save')}
      >
        {selected ? '保存账号修改' : '保存新账号'}
      </button>
      <button
        disabled={remoteLocked || !selected || disabledAccount || requiresRefresh}
        onClick={() => void action('disable')}
      >
        停用所选账号
      </button>
      {disabledAccount && <p>此账号已停用，仅可查看公开设置。需要再次使用时，请新建账号。</p>}
      {dirty && <p>账号设置有未保存更改，请先保存或重新选择账号，再准备传输。</p>}
      <fieldset disabled={remoteLocked || !canPrepare} onChange={invalidate}>
        <legend>使用所选账号准备一次操作</legend>
        <label>
          账号备份操作{' '}
          <select
            aria-label="账号备份操作"
            value={direction}
            onChange={(event) => {
              setDirection(event.target.value as RelayRemoteBackupRequest['action'])
              setArchiveFormat('relay-envelope')
            }}
          >
            <option value="upload">创建新备份</option>
            <option value="download">读取指定备份</option>
            <option value="list">列出备份候选</option>
            {provider === 'webdav' && <option value="delete">永久删除指定文件</option>}
          </select>
        </label>
        {provider === 'webdav' && direction === 'download' && (
          <label>
            账号下载归档格式{' '}
            <select
              aria-label="账号下载归档格式"
              value={archiveFormat}
              onChange={(event) => {
                const format = event.target.value as RelayRemoteArchiveFormat
                setArchiveFormat(format)
                if (format === 'legacy-zip') setSecretKey('')
              }}
            >
              <option value="relay-envelope">Relay备份封装（默认）</option>
              <option value="legacy-zip">旧Clash Party ZIP迁移</option>
            </select>
          </label>
        )}
        {legacyZIP && (
          <p>
            旧ZIP不使用整包AGE密钥；账号已保存接收者不会参与本次下载或被修改。点击下载后在传输面板查看报告，再选择是否恢复。
          </p>
        )}
        {provider === 'webdav' && direction !== 'list' && (
          <label>
            {direction === 'upload' ? '账号目录内新文件名（.json）' : '账号目录内文件名'}{' '}
            <input
              value={filename}
              placeholder="backup-unique.json"
              onChange={(event) => setFilename(event.target.value)}
            />
          </label>
        )}
        {provider === 'gist' && (direction === 'download' || !!onRuntimePrepared) && (
          <label>
            账号操作目标Gist ID（运行配置留空新建）{' '}
            <input value={gistId} onChange={(event) => setGistId(event.target.value)} />
          </label>
        )}
        {provider === 'gist' && direction === 'list' && (
          <label>
            账号列表页码{' '}
            <input
              inputMode="numeric"
              value={page}
              onChange={(event) => setPage(event.target.value)}
            />
          </label>
        )}
        {direction === 'download' && !legacyZIP && (
          <label>
            本次账号下载AGE私钥（不保存）{' '}
            <input
              type="password"
              autoComplete="new-password"
              value={secretKey}
              onChange={(event) => setSecretKey(event.target.value)}
            />
          </label>
        )}
        {direction === 'delete' && (
          <label>
            账号目标强ETag <input value={etag} onChange={(event) => setETag(event.target.value)} />
          </label>
        )}
      </fieldset>
      <button disabled={remoteLocked || !canPrepare} onClick={() => void action('remote')}>
        {direction === 'upload'
          ? '用所选账号上传新备份'
          : direction === 'download'
            ? '用所选账号下载备份'
            : direction === 'delete'
              ? '用所选账号删除指定文件'
              : '用所选账号读取本页备份'}
      </button>
      {onRuntimePrepared && provider === 'gist' && (
        <fieldset disabled={locked || !canPrepare} onChange={invalidate}>
          <RelayRuntimeGistSourcePicker
            label="账号运行配置来源"
            source={runtimeSource}
            tunSessionId={tunSessionId}
            onChange={setRuntimeSource}
          />
          {remoteBusy && (
            <label>
              账号运行配置目标Gist ID（留空新建）{' '}
              <input value={gistId} onChange={(event) => setGistId(event.target.value)} />
            </label>
          )}
          <button disabled={sourceUnavailable} onClick={() => void action('runtime')}>
            用所选账号上传运行配置
          </button>
        </fieldset>
      )}
      {provider === 'gist' && selected && (
        <section aria-label="旧运行Gist候选发现">
          <h4>查找旧运行配置Gist候选</h4>
          <p>
            仅筛选同描述的非公开单文件元数据，不读取正文或AGE密钥。即使只有一项也不默认选中，后续点击上传时仍实时校验目标。
          </p>
          <fieldset disabled={locked || !canPrepare} onChange={invalidate}>
            <label>
              旧运行Gist候选页码{' '}
              <input
                value={discoveryPage}
                inputMode="numeric"
                onChange={(event) => {
                  setDiscoveryPage(event.target.value)
                  setNotice('候选页码已变化；旧准备和结果已清除，点击查找时重新读取。')
                }}
              />
            </label>
            <button onClick={() => void discoveryAction()}>查找本页旧运行Gist候选</button>
          </fieldset>
          {discoveryPlan && (
            <div>
              <p>
                本次读取：账号 {discoveryPlan.name}，第{discoveryPlan.page}
                页，每页最多100项；代理端口
                {discoveryPlan.proxyPort}。只读固定列表元数据，不授予上传或同步权限。
              </p>
            </div>
          )}
          {discoveryResult && (
            <RuntimeGistDiscoveryResults
              result={discoveryResult}
              disabled={locked || !canPrepare}
              onSelect={(id) => {
                invalidate()
                setGistId(id)
                setNotice(
                  '仅已填入运行配置目标ID；未准备上传、未新建、未启用同步。需要写入时仍须另外明确授权。'
                )
              }}
              onNextPage={(next) => {
                invalidate()
                setDiscoveryPage(String(next))
                setNotice('仅已填写下一页页码；点击查找时重新读取，不自动翻页。')
              }}
            />
          )}
          <button
            disabled={!discoveryEvidence.current || discoveryCancelPending}
            onClick={() => void cancelDiscovery()}
          >
            取消本页运行Gist候选准备
          </button>
        </section>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}
