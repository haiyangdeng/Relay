import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { IoCloseOutline, IoDesktopOutline } from 'react-icons/io5'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import NetworkTopologyCard from '../network/network-topology'
import LogItem from '../logs/log-item'
import dayjs from '../../utils/dayjs'
import type { LocalProxyState } from '../../../../shared/relay/local-proxy'
import { RelayConnectionDetails } from './connection-details'
import { runtimeTopologyConnections } from './runtime-topology'
import { RelayIsolatedProbesPanel } from './isolated-probes-panel'
import { RelayConnectionAppIcon } from './connection-app-icon'
import { connectionSortFromPreferences, connectionSortPreference } from './connection-sort'
import './runtime-info-panel.css'
import {
  displayedConnections,
  displayedLogs,
  displayedObservedConnections,
  formatTraffic,
  observedClosedConnections,
  observedConnectionLimit,
  observedConnectionRates,
  observedLog,
  observedTrafficRate,
  readRuntimeObservation,
  runtimeLogCursor,
  runtimeLogLines,
  sameObservedRuntime,
  type ObservedConnection,
  type ObservedConnectionOrder,
  type ObservedLogLevel,
  type RuntimeLogCursor,
  type RuntimeObservation
} from './runtime-info'

// Keep the view cursor when navigating away, within this renderer session.
let clearedLogCursor: RuntimeLogCursor | undefined

const connectionOrderLabels: Record<ObservedConnectionOrder, string> = {
  snapshot: '快照顺序（本次视图）',
  startedAt: '连接时间',
  upload: '上传量',
  download: '下载量',
  uploadRate: '上传速度',
  downloadRate: '下载速度'
}
const logLevelLabels: Record<ObservedLogLevel, string> = {
  all: '全部（含无级别输出）',
  error: '错误',
  warning: '警告及以上',
  info: '信息及以上',
  debug: '调试及以上'
}
const connectionColumns = {
  process: '进程',
  route: '代理链',
  upload: '上传量',
  download: '下载量',
  uploadRate: '上传速度',
  downloadRate: '下载速度'
} as const
type ConnectionColumn = keyof typeof connectionColumns
const optionalColumns = Object.keys(connectionColumns) as ConnectionColumn[]
const connectionViewKey = 'relay-owned-connections-view-v1'
type ConnectionView = {
  tableView: boolean
  columns: readonly ConnectionColumn[]
}
const defaultConnectionView: ConnectionView = {
  tableView: false,
  columns: optionalColumns
}

export function readConnectionView(storage?: Pick<Storage, 'getItem'>): ConnectionView {
  try {
    const raw = (storage ?? window.localStorage).getItem(connectionViewKey)
    if (!raw || raw.length > 512) return defaultConnectionView
    const saved: Partial<Record<keyof ConnectionView, unknown>> | null = JSON.parse(raw)
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return defaultConnectionView
    const columns: readonly unknown[] = Array.isArray(saved.columns)
      ? saved.columns
      : optionalColumns
    return {
      tableView: typeof saved.tableView === 'boolean' ? saved.tableView : false,
      columns: optionalColumns.filter((column) => columns.includes(column))
    }
  } catch {
    return defaultConnectionView
  }
}

const isRateColumn = (column: string): boolean =>
  column === 'uploadRate' || column === 'downloadRate'
type DisplayedRuntimeSnapshot = RuntimeObservation & {
  connectionRates: ReturnType<typeof observedConnectionRates>
  closedConnections: readonly ObservedConnection[]
}

type ResizableColumn = 'target' | ConnectionColumn
const defaultColumnWidths: Readonly<Record<ResizableColumn, number>> = {
  target: 220,
  process: 180,
  route: 180,
  upload: 106,
  download: 106,
  uploadRate: 106,
  downloadRate: 106
}
const columnWidthsKey = 'relay-owned-connections-column-widths-v1'
const minColumnWidth = 80,
  maxColumnWidth = 760,
  actionColumnWidth = 154
