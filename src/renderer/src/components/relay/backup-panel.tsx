import { useEffect, useRef, useState } from 'react'
import {
  backupRecoveryDestinationSHA256,
  type RelayBackupRestorePlan,
  type RelayBackupResult,
  type RelayBackupRecoveryAction,
  type RelayBackupRecoveryRecord,
  type RelayBackupRecoveryPlan,
  type RelayBackupRecoveryResult
} from '../../../../shared/relay/backup'
import type {
  LegacyClashMigrationResult,
  LegacyClashMigrationReport,
  LegacySubStoreSummary
} from '../../../../shared/relay/legacy-clash'
import type {
  LegacyMigrationReport,
  LegacyRelayOrigin,
  LegacyRelayInspection,
  LegacyRelayInspectResult,
  LegacyRelayMigrationResult,
  LegacyRelayMigrationReport
} from '../../../../shared/relay/legacy-relay'

function recoveryPhaseLabel(phase: string): string {
  const labels: Record<string, string> = {
    staged: '已暂存',
    prepared: '已准备',
    applying: '恢复进行中或曾中断',
    applied: '已完成恢复',
    uncertain: '结果未确认',
    'rolling-back': '回滚进行中或曾中断',
    restored: '已恢复',
    'rolled-back': '已回滚'
  }
  return labels[phase] ?? '未知状态'
}

const migrationDisposition = {
  applied: '候选迁移',
  retained: '保留原件',
  'decision-required': '待补资料'
}

