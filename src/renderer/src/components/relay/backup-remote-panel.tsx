import { useEffect, useRef, useState } from 'react'
import type {
  RelayRemoteArchiveFormat,
  RelayRemoteBackupPlan,
  RelayRemoteBackupRequest,
  RelayRemoteBackupResult,
  RelayRemoteBackupListing
} from '../../../../shared/relay/backup-remote'
import type { LegacyClashMigrationReport } from '../../../../shared/relay/legacy-clash'
import type {
  RelayBackupRestorePlan,
  RelayBackupResult,
  RelayBackupKeyExportResult
} from '../../../../shared/relay/backup'
import { LegacyClashMigrationSummary } from './backup-panel'

export function remoteBackupResultMessage(
  plan: RelayRemoteBackupPlan,
  result: RelayRemoteBackupResult
): string {
  return result.status === 'deleted'
    ? '指定远端文件已条件删除，并确认当前不存在；本地数据未更改。'
    : result.status === 'conflict'
      ? '目标缺少一致的强ETag、不是普通文件或已变化，删除未执行。请重新读取目录核对。'
      : result.status === 'listed'
        ? '已读取本页备份候选元数据，未读取正文或校验可恢复性。选择ID后可下载，恢复是独立操作。'
        : result.status === 'uploaded'
          ? `远程新备份已上传并读回核对${result.gistId ? `，Gist ID：${result.gistId}` : ''}。尚未安装或应用任何配置。`
          : result.status === 'inspected'
            ? '旧Clash ZIP检查完成，没有可写入候选；请查看逐项报告，原件记录已保留，当前数据未替换。'
            : result.status === 'prepared'
              ? '已下载并完成本地预检；可查看结果后选择恢复，当前数据未替换。'
              : result.status === 'uncertain'
                ? plan.action === 'delete'
                  ? '远端删除结果未确认，文件可能已经删除；请先重新核对远端，不能自动重试。'
                  : `远程写入结果未确认${result.gistId ? `，Gist ID：${result.gistId}` : ''}。可能已经创建备份，请先核对，不能自动重试。`
                : '本次远程传输已取消。'
}

