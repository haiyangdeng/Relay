import { useEffect, useRef, useState } from 'react'
import {
  scopedStorageReport,
  type ScopedStorageReport,
  type ScopedStorageItem
} from '../../../../shared/relay/guard-scoped-storage'

const phaseLabel: Record<ScopedStorageItem['phase'], string> = {
  legacy: '旧目录记录',
  creating: '创建待确认',
  created: '映像已创建',
  attaching: '挂载待确认',
  mounted: '已挂载',
  detaching: '卸载待确认',
  closed: '普通写入已关闭'
}

export function RelayGuardScopedStoragePanel({
  busy,
  onBusy
}: {
  busy: boolean
  onBusy(value: boolean): void
}): React.JSX.Element {
  const [report, setReport] = useState<ScopedStorageReport>(),
    [selected, setSelected] = useState(''),
    [notice, setNotice] = useState('')
  const lifetime = useRef({ mounted: false, epoch: 0, pending: false })
  useEffect(() => {
    const scope = { mounted: true, epoch: 0, pending: false }
    lifetime.current = scope
    return () => {
      scope.mounted = false
    }
  }, [])
  const action = async (close: boolean): Promise<void> => {
    const scope = lifetime.current
    if (scope.pending) return
    const item = report?.items.find((value) => value.id === selected)
    if (close && (!item?.canClose || report?.pending)) return
    scope.pending = true
    const ticket = ++scope.epoch
    onBusy(true)
    setNotice('正在核对本次私有磁盘…')
    try {
      const raw: unknown = await window.electron.ipcRenderer.invoke(
        'relayGuardScopedStorage',
        close && item
          ? { action: 'close', workspaceID: item.id, revision: item.revision }
          : { action: 'list' }
      )
      const next = scopedStorageReport(raw)
      if (scope.mounted && scope.epoch === ticket && lifetime.current === scope) {
        setReport(next)
        setSelected(
          next.items.some((value) => value.id === selected) ? selected : (next.items[0]?.id ?? '')
        )
        setNotice(
          next.status === 'ok'
            ? '私有磁盘状态已返回。'
            : '操作未确认，保留现场。繁忙或未知时不会强制卸载。'
        )
      }
    } catch {
      if (scope.mounted && scope.epoch === ticket && lifetime.current === scope) {
        setReport(undefined)
        setNotice('私有磁盘或签名发布资源未确认；保留现场，不重试磁盘操作。')
      }
    } finally {
      scope.pending = false
      // Release this request's parent UI reservation even if the panel was
      // removed. Native/Main retain their independent pending/unknown barrier.
      onBusy(false)
    }
  }
  const item = report?.items.find((value) => value.id === selected)
  return (
    <section className="relay-panel">
      <h3>私有磁盘写入收尾</h3>
      <p>
        每次新会话使用独立 512 MiB
        私有磁盘。结束会话后可明确确认普通卸载；文件被占用或状态未知时保留原件，绝不强制卸载。确认写入关闭后只归档保留，不删除文件。不修改已有
        Claude 配置。
      </p>
      <p>
        “写入关闭”仅表示普通非提权沙箱写者无法再写此磁盘，不表示全部工具后代退出。旧的目录式会话不自动迁移或推断已收尾。
      </p>
      <p>最多读取 64 条保留会话；达到上限后暂停新建，原件需要人工管理，Relay 不自动删除。</p>
      <button disabled={busy} onClick={() => void action(false)}>
        读取私有磁盘记录
      </button>
      {report && (
        <>
          <label>
            保留会话
            <select
              value={selected}
              disabled={busy}
              onChange={(event) => setSelected(event.target.value)}
            >
              <option value="">请选择</option>
              {report.items.map((value) => (
                <option key={value.id} value={value.id}>
                  {value.id} · {phaseLabel[value.phase]}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={busy || report.pending || !item?.canClose}
            onClick={() => void action(true)}
          >
            确认结束写入并保留
          </button>
          <p>
            {report.status === 'ok' ? '记录已核对。' : '状态未确认，保留原件。'}
            {report.pending ? '已提交命令尚未确认结束，请稍后重新读取。' : ''}
          </p>
          {item && (
            <p>
              {item.writeClosure === 'closedForOrdinarySandboxedWriters'
                ? '已确认普通沙箱写入关闭，原件保留。'
                : '写入关闭尚未确认。'}{' '}
              全部后代退出：未证明。
            </p>
          )}
        </>
      )}
      {notice && <p role="status">{notice}</p>}
    </section>
  )
}