const columnWidth = (value: number): number =>
  Math.round(Math.min(maxColumnWidth, Math.max(minColumnWidth, value)))

function loadColumnWidths(): Record<ResizableColumn, number> {
  const widths = { ...defaultColumnWidths }
  try {
    const raw = window.localStorage.getItem(columnWidthsKey)
    if (!raw || raw.length > 512) return widths
    const saved = JSON.parse(raw) as Partial<Record<ResizableColumn, unknown>> | null
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return widths
    for (const column of Object.keys(widths) as ResizableColumn[]) {
      const value = saved[column]
      if (typeof value === 'number' && Number.isFinite(value)) widths[column] = columnWidth(value)
    }
  } catch {
    // The current window can still resize columns when local storage is unavailable.
  }
  return widths
}

function formatConnectionRate(bytesPerSecond: number | undefined): string {
  return bytesPerSecond === undefined ? '待采样' : `${formatTraffic(bytesPerSecond)}/s`
}

export function RelayConnectionSnapshotTable({
  rows,
  columns,
  actions,
  onSelect
}: {
  rows: ReturnType<typeof displayedConnections>
  columns: readonly ConnectionColumn[]
  actions?(entry: ObservedConnection): React.JSX.Element
  onSelect?(entry: ObservedConnection): void
}): React.JSX.Element {
  const [widths, setWidths] = useState(loadColumnWidths)
  const currentWidths = useRef(widths)
  const viewport = useRef<HTMLDivElement>(null)
  const resizing = useRef<{
    column: ResizableColumn
    pointer: number
    startX: number
    startWidth: number
  }>(undefined)
  const visible: ResizableColumn[] = ['target', ...columns]
  const resize = (column: ResizableColumn, raw: number, save = false): void => {
    const next = { ...currentWidths.current, [column]: columnWidth(raw) }
    setWidths(next)
    if (save) {
      currentWidths.current = next
      try {
        window.localStorage.setItem(columnWidthsKey, JSON.stringify(next))
      } catch {
        // Keep the adjustment in the current view if it cannot be saved.
      }
    }
  }
  const cancelResize = useCallback((pointer: number): void => {
    const drag = resizing.current
    if (!drag || drag.pointer !== pointer) return
    resizing.current = undefined
    setWidths(currentWidths.current)
    const target = viewport.current
    if (target?.hasPointerCapture(pointer)) target.releasePointerCapture(pointer)
  }, [])
  useLayoutEffect(() => {
    const drag = resizing.current
    // Column visibility changes can remove the handle without a pointer event.
    if (drag && drag.column !== 'target' && !columns.includes(drag.column))
      cancelResize(drag.pointer)
  }, [columns, cancelResize])
  const resizeFromPointer = (event: React.PointerEvent, save: boolean): void => {
    const drag = resizing.current
    if (!drag || drag.pointer !== event.pointerId) return
    if (!visible.includes(drag.column)) {
      cancelResize(event.pointerId)
      return
    }
    if (save) resizing.current = undefined
    resize(drag.column, drag.startWidth + event.clientX - drag.startX, save)
  }
  return (
    <div
      ref={viewport}
      className="overflow-x-auto"
      onPointerMove={(event) => resizeFromPointer(event, false)}
      onPointerUp={(event) => resizeFromPointer(event, true)}
      onPointerCancel={(event) => cancelResize(event.pointerId)}
      onLostPointerCapture={(event) => cancelResize(event.pointerId)}
    >
      <table
        aria-label={actions ? '本次自有核心连接' : '本次自有核心已结束连接'}
        style={{
          tableLayout: 'fixed',
          width: visible.reduce(
            (total, column) => total + widths[column],
            actions ? actionColumnWidth : 0
          )
        }}
      >
        <colgroup>
          {visible.map((column) => (
            <col key={column} style={{ width: widths[column] }} />
          ))}
          {actions && <col style={{ width: actionColumnWidth }} />}
        </colgroup>
        <thead>
          <tr>
            {visible.map((column) => {
              const label = column === 'target' ? '目标' : connectionColumns[column]
              return (
                <th key={column} scope="col" className="relative pr-3">
                  {label}
                  <span
                    role="separator"
                    tabIndex={0}
                    aria-orientation="vertical"
                    aria-label={`调整${label}列宽`}
                    aria-valuemin={minColumnWidth}
                    aria-valuemax={maxColumnWidth}
                    aria-valuenow={widths[column]}
                    className="absolute inset-y-0 right-0 w-2 cursor-col-resize touch-none border-r border-divider focus-visible:outline-2"
                    onPointerDown={(event) => {
                      if (event.button !== 0 || resizing.current || !viewport.current) return
                      // The viewport outlives conditional column headers during a drag.
                      viewport.current.setPointerCapture(event.pointerId)
                      resizing.current = {
                        column,
                        pointer: event.pointerId,
                        startX: event.clientX,
                        startWidth: currentWidths.current[column]
                      }
                      event.preventDefault()
                    }}
                    onKeyDown={(event) => {
                      if (resizing.current || !['ArrowLeft', 'ArrowRight'].includes(event.key))
                        return
                      event.preventDefault()
                      resize(
                        column,
                        currentWidths.current[column] + (event.key === 'ArrowLeft' ? -10 : 10),
                        true
                      )
                    }}
                  />
                </th>
              )
            })}
            {actions && <th scope="col">操作</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((entry) => (
            <tr key={`${entry.id}-${entry.position}`}>
              <td className="break-all">
                {onSelect ? (
                  <button
                    type="button"
                    className="relay-connection-open"
                    onClick={() => onSelect(entry)}
                  >
                    {entry.source ? `${entry.source} → ` : ''}
                    {entry.target}
                  </button>
                ) : (
                  entry.target
                )}
              </td>
              {columns.map((column) => (
                <td key={column} className="break-all">
                  {column === 'upload' || column === 'download'
                    ? formatTraffic(entry[column])
                    : column === 'uploadRate' || column === 'downloadRate'
                      ? formatConnectionRate(entry[column])
                      : entry[column]}
                </td>
              ))}
              {actions && <td>{actions(entry)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function RelayRuntimeInfoPanel({
  busy,
  onBusy,
  state,
  logsFirst = false,
  view,
  active = true
}: {
  busy: boolean
  onBusy(value: boolean): void
  state?: LocalProxyState
  logsFirst?: boolean
  view?: 'connections' | 'logs' | 'network'
  active?: boolean
}): React.JSX.Element {
  const { appConfig, patchAppConfig } = useAppConfig()
  const [snapshot, setSnapshot] = useState<DisplayedRuntimeSnapshot>(),
    [rate, setRate] = useState<{ download: number; upload: number }>(),
    [watching, setWatching] = useState(true),
    [pending, setPending] = useState(false),
    [notice, setNotice] = useState(''),
    [connectionQuery, setConnectionQuery] = useState(''),
    [connectionView, setConnectionView] = useState(readConnectionView),
    [snapshotOrder, setSnapshotOrder] = useState(false),
    [showClosed, setShowClosed] = useState(false),
    [selectedConnection, setSelectedConnection] = useState<ObservedConnection>(),
    [logQuery, setLogQuery] = useState(''),
    [logLevel, setLogLevel] = useState<ObservedLogLevel>('all'),
    [followLogs, setFollowLogs] = useState(true),
    [logCursor, setLogCursor] = useState(clearedLogCursor),
    logOutput = useRef<HTMLDivElement>(null),
    previous = useRef<DisplayedRuntimeSnapshot | undefined>(undefined),
    operation = useRef(false),
    generation = useRef(0),
    parentState = useRef(state),
    mounted = useRef(true)
  useEffect(() => {
    setSelectedConnection(undefined)
  }, [active, view])
  const showConnections = !view || view === 'connections'
  const showNetwork = !view || view === 'network'
  const showLogsFirst = view === 'logs' || (!view && logsFirst)
  const { columns, tableView } = connectionView
  const { order: savedConnectionOrder, descending } = connectionSortFromPreferences(appConfig)
  const connectionOrder = snapshotOrder ? 'snapshot' : savedConnectionOrder
  useEffect(() => {
    setSnapshotOrder(false)
  }, [appConfig?.connectionOrderBy, appConfig?.connectionDirection])
  const saveConnectionSort = async (
    patch: Pick<Partial<IAppConfig>, 'connectionDirection' | 'connectionOrderBy'>
  ): Promise<void> => {
    if (!active || !appConfig || operation.current || busy) return
    operation.current = true
    setPending(true)
    onBusy(true)
    setSnapshotOrder(false)
    try {
      // AppConfig is refreshed by the existing hook after Main accepts or rejects
      // the write. Keep displaying that confirmed value instead of a draft.
      await patchAppConfig(patch)
    } finally {
      operation.current = false
      if (mounted.current) setPending(false)
      onBusy(false)
    }
  }
  const updateConnectionView = (patch: Partial<ConnectionView>): void => {
    const next = { ...connectionView, ...patch }
    setConnectionView(next)
    try {
      window.localStorage.setItem(connectionViewKey, JSON.stringify(next))
    } catch {
      // Keep the adjustment in the current view if it cannot be saved.
    }
  }
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const clear = (): void => {
    previous.current = undefined
    setSnapshot(undefined)
    setRate(undefined)
  }
  useEffect(() => {
    const last = parentState.current
    parentState.current = state
    if ((!last && !state) || (last && state && sameObservedRuntime(last, state))) return
    ++generation.current
    if (state && previous.current && !sameObservedRuntime(state, previous.current.state)) {
      previous.current = undefined
      setSnapshot(undefined)
      setRate(undefined)
    }
  }, [state])
  const read = async (): Promise<void> => {
    if (operation.current || busy || !active) return
    operation.current = true
    const at = generation.current
    setPending(true)
    try {
      const next = await readRuntimeObservation((channel) =>
        window.electron.ipcRenderer.invoke(channel)
      )
      if (!mounted.current || at !== generation.current) return
      const last = previous.current
      setRate(observedTrafficRate(last, next))
      const observed = {
        ...next,
        connectionRates: observedConnectionRates(last, next),
        closedConnections: observedClosedConnections(last, next, last?.closedConnections ?? [])
      }
      previous.current = observed
      setSnapshot(observed)
      setNotice('')
    } catch {
      if (!mounted.current || at !== generation.current) return
      clear()
      setNotice('读取失败，请点击刷新重试。')
    } finally {
      operation.current = false
      if (mounted.current) setPending(false)
    }
  }
  const readRef = useRef(read)
  readRef.current = read
  useEffect(() => {
    if (!active || busy) return
    const lifecycle = generation
    let cancelled = false
    let reading = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const readAndSchedule = async (): Promise<void> => {
      if (cancelled || reading || document.hidden) return
      reading = true
      await readRef.current()
      reading = false
      if (!cancelled && watching && !document.hidden)
        timer = setTimeout(() => void readAndSchedule(), 1000)
    }
    const visibilityChanged = (): void => {
      clearTimeout(timer)
      if (!document.hidden) void readAndSchedule()
    }
    void readAndSchedule()
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => {
      cancelled = true
      ++lifecycle.current
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [active, view, watching, busy])
  const current =
    snapshot && (!state || sameObservedRuntime(snapshot.state, state)) ? snapshot : undefined
  const logLines = runtimeLogLines(current, logCursor)
  const topologyConnections = useMemo(
    () => runtimeTopologyConnections(current?.connections?.connections ?? []),
    [current?.connections]
  )
  const clearableLogs = current && logLines.length > 0 ? runtimeLogCursor(current) : undefined
  useEffect(() => {
    const output = logOutput.current
    if (followLogs && output) output.scrollTop = output.scrollHeight
  }, [followLogs, current, logQuery, logLevel, logCursor, logsFirst, view])
  const canClose = !!(
    current?.state.owned &&
    current.state.phase === 'running' &&
    current.state.instanceId &&
    !current.state.pending &&
    !current.state.uncertain &&
    current.state.traffic === 'listening'
  )
  const close = async (id?: string): Promise<void> => {
    if (busy || operation.current || !canClose || !current) return
    operation.current = true
    setPending(true)
    onBusy(true)
    const target = {
      instanceId: current.state.instanceId,
      configurationRevision: current.state.configurationRevision
    }
    clear()
    try {
      if (id) await window.electron.ipcRenderer.invoke('mihomoCloseConnection', id, target)
      else await window.electron.ipcRenderer.invoke('mihomoCloseAllConnections', target)
      if (mounted.current) setNotice('已提交关闭本次实例连接；重新读取以查看最新状态。')
    } catch {
      if (mounted.current) setNotice('关闭未确认或快照身份已变化；未自动重试，请重新读取。')
    } finally {
      operation.current = false
      if (mounted.current) setPending(false)
      onBusy(false)
    }
  }
  const displayOrder = showClosed && isRateColumn(connectionOrder) ? 'snapshot' : connectionOrder
  const visibleColumns = showClosed
    ? optionalColumns.filter((column) => !isRateColumn(column))
    : optionalColumns
  const rows = showClosed
    ? displayedObservedConnections(
        current?.closedConnections ?? [],
        connectionQuery,
        displayOrder,
        descending
      )
    : displayedConnections(
        current?.connections?.connections ?? [],
        connectionQuery,
        displayOrder,
        descending,
        current?.connectionRates
      )
  const connectionCount = showClosed
    ? current?.closedConnections.length
    : current?.connections?.connections.length
  const clearClosedConnections = (): void => {
    const last = previous.current
    if (!last || !last.closedConnections.length) return
    const cleared = { ...last, closedConnections: [] }
    previous.current = cleared
    setSnapshot(cleared)
  }
  const logs = displayedLogs(logLines, logQuery, logLevel)
  const connectionActions = (entry: ObservedConnection): React.JSX.Element => (
    <button
      type="button"
      className="relay-runtime-danger relay-icon-button"
      aria-label={`关闭连接 ${entry.target}`}
      title="关闭此连接"
      disabled={busy || pending || !canClose || !entry.id}
      onClick={() => void close(entry.id)}
    >
      <IoCloseOutline size={20} />
    </button>
  )
  const connectionIcon = (entry: ObservedConnection): React.JSX.Element =>
    !showClosed && entry.id && current?.state.instanceId && current.state.configurationRevision ? (
      <RelayConnectionAppIcon
        disabled={busy || pending || !canClose}
        selection={{
          instanceId: current.state.instanceId,
          configurationRevision: current.state.configurationRevision,
          connectionId: entry.id
        }}
      />
    ) : (
      <IoDesktopOutline className="relay-connection-icon" size={26} />
    )
  const runtimeLabel = !current
    ? notice
      ? '读取失败'
      : '正在读取'
    : current.state.uncertain || current.state.pending
      ? '状态待确认'
      : current.state.phase === 'running'
        ? '运行中'
        : '未运行'
  const logPanel = (
    <div className="relay-runtime-logs">
      <div className="relay-runtime-toolbar">
        <input
          aria-label="筛选日志文本"
          placeholder="筛选日志文本"
          value={logQuery}
          onChange={(event) => setLogQuery(event.target.value)}
        />
        <select
          aria-label="日志级别"
          value={logLevel}
          onChange={(event) => setLogLevel(event.target.value as ObservedLogLevel)}
        >
          {Object.entries(logLevelLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <button type="button" aria-pressed={followLogs} onClick={() => setFollowLogs(!followLogs)}>
          自动滚动
        </button>
        <button
          type="button"
          disabled={!clearableLogs}
          onClick={() => {
            clearedLogCursor = clearableLogs
            setLogCursor(clearableLogs)
          }}
        >
          清空显示
        </button>
      </div>
      {logs.length ? (
        <div ref={logOutput} className="relay-log-list" aria-label="核心日志">
          {logs.map((line, index) => {
            const parsed = observedLog(line)
            return parsed ? (
              <LogItem key={index} {...parsed} index={index} />
            ) : (
              <pre key={index} className="relay-log-line">
                {line}
              </pre>
            )
          })}
        </div>
      ) : (
        <div className="relay-runtime-empty">
          {!current
            ? '正在读取日志…'
            : logLines.length
              ? '没有符合筛选条件的日志。'
              : current.state.phase !== 'running'
                ? 'Relay 内核未运行，暂无日志。'
                : current.logs.lines.length
                  ? '已清空显示，等待新日志。'
                  : '暂无日志。当前日志级别可能不输出常规信息。'}
        </div>
      )}
    </div>
  )
  return (
    <section
      className="relay-runtime-page"
      data-relay-runtime-view={view ?? 'all'}
      aria-busy={pending}
    >
      <div className="relay-runtime-toolbar relay-runtime-heading">
        <span className="relay-runtime-status">
          {notice && !current ? '读取失败' : runtimeLabel}
        </span>
        {current?.state.profileName && (
          <span className="relay-runtime-profile">{current.state.profileName}</span>
        )}
        <span className="relay-runtime-spacer" />
        <button
          type="button"
          aria-pressed={watching}
          onClick={() => setWatching(!watching)}
          disabled={busy}
        >
          {watching ? '暂停刷新' : '实时刷新'}
        </button>
        <button type="button" disabled={busy || pending} onClick={() => void read()}>
          {showNetwork ? '刷新连接' : '刷新'}
        </button>
        {showConnections && (
          <button
            type="button"
            className="relay-runtime-danger"
            aria-label="关闭本次实例全部连接"
            disabled={
              showClosed ||
              busy ||
              pending ||
              !canClose ||
              !current?.connections?.connections.length
            }
            onClick={() => void close()}
          >
            关闭全部连接
          </button>
        )}
      </div>
      {notice && (
        <p role="status" className="relay-runtime-notice">
          {notice}
        </p>
      )}
      {showNetwork && (
        <p className="relay-probe-scope">
          此页只统计经过 Relay 的连接，不包含 Clash Party 的流量。
          {current?.state.httpPort ? ` Relay 代理端口：${current.state.httpPort}。` : ''}
          连接为空时可在系统代理或虚拟网卡中核对流量入口；出口 IP 和延迟需分别刷新。
        </p>
      )}
      {showConnections && (
        <div className="relay-runtime-stats">
          <div>
            <span>上传</span>
            <strong>{rate ? `${formatTraffic(rate.upload)}/s` : '—'}</strong>
            <small>累计 {formatTraffic(current?.connections?.upload)}</small>
          </div>
          <div>
            <span>下载</span>
            <strong>{rate ? `${formatTraffic(rate.download)}/s` : '—'}</strong>
            <small>累计 {formatTraffic(current?.connections?.download)}</small>
          </div>
          <div>
            <span>当前连接</span>
            <strong>{current?.connections?.connections.length ?? '—'}</strong>
            <small>Relay 自有内核</small>
          </div>
        </div>
      )}
      {showLogsFirst && logPanel}
      {showConnections && (
        <>
          <div className="relay-runtime-toolbar">
            <button type="button" aria-pressed={!showClosed} onClick={() => setShowClosed(false)}>
              活动中{current ? ` ${current.connections?.connections.length ?? 0}` : ''}
            </button>
            <button type="button" aria-pressed={showClosed} onClick={() => setShowClosed(true)}>
              已关闭{current ? ` ${current.closedConnections.length}` : ''}
            </button>
            <input
              aria-label="筛选目标、进程或代理链"
              placeholder="搜索目标、进程或代理链"
              value={connectionQuery}
              onChange={(event) => setConnectionQuery(event.target.value)}
            />
            <select
              aria-label="连接排序"
              value={displayOrder}
              disabled={busy || pending || !appConfig}
              onChange={(event) => {
                if (event.target.value === 'snapshot') {
                  setSnapshotOrder(true)
                  return
                }
                const connectionOrderBy = connectionSortPreference(event.target.value)
                if (connectionOrderBy) void saveConnectionSort({ connectionOrderBy })
              }}
            >
              {Object.entries(connectionOrderLabels)
                .filter(([value]) => !showClosed || !isRateColumn(value))
                .map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
            </select>
            <button
              type="button"
              aria-label="切换连接排序方向"
              disabled={busy || pending || !appConfig || displayOrder === 'snapshot'}
              onClick={() =>
                void saveConnectionSort({ connectionDirection: descending ? 'asc' : 'desc' })
              }
            >
              {descending ? '降序' : '升序'}
            </button>
            <button
              type="button"
              aria-pressed={tableView}
              onClick={() => updateConnectionView({ tableView: !tableView })}
            >
              {tableView ? '卡片视图' : '表格视图'}
            </button>
          </div>
          <details className="relay-runtime-advanced">
            <summary>显示选项</summary>
            <div className="relay-runtime-toolbar">
              {showClosed && (
                <button
                  type="button"
                  disabled={!current?.closedConnections.length}
                  onClick={clearClosedConnections}
                >
                  清除已结束列表
                </button>
              )}
            </div>
            {tableView && (
              <div className="relay-runtime-columns">
                {visibleColumns.map((column) => (
                  <label key={column}>
                    <input
                      type="checkbox"
                      checked={columns.includes(column)}
                      onChange={(event) =>
                        updateConnectionView({
                          columns: optionalColumns.filter((item) =>
                            item === column ? event.target.checked : columns.includes(item)
                          )
                        })
                      }
                    />
                    {connectionColumns[column]}
                  </label>
                ))}
              </div>
            )}
            <p>
              已关闭列表保留连续采样中观测到的最近 {observedConnectionLimit}{' '}
              条连接。应用图标按需读取；关闭连接会影响使用本次代理的应用。
            </p>
          </details>
          {!current ? (
            <div className="relay-runtime-empty">
              {notice ? '连接暂不可用，请刷新重试。' : '正在读取连接…'}
            </div>
          ) : connectionCount === 0 ? (
            <div className="relay-runtime-empty">
              {showClosed ? (
                '暂无已关闭连接。'
              ) : current.state.phase !== 'running' ? (
                <>
                  Relay 内核未运行。<a href="#/relay?panel=profiles">选择配置开始使用</a>
                </>
              ) : (
                '当前没有活动连接。'
              )}
            </div>
          ) : !rows.length ? (
            <div className="relay-runtime-empty">没有符合筛选条件的连接。</div>
          ) : tableView ? (
            <RelayConnectionSnapshotTable
              rows={rows}
              columns={columns.filter((column) => visibleColumns.includes(column))}
              actions={showClosed ? undefined : connectionActions}
              onSelect={setSelectedConnection}
            />
          ) : (
            <div className="relay-runtime-connections">
              {rows.map((entry) => (
                <article className="relay-connection-card" key={`${entry.id}-${entry.position}`}>
                  {connectionIcon(entry)}
                  <button
                    type="button"
                    className="relay-connection-main relay-connection-open"
                    onClick={() => setSelectedConnection(entry)}
                    title="查看连接详情"
                  >
                    <strong>
                      {entry.source ? `${entry.source} → ` : ''}
                      {entry.target}
                    </strong>
                    <span>{entry.process}</span>
                    <div className="relay-connection-tags">
                      {entry.protocol && <span>{entry.protocol}</span>}
                      {entry.route && <span>{entry.route}</span>}
                      <span>
                        ↑ {formatTraffic(entry.upload)} ↓ {formatTraffic(entry.download)}
                      </span>
                      {!showClosed && (
                        <span>
                          ↑ {formatConnectionRate(entry.uploadRate)} ↓{' '}
                          {formatConnectionRate(entry.downloadRate)}
                        </span>
                      )}
                    </div>
                  </button>
                  <div className="relay-connection-actions">
                    {entry.startedAt !== undefined && (
                      <time
                        dateTime={new Date(entry.startedAt).toISOString()}
                        title={new Date(entry.startedAt).toLocaleString()}
                      >
                        {dayjs(entry.startedAt).fromNow()}
                      </time>
                    )}
                    {!showClosed && connectionActions(entry)}
                  </div>
                </article>
              ))}
            </div>
          )}
          {!showClosed &&
            !!current?.connections &&
            current.connections.connections.length > observedConnectionLimit && (
              <p>
                当前列表展示前 {observedConnectionLimit} 条，共{' '}
                {current.connections.connections.length} 条；关闭全部会作用于本次实例全部连接。
              </p>
            )}
        </>
      )}
      {!view && !logsFirst && logPanel}
      {selectedConnection && (
        <RelayConnectionDetails
          entry={selectedConnection}
          onClose={() => setSelectedConnection(undefined)}
        />
      )}
      <div hidden={!showNetwork}>
        <RelayIsolatedProbesPanel
          busy={busy}
          onBusy={onBusy}
          active={active && showNetwork}
          between={
            showNetwork && current?.connections ? (
              <NetworkTopologyCard
                key={`${current.state.instanceId}:${current.state.configurationRevision}`}
                snapshot={topologyConnections}
              />
            ) : undefined
          }
        />
      </div>
      {showNetwork && (
        <>
          {(current?.connections?.connections.length ?? 0) > observedConnectionLimit && (
            <p>拓扑展示当前快照前 {observedConnectionLimit} 条连接。</p>
          )}
          <details className="relay-network-interfaces">
            <summary>本机网络接口</summary>
            {!current ? (
              <p>{notice ? '网络接口读取失败，请刷新重试。' : '正在读取网络接口…'}</p>
            ) : current.info.interfaces.length ? (
              current.info.interfaces.map((iface) => (
                <div className="relay-network-interface" key={iface.name}>
                  <strong>{iface.name}</strong>
                  <div>
                    {iface.addresses.map((address) => (
                      <span key={`${address.family}:${address.address}`}>
                        {address.address}
                        <small>
                          {address.family}
                          {address.internal ? ' · 回环' : ''}
                        </small>
                      </span>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <p>没有可显示的网络接口。</p>
            )}
            {current?.info.warnings.map((warning) => (
              <p role="status" key={warning}>
                {warning}
              </p>
            ))}
          </details>
        </>
      )}
      <details className="relay-runtime-advanced">
        <summary>运行详情</summary>
        <p>仅显示 Relay 自有内核；其他代理客户端的连接与流量不在此处统计。</p>
        <p>速度需要两次有效采样。暂停刷新后保留最后一次读取；清空日志仅清除当前显示。</p>
        {current && (
          <p>
            核心状态：{current.state.phase} · PID：{current.state.pid ?? '未运行'} · HTTP：
            {current.state.httpPort ?? '未监听'} · 模式：{current.state.mode ?? '未读取'}
          </p>
        )}
      </details>
    </section>
  )
}