export function RelayRemoteBackupPanel({
  busy,
  onBusy,
  restoreNotice,
  onRestoreNotice,
  externalPreparation
}: {
  busy: boolean
  onBusy(value: boolean): void
  restoreNotice?: string
  onRestoreNotice(value: string): void
  externalPreparation?: { plan?: RelayRemoteBackupPlan; result?: RelayRemoteBackupResult }
}): React.JSX.Element {
  const [provider, setProvider] = useState<'webdav' | 'gist'>('webdav')
  const [archiveFormat, setArchiveFormat] = useState<RelayRemoteArchiveFormat>('relay-envelope')
  const [report, setReport] = useState<LegacyClashMigrationReport>(),
    [migrationId, setMigrationId] = useState<string>()
  const [direction, setDirection] = useState<RelayRemoteBackupRequest['action']>('upload')
  const [page, setPage] = useState('1'),
    [listing, setListing] = useState<RelayRemoteBackupListing>()
  const [url, setURL] = useState(''),
    [username, setUsername] = useState(''),
    [password, setPassword] = useState('')
  const [gistId, setGistId] = useState(''),
    [token, setToken] = useState('')
  const [recipient, setRecipient] = useState(''),
    [secretKey, setSecretKey] = useState('')
  const [proxyPort, setProxyPort] = useState('17891')
  const [etag, setETag] = useState('')
  const [plan, setPlan] = useState<RelayRemoteBackupPlan>(),
    [restore, setRestore] = useState<RelayBackupRestorePlan>()
  const [pending, setPending] = useState(false),
    [notice, setNotice] = useState('')
  const operation = useRef(false)
  const preparationEpoch = useRef(0)
  const locked = busy || pending,
    legacyZIP = provider === 'webdav' && direction === 'download' && archiveFormat === 'legacy-zip'
  const visibleNotice = notice || restoreNotice
  useEffect(() => {
    const lifecycle = preparationEpoch
    const remove = window.electron.ipcRenderer.on('relayBackupPreparationsInvalidated', () => {
      preparationEpoch.current++
      setPlan(undefined)
      setRestore(undefined)
      setListing(undefined)
      setReport(undefined)
      setMigrationId(undefined)
      setRecipient('')
      setArchiveFormat('relay-envelope')
      setPassword('')
      setToken('')
      setSecretKey('')
      setNotice('本次远程准备已撤销，请重新准备；在途写入需要等待真实结果。')
    })
    return () => {
      lifecycle.current++
      remove()
    }
  }, [])
  useEffect(() => {
    if (!externalPreparation) return
    preparationEpoch.current++
    setReport(undefined)
    setMigrationId(undefined)
    setPlan(undefined)
    setArchiveFormat(externalPreparation.plan?.archiveFormat ?? 'relay-envelope')
    if (externalPreparation.plan?.archiveFormat === 'legacy-zip') {
      setProvider('webdav')
      setDirection('download')
      setRecipient('')
    }
    setRestore(undefined)
    setListing(undefined)
    setPassword('')
    setToken('')
    setSecretKey('')
    if (externalPreparation.plan && externalPreparation.result) {
      setRestore(externalPreparation.result.plan)
      setListing(externalPreparation.result.listing)
      setReport(externalPreparation.result.report)
      setMigrationId(externalPreparation.result.migrationId)
      setNotice(remoteBackupResultMessage(externalPreparation.plan, externalPreparation.result))
    } else setNotice('账号设置或选择已变化，旧结果已清除。')
  }, [externalPreparation])
  const invalidate = (): void => {
    preparationEpoch.current++
    setReport(undefined)
    setMigrationId(undefined)
    setListing(undefined)
    if (!plan && !restore) return
    setPlan(undefined)
    setRestore(undefined)
    void window.electron.ipcRenderer.invoke('relayBackupRemoteCancel').catch(() => {})
    if (restore) void window.electron.ipcRenderer.invoke('relayBackupCancel').catch(() => {})
  }
  const cancel = async (): Promise<void> => {
    const epoch = ++preparationEpoch.current
    setPlan(undefined)
    try {
      await window.electron.ipcRenderer.invoke('relayBackupRemoteCancel')
      if (epoch !== preparationEpoch.current) return
      if (restore) await window.electron.ipcRenderer.invoke('relayBackupCancel')
      setRestore(undefined)
      setListing(undefined)
      setReport(undefined)
      setMigrationId(undefined)
      setNotice('已请求取消；已提交的写入以真实结果为准，不会自动重试。')
    } catch {
      if (epoch === preparationEpoch.current)
        setNotice('取消结果未确认，请核对远端或本地恢复状态。')
    }
  }
  const action = async (kind: 'transfer' | 'restore' | 'key'): Promise<void> => {
    if (operation.current || busy) return
    operation.current = true
    setPending(true)
    onBusy(true)
    onRestoreNotice('')
    const epoch = preparationEpoch.current
    setNotice('正在执行本次操作并检查完整性…')
    try {
      if (kind === 'key') {
        const result = (await window.electron.ipcRenderer.invoke(
          'relayBackupKeyExport'
        )) as RelayBackupKeyExportResult
        if (result.status === 'exported') {
          if (plan && epoch === preparationEpoch.current) {
            await window.electron.ipcRenderer.invoke('relayBackupRemoteCancel').catch(() => {})
            setPlan(undefined)
          }
          setRecipient(result.recipient)
          setNotice('新私钥已保存，新公钥已填入。请保留旧私钥以解密旧备份；尚未上传或更改远端。')
        } else setNotice('已取消新密钥导出，原有接收者未更改。')
      } else if (kind === 'transfer') {
        setPlan(undefined)
        setRestore(undefined)
        setListing(undefined)
        setReport(undefined)
        setMigrationId(undefined)
        const request: RelayRemoteBackupRequest = {
          provider,
          action: direction,
          proxyPort: Number(proxyPort),
          ...(provider === 'webdav'
            ? { url, username, password }
            : { token, ...(direction === 'download' ? { gistId } : {}) }),
          ...(direction === 'upload' && recipient ? { recipient } : {}),
          ...(provider === 'webdav' && direction === 'download' ? { archiveFormat } : {}),
          ...(direction === 'download' && !legacyZIP && secretKey ? { secretKey } : {}),
          ...(direction === 'list' && provider === 'gist' ? { page: Number(page) } : {}),
          ...(direction === 'delete' ? { etag } : {})
        }
        try {
          const prepared = (await window.electron.ipcRenderer.invoke(
            'relayBackupRemotePrepare',
            request
          )) as RelayRemoteBackupPlan
          if (epoch !== preparationEpoch.current) return
          setPlan(prepared)
          const result = (await window.electron.ipcRenderer.invoke('relayBackupRemoteExecute', {
            evidenceId: prepared.evidenceId
          })) as RelayRemoteBackupResult
          setPlan(undefined)
          if (epoch === preparationEpoch.current) {
            setRestore(result.plan)
            setListing(result.listing)
            setReport(result.report)
            setMigrationId(result.migrationId)
          } else if (
            result.status === 'prepared' ||
            result.status === 'inspected' ||
            result.status === 'listed'
          )
            return
          setNotice(remoteBackupResultMessage(prepared, result))
        } finally {
          setPassword('')
          setToken('')
          setSecretKey('')
        }
      } else if (kind === 'restore' && restore) {
        const current = restore
        setRestore(undefined)
        const result = (await window.electron.ipcRenderer.invoke('relayBackupRestore', {
          id: current.id
        })) as RelayBackupResult
        const message =
          result.status === 'restored'
            ? '私有数据恢复完成；原件已保留，尚未启动核心或应用系统配置。'
            : result.status === 'uncertain'
              ? '恢复结果未确认。保留原件和日志，请人工核对，不得自动续作。'
              : '恢复已取消。'
        if (result.status === 'restored') onRestoreNotice(message)
        setNotice(message)
      }
    } catch {
      if (kind === 'key') {
        setNotice('新密钥未确认保存，请选择不存在的新文件名，或等待其他操作结束后重试。')
        return
      }
      setPlan(undefined)
      setRestore(undefined)
      setNotice(
        '操作未确认：请检查地址、凭据、加密密钥、备份大小与完整性，或等待其他操作结束。远程写入失败时请先核对目标，不能自动重试。'
      )
    } finally {
      operation.current = false
      setPending(false)
      onBusy(false)
    }
  }
  return (
    <section className="relay-panel">
      <h2>WebDAV／Gist远程备份</h2>
      <p>
        点击读取、上传或删除后，通过指定本地HTTP代理传输；拒绝重定向，失败后不直连、不自动重试。凭据只在本次内存中保留。
      </p>
      <p>
        备份可能包含密码与密钥。Gist的“非公开”仍可被持有链接者读取，因此必须提供AGE接收者加密；下载需原AGE私钥。Gist限完整ZIP
        512KiB，超限请用WebDAV或本地导出。
      </p>
      {!legacyZIP && (
        <button disabled={locked} onClick={() => void action('key')}>
          生成新AGE密钥并导出私钥
        </button>
      )}
      <p>
        新密钥不能解密旧备份。私钥仅保存到原生选择的新文件，界面只接收公钥；请妥善保留新旧私钥。
      </p>
      <fieldset disabled={locked} onChange={invalidate}>
        <label>
          提供者{' '}
          <select
            value={provider}
            onChange={(event) => {
              setProvider(event.target.value as 'webdav' | 'gist')
              setArchiveFormat('relay-envelope')
              if (event.target.value === 'gist' && direction === 'delete') setDirection('upload')
            }}
          >
            <option value="webdav">WebDAV</option>
            <option value="gist">Gist（非公开、AGE加密）</option>
          </select>
        </label>
        <label>
          操作{' '}
          <select
            value={direction}
            onChange={(event) => {
              setDirection(event.target.value as RelayRemoteBackupRequest['action'])
              setArchiveFormat('relay-envelope')
            }}
          >
            <option value="upload">创建新备份</option>
            <option value="download">读取指定备份</option>
            <option value="list">
              {provider === 'gist' ? '列出本账户备份候选' : '列出指定目录备份候选'}
            </option>
            {provider === 'webdav' && <option value="delete">永久删除指定文件</option>}
          </select>
        </label>
        {provider === 'webdav' && direction === 'download' && (
          <label>
            下载归档格式{' '}
            <select
              aria-label="下载归档格式"
              value={archiveFormat}
              onChange={(event) => {
                const format = event.target.value as RelayRemoteArchiveFormat
                setArchiveFormat(format)
                if (format === 'legacy-zip') {
                  setRecipient('')
                  setSecretKey('')
                }
              }}
            >
              <option value="relay-envelope">Relay备份封装（默认）</option>
              <option value="legacy-zip">旧Clash Party ZIP迁移</option>
            </select>
          </label>
        )}
        {legacyZIP && (
          <p>
            显式读取旧Clash
            ZIP，不使用整包AGE密钥。先检查逐项迁移报告，有候选时可选择本地恢复；现代封装解析失败不会转为旧ZIP。
          </p>
        )}
        <label>
          本地HTTP代理端口{' '}
          <input
            value={proxyPort}
            onChange={(event) => setProxyPort(event.target.value)}
            inputMode="numeric"
          />
        </label>
        {provider === 'webdav' ? (
          <>
            <label>
              HTTPS指定{direction === 'list' ? '目录' : '文件'}地址{' '}
              <input
                value={url}
                onChange={(event) => setURL(event.target.value)}
                placeholder={
                  direction === 'list'
                    ? 'https://dav.example/Relay/'
                    : 'https://dav.example/Relay/backup-unique.json'
                }
              />
            </label>
            <label>
              本次用户名{' '}
              <input
                autoComplete="off"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </label>
            <label>
              本次密码{' '}
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <p>
              {direction === 'list'
                ? '目录地址须以斜杠结尾；仅列单层最多1000项、1MiB元数据，不递归、不读取正文。结果均未验证；选择旧ZIP后须显式检查迁移报告，不能直接恢复。'
                : '只操作指定文件，不创建目录。上传使用仅新建条件，目标已存在时请换新文件名；服务端须支持该条件。'}
            </p>
          </>
        ) : (
          <>
            {direction === 'list' && (
              <label>
                本次列表页码（每页最多100项）
                <input
                  inputMode="numeric"
                  value={page}
                  onChange={(event) => setPage(event.target.value)}
                />
              </label>
            )}
            {direction === 'download' && (
              <label>
                指定Gist ID{' '}
                <input value={gistId} onChange={(event) => setGistId(event.target.value)} />
              </label>
            )}
            <label>
              本次GitHub Token{' '}
              <input
                type="password"
                autoComplete="new-password"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
            <p>
              可列出本账户的备份候选、创建新的非公开Gist或读取指定ID；不覆盖或删除既有Gist。Token需相应Gists权限。
            </p>
          </>
        )}
        {direction === 'upload' ? (
          <label>
            AGE接收者{provider === 'webdav' ? '（可选，建议加密）' : '（必填）'}{' '}
            <input
              value={recipient}
              onChange={(event) => setRecipient(event.target.value)}
              placeholder="age1…"
            />
          </label>
        ) : direction === 'download' && !legacyZIP ? (
          <label>
            本次AGE私钥（加密备份必填）{' '}
            <input
              type="password"
              autoComplete="new-password"
              value={secretKey}
              onChange={(event) => setSecretKey(event.target.value)}
              placeholder="AGE-SECRET-KEY-1…"
            />
          </label>
        ) : direction === 'delete' ? (
          <label>
            目标强ETag（含双引号，需与目录候选一致）{' '}
            <input
              value={etag}
              onChange={(event) => setETag(event.target.value)}
              placeholder={'"file-version"'}
            />
          </label>
        ) : direction === 'list' ? (
          <p>列表只读取元数据，无需AGE私钥。每次需重新输入凭据。</p>
        ) : null}
        <button onClick={() => void action('transfer')}>
          {direction === 'upload'
            ? '上传新备份'
            : direction === 'download'
              ? '下载并检查备份'
              : direction === 'delete'
                ? '删除指定远端文件'
                : '读取本页备份'}
        </button>
      </fieldset>
      {plan && (
        <div>
          <p>
            本次操作：
            {plan.action === 'delete'
              ? '永久删除指定文件'
              : plan.action === 'list'
                ? '列出本页备份候选'
                : plan.action === 'upload'
                  ? '上传新备份'
                  : '读取备份'}{' '}
            → {plan.endpoint}
            ；代理端口 {plan.proxyPort}；
            {plan.containsSecrets
              ? plan.encrypted
                ? 'AGE加密'
                : '未加密，包含敏感配置'
              : plan.action === 'delete'
                ? `条件删除，绑定ETag ${plan.etag}`
                : plan.action === 'download'
                  ? plan.archiveFormat === 'legacy-zip'
                    ? '旧Clash ZIP迁移检查，不使用整包AGE密钥'
                    : 'Relay备份封装下载'
                  : '只读元数据，将发送本次凭据'}
            。
          </p>
          {plan.action === 'download' && (
            <p>
              绑定下载格式：
              {plan.archiveFormat === 'legacy-zip' ? '旧Clash Party ZIP迁移' : 'Relay备份封装'}
              ，不会自动切换格式。
            </p>
          )}
        </div>
      )}
      {report && <LegacyClashMigrationSummary report={report} />}
      {migrationId && <p>本次迁移原件记录：{migrationId}</p>}
      {restore && (
        <div>
          <p>
            本地恢复预检：{restore.files}项；替换{restore.replacedFiles}项；移出
            {restore.removedFiles}项。备份未包含的白名单数据将移入原件记录。摘要：
            {restore.archiveSHA256.slice(0, 16)}。
          </p>
          <button disabled={locked} onClick={() => void action('restore')}>
            恢复此备份
          </button>
        </div>
      )}
      {listing && 'directoryURL' in listing && (
        <div>
          <p>
            目录 {listing.directoryURL}，扫描{listing.scanned}项，匹配{listing.entries.length}
            个未验证候选。仅列当前层，不表示备份可恢复。
          </p>
          {listing.entries.map((entry) => (
            <div key={entry.url}>
              <p>
                {entry.name} · {entry.envelopeBytes}字节 · {entry.modifiedAt ?? '修改时间未知'} ·{' '}
                {entry.format === 'legacy-zip' ? '旧ZIP格式，尚未检查迁移可用性' : '尚未读取或校验'}
              </p>
              <button
                disabled={locked}
                onClick={() => {
                  setProvider('webdav')
                  setDirection('download')
                  setURL(entry.url)
                  setArchiveFormat(entry.format)
                  if (entry.format === 'legacy-zip') {
                    setRecipient('')
                    setSecretKey('')
                  }
                  invalidate()
                  setNotice(
                    entry.format === 'legacy-zip'
                      ? '已选择未验证旧ZIP；请提供本次凭据，另行准备迁移检查，当前数据未替换。'
                      : '已填入指定文件地址。请提供本次凭据及所需AGE私钥，另行准备下载和恢复。'
                  )
                }}
              >
                选择该文件准备下载
              </button>
              <button
                disabled={locked || !entry.etag}
                onClick={() => {
                  setProvider('webdav')
                  setDirection('delete')
                  setURL(entry.url)
                  setETag(entry.etag ?? '')
                  invalidate()
                  setNotice(
                    '已填入删除目标及强ETag，尚未删除。请重新提供凭据，点击删除指定远端文件；删除不可撤销。'
                  )
                }}
              >
                选择该文件准备删除
              </button>
            </div>
          ))}
        </div>
      )}
      {listing && !('directoryURL' in listing) && (
        <div>
          <p>
            第{listing.page}页，扫描{listing.scanned}项，匹配{listing.entries.length}
            个未验证备份候选。
            {listing.nextPage
              ? `有后续第${listing.nextPage}页，可填写页码和Token后另行确认。`
              : '本次响应未报告后续页面。'}
          </p>
          {listing.entries.map((entry) => (
            <div key={entry.id}>
              <p>
                {entry.id} · {entry.updatedAt} · {entry.envelopeBytes}字节 · 尚未读取或解密
              </p>
              <button
                disabled={locked}
                onClick={() => {
                  setProvider('gist')
                  setDirection('download')
                  setGistId(entry.id)
                  invalidate()
                  setNotice(
                    '已填入指定ID。请提供本次Token和AGE私钥，另行准备下载；当前数据未替换。'
                  )
                }}
              >
                选择该ID准备下载
              </button>
            </div>
          ))}
        </div>
      )}
      <button
        disabled={(!pending && busy) || (!pending && !plan && !restore)}
        onClick={() => void cancel()}
      >
        取消本次操作
      </button>
      {visibleNotice && <p role="status">{visibleNotice}</p>}
    </section>
  )
}