export function LegacyClashMigrationSummary({ report }: { report: LegacyClashMigrationReport }) {
  return (
    <details>
      <summary>旧Clash迁移检查报告</summary>
      <p>
        配置 {report.counts.profiles}项；订阅来源 {report.counts.sources}
        项；覆写 {report.counts.overrides}项；规则补丁 {report.counts.rulePatches}
        项。
      </p>
      <p>
        候选迁移 {report.counts.applied}项；保留原件 {report.counts.retained}
        项；待补资料 {report.counts['decision-required']}
        项。报告列出候选处理结果，是否写入当前资料以本次恢复状态为准。
      </p>
      <p>归档摘要：{report.archiveSHA256}</p>
      {report.substore && <LegacySubStoreMigrationSummary summary={report.substore} />}
      <table>
        <thead>
          <tr>
            <th>归档相对路径</th>
            <th>字节</th>
            <th>SHA256</th>
            <th>处理</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          {report.files.map((file) => (
            <tr key={file.path}>
              <td>{file.path}</td>
              <td>{file.bytes}</td>
              <td>{file.sha256.slice(0, 16)}</td>
              <td>{migrationDisposition[file.disposition]}</td>
              <td>{file.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table>
        <thead>
          <tr>
            <th>旧配置ID</th>
            <th>新配置ID</th>
            <th>新来源ID</th>
            <th>处理</th>
            <th>说明</th>
          </tr>
        </thead>
        <tbody>
          {report.profiles.map((profile) => (
            <tr key={profile.legacyId}>
              <td>{profile.legacyId}</td>
              <td>{profile.profileId ?? '—'}</td>
              <td>{profile.sourceId ?? '—'}</td>
              <td>{migrationDisposition[profile.disposition]}</td>
              <td>{profile.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  )
}

export function LegacySubStoreMigrationSummary({ summary }: { summary: LegacySubStoreSummary }) {
  const kinds = { subscription: '订阅', collection: '静态集合', section: '隔离分类' }
  return (
    <section aria-label="Sub-Store逐项迁移报告">
      <h4>Sub-Store基础定义候选</h4>
      <p>
        已识别{summary.schema === '2.0' ? '2.0数组' : '无版本旧map'}；接纳订阅{' '}
        {summary.subscriptions}项；静态集合 {summary.collections}项。数量不包含仅保留原件的项目。
      </p>
      <p>
        接纳订阅统一设置noFlow=true，自动流量查询默认关闭。仅保存基础定义，不启动Sub-Store、不获取订阅或执行处理器；旧任务、令牌和脚本留在原件。
      </p>
      <table>
        <thead>
          <tr>
            <th>类别</th>
            <th>旧名称</th>
            <th>候选新名称</th>
            <th>去向</th>
            <th>具体说明</th>
          </tr>
        </thead>
        <tbody>
          {summary.items.map((item, index) => (
            <tr key={index}>
              <td>{kinds[item.kind]}</td>
              <td>{item.oldName ?? '—'}</td>
              <td>{item.newName ?? '—'}</td>
              <td>{item.disposition === 'accepted' ? '候选接纳' : '保留原件'}</td>
              <td>{item.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

export function LegacyRelayMigrationSummary({ report }: { report: LegacyRelayMigrationReport }) {
  return (
    <details>
      <summary>旧Relay配置副本报告</summary>
      <p>
        固定来源：{report.origin}；选定 {report.profiles.length}项，复制为新的未启用配置。
      </p>
      <p>旧原件保留，未搬走或清空旧根。以后可再次显式检查并复制，没有自动去重或继承运行授权。</p>
      <p>
        来源摘要：{report.sourceSHA256}；原件归档摘要：{report.originalArchiveSHA256}
      </p>
      <table>
        <thead>
          <tr>
            <th>旧配置ID</th>
            <th>旧正文摘要</th>
            <th>检查修订</th>
            <th>新配置ID</th>
            <th>新正文摘要</th>
          </tr>
        </thead>
        <tbody>
          {report.profiles.map((profile) => (
            <tr key={profile.legacyId}>
              <td>{profile.legacyId}</td>
              <td>{profile.legacySHA256.slice(0, 16)}</td>
              <td>{profile.legacyRevision.slice(0, 16)}</td>
              <td>{profile.profileId}</td>
              <td>{profile.profileSHA256.slice(0, 16)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {report.warnings.map((warning, index) => (
        <p key={index}>{warning}</p>
      ))}
    </details>
  )
}

export function RelayBackupPanel({
  busy,
  inspectBusy = busy,
  onBusy,
  restoreNotice,
  onRestoreNotice
}: {
  busy: boolean
  inspectBusy?: boolean
  onBusy(value: boolean): void
  restoreNotice?: string
  onRestoreNotice(value: string): void
}): React.JSX.Element {
  const [plan, setPlan] = useState<RelayBackupRestorePlan>(),
    [planKind, setPlanKind] = useState<'relay' | 'legacy' | 'legacy-relay'>('relay'),
    [records, setRecords] = useState<RelayBackupRecoveryRecord[]>(),
    [recoveryPlan, setRecoveryPlan] = useState<RelayBackupRecoveryPlan>(),
    [legacyProxyPort, setLegacyProxyPort] = useState(''),
    [migrationReport, setMigrationReport] = useState<LegacyMigrationReport>(),
    [legacyOrigin, setLegacyOrigin] = useState<LegacyRelayOrigin>('Relay-Preview'),
    [legacyInspection, setLegacyInspection] = useState<LegacyRelayInspection>(),
    [legacySelections, setLegacySelections] = useState<string[]>([]),
    [legacyInspectionExpired, setLegacyInspectionExpired] = useState(false),
    [legacyRelayPending, setLegacyRelayPending] = useState(false),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState(''),
    operation = useRef(false),
    preparationEpoch = useRef(0),
    inspectionGeneration = useRef(0),
    cancellation = useRef<Promise<unknown>>(Promise.resolve())
  const locked = busy || pending
  const inspectionLocked = inspectBusy || pending
  const visibleNotice = notice || restoreNotice
  const clearLegacyInspection = (): void => {
    inspectionGeneration.current++
    setLegacyInspection(undefined)
    setLegacySelections([])
    setLegacyInspectionExpired(false)
  }
  useEffect(() => {
    if (!legacyInspection) return
    const generation = inspectionGeneration.current
    const delay = legacyInspection.expiresAt - Date.now()
    if (delay <= 0 || delay > 60000 || Date.now() < legacyInspection.preparedAt) {
      setLegacyInspectionExpired(true)
      return
    }
    const timer = setTimeout(() => {
      if (generation === inspectionGeneration.current) setLegacyInspectionExpired(true)
    }, delay)
    return () => clearTimeout(timer)
  }, [legacyInspection])
  useEffect(() => {
    const lifecycle = preparationEpoch,
      inspection = inspectionGeneration
    const remove = window.electron.ipcRenderer.on('relayBackupPreparationsInvalidated', () => {
      preparationEpoch.current++
      setPlan(undefined)
      setRecoveryPlan(undefined)
      setRecords(undefined)
      setMigrationReport(undefined)
      clearLegacyInspection()
      setNotice('备份准备已撤销，请重新读取或检查；已开始的文件事务仍等待真实结果。')
    })
    return () => {
      lifecycle.current++
      inspection.current++
      remove()
    }
  }, [])
  const clearPreparations = async (epoch: number): Promise<void> => {
    setPlan(undefined)
    setRecoveryPlan(undefined)
    setMigrationReport(undefined)
    clearLegacyInspection()
    if (epoch !== preparationEpoch.current) return
    await window.electron.ipcRenderer.invoke('relayBackupCancel')
    if (epoch !== preparationEpoch.current) return
    await window.electron.ipcRenderer.invoke('relayBackupRecoveryCancel')
  }
  const revokeLegacyView = (origin?: LegacyRelayOrigin): void => {
    if (origin) setLegacyOrigin(origin)
    const epoch = ++preparationEpoch.current
    clearLegacyInspection()
    setPlan(undefined)
    setRecoveryPlan(undefined)
    setMigrationReport(undefined)
    onRestoreNotice('')
    setNotice('已清除本地旧Relay检查或准备，正在请求撤销；在途操作仍等待真实收尾。')
    cancellation.current = cancellation.current
      .catch(() => {})
      .then(async () => {
        if (epoch !== preparationEpoch.current) return
        try {
          await window.electron.ipcRenderer.invoke('relayBackupCancel')
          if (epoch === preparationEpoch.current)
            setNotice('旧Relay检查或准备已撤销；当前资料未改变，在途操作仍等待真实收尾。')
        } catch {
          if (epoch === preparationEpoch.current)
            setNotice('本地检查或准备已清除，后台撤销尚未确认；请等待在途操作后重新显式检查。')
        }
      })
      .catch(() => {})
  }
  const action = async (
    kind: 'export' | 'prepare' | 'legacy' | 'restore' | 'cancel' | 'relay-inspect' | 'relay-prepare'
  ): Promise<void> => {
    if (operation.current || (kind === 'relay-inspect' ? inspectBusy : busy)) return
    if (kind === 'restore' && !plan) return
    const inspected = legacyInspection,
      selectedLegacy = inspected?.profiles.filter((profile) =>
        legacySelections.includes(profile.id)
      )
    if (kind === 'relay-prepare') {
      if (!inspected || !selectedLegacy?.length) return
      if (
        legacyInspectionExpired ||
        Date.now() < inspected.preparedAt ||
        Date.now() >= inspected.expiresAt
      ) {
        clearLegacyInspection()
        setNotice('旧Relay检查已过期，请重新显式检查；不会自动重新读取。')
        return
      }
    }
    operation.current = true
    setPending(true)
    setLegacyRelayPending(kind === 'relay-inspect' || kind === 'relay-prepare')
    onBusy(true)
    onRestoreNotice('')
    setNotice('正在处理所选备份…')
    const selected = plan
    const epoch = preparationEpoch.current
    const restorePrepared = async (prepared: RelayBackupRestorePlan): Promise<void> => {
      if (epoch !== preparationEpoch.current) return
      const restored = (await window.electron.ipcRenderer.invoke('relayBackupRestore', {
        id: prepared.id
      })) as RelayBackupResult
      setPlan(undefined)
      const message =
        restored.status === 'restored'
          ? '备份已恢复；原件保留在恢复记录中，未启动核心或应用系统配置。'
          : '恢复未完成，请核对恢复记录；不会自动重试。'
      setNotice(message)
      if (restored.status === 'restored') onRestoreNotice(message)
    }
    if (kind !== 'export') setPlan(undefined)
    if (kind !== 'relay-inspect' && kind !== 'export') clearLegacyInspection()
    try {
      await cancellation.current
      if (epoch !== preparationEpoch.current && kind !== 'export') return
      if (kind === 'cancel') {
        await window.electron.ipcRenderer.invoke('relayBackupCancel')
        if (epoch !== preparationEpoch.current) return
        setNotice('已取消恢复准备；当前数据未改变，暂存记录仍保留。')
        return
      }
      if (kind === 'prepare' || kind === 'legacy' || kind === 'relay-inspect') {
        await clearPreparations(epoch)
        if (epoch !== preparationEpoch.current) return
      }
      if (kind === 'relay-inspect') {
        setMigrationReport(undefined)
        const result = (await window.electron.ipcRenderer.invoke('relayBackupLegacyRelayInspect', {
          origin: legacyOrigin
        })) as LegacyRelayInspectResult
        if (epoch !== preparationEpoch.current) return
        if (result.status === 'inspected' && result.inspection) {
          if (result.inspection.origin !== legacyOrigin) throw new Error('旧Relay来源变化。')
          setLegacyInspection(result.inspection)
          setLegacySelections([])
          setNotice('旧Relay只读检查已完成；请显式勾选记录，再准备新的未启用副本。')
        } else {
          clearLegacyInspection()
          setNotice('本次旧Relay检查已取消，未保留可用检查凭据。')
        }
        return
      }
      if (kind === 'relay-prepare' && inspected && selectedLegacy) {
        const result = (await window.electron.ipcRenderer.invoke('relayBackupLegacyRelayPrepare', {
          inspectionId: inspected.inspectionId,
          profiles: selectedLegacy.map(({ id, sha256, revision }) => ({ id, sha256, revision }))
        })) as LegacyRelayMigrationResult
        if (epoch !== preparationEpoch.current) return
        setMigrationReport(result.report)
        if (result.status === 'prepared' && result.plan) {
          setPlan(result.plan)
          setPlanKind('legacy-relay')
          await restorePrepared(result.plan)
        } else setNotice('本次旧Relay副本准备已取消，请重新显式检查。')
        return
      }
      if (kind === 'legacy') {
        const result = (await window.electron.ipcRenderer.invoke('relayBackupLegacyPrepare', {
          ...(legacyProxyPort.trim() ? { proxyPort: Number(legacyProxyPort) } : {})
        })) as LegacyClashMigrationResult
        if (epoch !== preparationEpoch.current) return
        setMigrationReport(result.report)
        if (result.status === 'prepared' && result.plan) {
          setPlan(result.plan)
          setPlanKind('legacy')
          await restorePrepared(result.plan)
        } else {
          setPlan(undefined)
          setNotice(
            result.status === 'inspected'
              ? '旧备份已检查，当前只有保留或待补资料的项目，没有可执行的迁移准备。'
              : '本次旧备份检查已取消，未生成可执行的迁移准备。'
          )
        }
        return
      }
      const result = (await window.electron.ipcRenderer.invoke(
        kind === 'export'
          ? 'relayBackupExport'
          : kind === 'prepare'
            ? 'relayBackupImportPrepare'
            : 'relayBackupRestore',
        ...(kind === 'restore' ? [{ id: selected?.id }] : [])
      )) as RelayBackupResult
      if (kind === 'prepare' && epoch !== preparationEpoch.current) return
      if (kind === 'prepare' && result.status === 'prepared' && result.plan) {
        setPlanKind('relay')
        await restorePrepared(result.plan)
        return
      }
      if (kind !== 'export') {
        setPlan(result.status === 'prepared' ? result.plan : undefined)
        if (kind === 'prepare') setPlanKind('relay')
      }
      const message =
        result.status === 'exported'
          ? '备份已导出，请妥善保管其中的配置与凭据。'
          : result.status === 'prepared'
            ? '备份完整性与当前数据基线已检查。将继续执行本次恢复；当前配置未替换。'
            : result.status === 'restored'
              ? '私有数据恢复已确认；原件保留在本次恢复记录中。尚未自动启动核心或应用系统配置。'
              : result.status === 'uncertain'
                ? '恢复结果未确认，原件、候选和日志均已保留。停止后续恢复并人工核对，不能视为已恢复完成。'
                : '本次操作已取消。'
      if (result.status === 'restored') onRestoreNotice(message)
      setNotice(message)
    } catch {
      setPlan(undefined)
      if (kind === 'relay-inspect' || kind === 'relay-prepare') clearLegacyInspection()
      if (epoch !== preparationEpoch.current && kind !== 'restore' && kind !== 'export') return
      setNotice(
        kind === 'relay-inspect' || kind === 'relay-prepare'
          ? '旧Relay检查已过期、取消或来源发生变化；原件保留，请重新显式检查，不会自动重新读取。'
          : '备份格式、路径或完整性未通过，当前存在活动操作，或准备后出现未知修改；本次操作未确认，请先核对恢复记录。'
      )
    } finally {
      operation.current = false
      setPending(false)
      setLegacyRelayPending(false)
      onBusy(false)
    }
  }
  const recoveryAction = async (
    kind: 'list' | 'execute' | 'cancel',
    request?: { id: string; action: RelayBackupRecoveryAction }
  ): Promise<void> => {
    if (operation.current || busy || (kind === 'execute' && !request)) return
    operation.current = true
    setPending(true)
    onBusy(true)
    onRestoreNotice('')
    const epoch = preparationEpoch.current
    if (kind !== 'list') setRecoveryPlan(undefined)
    clearLegacyInspection()
    setNotice('正在核对并执行所选恢复动作…')
    try {
      await cancellation.current
      if (epoch !== preparationEpoch.current) return
      if (kind === 'list') {
        const result = (await window.electron.ipcRenderer.invoke(
          'relayBackupRecoveryList'
        )) as RelayBackupRecoveryRecord[]
        if (epoch !== preparationEpoch.current) return
        setRecords(result)
        setNotice(`已读取${result.length}条恢复记录；可核对不代表已经可以继续或回滚。`)
        return
      }
      if (kind === 'cancel') {
        await window.electron.ipcRenderer.invoke('relayBackupRecoveryCancel')
        setNotice('已取消续作准备；恢复记录与原件仍保留。')
        return
      }
      await clearPreparations(epoch)
      if (epoch !== preparationEpoch.current) return
      const prepared = (await window.electron.ipcRenderer.invoke(
        'relayBackupRecoveryPrepare',
        request
      )) as RelayBackupRecoveryResult
      if (epoch !== preparationEpoch.current) return
      let result = prepared
      if (prepared.status === 'prepared' && prepared.plan) {
        setRecoveryPlan(prepared.plan)
        setRecords(undefined)
        result = (await window.electron.ipcRenderer.invoke('relayBackupRecoveryCommit', {
          evidenceId: prepared.plan.evidenceId
        })) as RelayBackupRecoveryResult
      }
      setRecoveryPlan(undefined)
      const message =
        result.status === 'restored'
          ? '继续恢复已确认；原件与记录保留，尚未启动核心或应用系统配置。'
          : result.status === 'rolled-back'
            ? '回滚原件已确认；恢复记录保留，尚未启动核心或应用系统配置。'
            : result.status === 'cancelled'
              ? '本次续作已取消。'
              : '续作结果未确认，请重新读取恢复记录并人工核对；不会自动重试。'
      if (result.status === 'restored' || result.status === 'rolled-back') onRestoreNotice(message)
      setNotice(message)
    } catch {
      setRecoveryPlan(undefined)
      if (kind === 'list') setRecords(undefined)
      setNotice(
        '恢复记录、原件或当前资料未通过核对；本次续作未确认。保留现场并重新读取记录，不能强制继续。'
      )
    } finally {
      operation.current = false
      setPending(false)
      onBusy(false)
    }
  }
  return (
    <section className="relay-panel">
      <h2>Relay本地备份与恢复</h2>
      <p>备份包含私有配置、订阅来源与可能存在的密码、请求头及密钥，请妥善保管。</p>
      <p>
        仅恢复Relay的持久数据。运行会话、PID、TUN授权、浏览器活跃资料与系统代理不在恢复范围；不会自动恢复旧授权或启动核心。
      </p>
      <div className="relay-action">
        <button disabled={locked} onClick={() => void action('export')}>
          导出本地备份
        </button>
        <button disabled={locked} onClick={() => void action('prepare')}>
          从备份恢复…
        </button>
        <button disabled={locked || !plan} onClick={() => void action('cancel')}>
          取消恢复准备
        </button>
      </div>
      <fieldset disabled={locked}>
        <legend>旧Clash备份迁移</legend>
        <p>
          选择旧ZIP并生成迁移报告。当前资料全部保留，只新增可迁移数据；旧系统接管和权限不会迁移。原ZIP与报告保留在Relay私有记录中。
        </p>
        <label>
          订阅默认代理端口（可选）{' '}
          <input
            inputMode="numeric"
            value={legacyProxyPort}
            onChange={(event) => {
              setLegacyProxyPort(event.target.value)
              if (plan && planKind === 'legacy') {
                setPlan(undefined)
                setNotice('迁移参数已更改，请重新选择旧备份并检查。')
                cancellation.current = window.electron.ipcRenderer
                  .invoke('relayBackupCancel')
                  .catch(() => {})
              }
            }}
          />
        </label>
        <p>留空只迁移配置缓存，不创建远程订阅来源；检查和恢复均不会请求订阅地址。</p>
        <button onClick={() => void action('legacy')}>选择旧Clash备份并检查</button>
      </fieldset>
      <fieldset>
        <legend>复制旧Relay配置</legend>
        <p>
          只检查所选固定来源的旧Profiles记录；点击后只读检查。不会自动扫描、读取Edge描述文件或其他非UUID正文。
        </p>
        <label>
          旧Relay固定来源{' '}
          <select
            value={legacyOrigin}
            disabled={inspectionLocked}
            onChange={(event) => {
              const value = event.target.value
              if (value === 'Relay' || value === 'Relay-Preview') revokeLegacyView(value)
            }}
          >
            <option value="Relay-Preview">Relay-Preview</option>
            <option value="Relay">Relay</option>
          </select>
        </label>
        <button disabled={inspectionLocked} onClick={() => void action('relay-inspect')}>
          只读检查旧Relay配置
        </button>
        <button
          disabled={
            locked || !legacyInspection || !legacySelections.length || legacyInspectionExpired
          }
          onClick={() => void action('relay-prepare')}
        >
          导入所选未启用配置副本
        </button>
        <button
          disabled={
            (inspectionLocked && !legacyRelayPending) ||
            !(legacyInspection || legacyRelayPending || (plan && planKind === 'legacy-relay'))
          }
          onClick={() => revokeLegacyView()}
        >
          取消旧Relay检查或准备
        </button>
        <p>
          只复制显式勾选的记录到新UUID，旧原件和当前选择保持；点击导入后会核对所选记录并完成本地恢复。检查过期请重新显式检查，不会自动重查。
        </p>
        {legacyInspection && (
          <div aria-label="旧Relay检查结果">
            <p>
              已检查来源：{legacyInspection.origin}；可选 {legacyInspection.profiles.length}
              项；未接纳UUID条目 {legacyInspection.incomplete}项。
            </p>
            <p>
              来源摘要：{legacyInspection.sourceSHA256.slice(0, 16)}；检查到期：
              {new Date(legacyInspection.expiresAt).toLocaleTimeString()}。
            </p>
            {legacyInspectionExpired && <p>旧Relay检查已过期，请重新显式检查。</p>}
            {legacyInspection.warnings.map((warning, index) => (
              <p key={index}>{warning}</p>
            ))}
            <table>
              <thead>
                <tr>
                  <th>选择</th>
                  <th>名称</th>
                  <th>旧ID</th>
                  <th>正文摘要</th>
                  <th>检查修订</th>
                </tr>
              </thead>
              <tbody>
                {legacyInspection.profiles.map((profile) => (
                  <tr key={profile.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={`选择旧配置 ${profile.name}（${profile.id}）`}
                        checked={legacySelections.includes(profile.id)}
                        disabled={inspectionLocked || legacyInspectionExpired}
                        onChange={(event) => {
                          const checked = event.target.checked
                          setLegacySelections((previous) =>
                            checked
                              ? [...previous, profile.id]
                              : previous.filter((id) => id !== profile.id)
                          )
                        }}
                      />
                    </td>
                    <td>{profile.name}</td>
                    <td>{profile.id}</td>
                    <td>{profile.sha256.slice(0, 16)}</td>
                    <td>{profile.revision.slice(0, 16)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </fieldset>
      {plan && (
        <div>
          {planKind !== 'relay' && <p>正在核对并导入迁移候选；实际结果以下方回执为准。</p>}
          <p>
            恢复文件：{plan.files}项；替换：{plan.replacedFiles}项；删除：{plan.removedFiles}
            项。包含敏感配置与凭据。
          </p>
          <p>
            备份摘要：{plan.archiveSHA256.slice(0, 16)}；当前数据基线：
            {plan.baselineSHA256.slice(0, 16)}
          </p>
          <p>
            执行前会再次核对当前数据与暂存备份。发现未知修改时保留现状；恢复中断会保留原件和日志。
          </p>
          <p>
            {planKind === 'legacy'
              ? '迁移候选合并当前资料与新增资料，现有条目及当前选择保留；事务原件保存在本次恢复记录。'
              : planKind === 'legacy-relay'
                ? '候选只添加新UUID的未启用配置副本；当前选择不变，旧原件和事务原件保留。'
                : '白名单范围内未包含在备份中的文件将移出当前资料，原件保存在本次恢复记录。'}
          </p>
        </div>
      )}
      {migrationReport?.format === 'clash-party-legacy-zip' && (
        <LegacyClashMigrationSummary report={migrationReport} />
      )}
      {migrationReport?.format === 'relay-legacy-profiles-v1' && (
        <LegacyRelayMigrationSummary report={migrationReport} />
      )}
      <h3>中断恢复的继续与回滚</h3>
      <p>
        先显式读取恢复记录，再核对继续或回滚。记录允许核对某项动作，不代表已经可以执行；点击对应动作后核对并执行。旧版v1与未知记录不能强制续作。
      </p>
      <button disabled={locked} onClick={() => void recoveryAction('list')}>
        读取恢复记录
      </button>
      {records && (
        <ul>
          {!records.length && <li>当前没有恢复记录。</li>}
          {records.map((record) => (
            <li key={record.id}>
              <p>
                记录 {record.id} ·{' '}
                {record.version === 2 ? 'v2' : record.version === 1 ? '旧版v1' : '未知版本'} ·{' '}
                {recoveryPhaseLabel(record.phase)}
              </p>
              {record.version === 2 && record.actions.includes('resume') && (
                <button
                  disabled={locked}
                  onClick={() =>
                    void recoveryAction('execute', { id: record.id, action: 'resume' })
                  }
                >
                  继续恢复
                </button>
              )}
              {record.version === 2 && record.actions.includes('rollback') && (
                <button
                  disabled={locked}
                  onClick={() =>
                    void recoveryAction('execute', { id: record.id, action: 'rollback' })
                  }
                >
                  回滚原件
                </button>
              )}
              {(record.version !== 2 || !record.actions.length) && (
                <p>此记录暂不提供可核对的续作，请保留原件和日志并人工核对。</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {recoveryPlan && (
        <div>
          <p>
            本次{recoveryPlan.action === 'resume' ? '继续恢复' : '回滚原件'}：记录 {recoveryPlan.id}
            ，{recoveryPlan.files}项。包含敏感配置与凭据。
          </p>
          <p>
            记录摘要：{recoveryPlan.recordSHA256.slice(0, 16)}；当前资料：
            {recoveryPlan.currentSHA256.slice(0, 16)}；目标：
            {backupRecoveryDestinationSHA256(recoveryPlan).slice(0, 16)}。
          </p>
          <p>本次凭据60秒有效；提交前还会核对原件、目标和当前资料，未知修改会阻止执行。</p>
        </div>
      )}
      <button disabled={locked || !recoveryPlan} onClick={() => void recoveryAction('cancel')}>
        取消本次续作准备
      </button>
      {visibleNotice && <p role="status">{visibleNotice}</p>}
      <p>WebDAV与Gist使用独立远程面板操作；本地备份不会自动上传。</p>
    </section>
  )
}
