import BasePage from '@renderer/components/base/base-page'
import { RelayTrafficHistoryControls } from '@renderer/components/relay/traffic-history-controls'
import TrafficRankings from '@renderer/components/traffic/traffic-rankings'
import TrafficTrendChart from '@renderer/components/traffic/traffic-trend-chart'
import TrafficDetailsTable from '@renderer/components/traffic/traffic-details-table'
import {
  getTrafficOverview,
  getSubStatsByHost,
  getDevicesByHost,
  getProxyStatsByHost,
  clearTrafficUsageData,
  type AggregatedData,
  type DataUsageType
} from '@renderer/utils/dataUsage'
import { Button, Tab, Tabs } from '@heroui/react'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { calcTraffic } from '@renderer/utils/calc'
import { CgTrash } from 'react-icons/cg'

type TimeRange = '1h' | '24h' | '7d' | '30d'

const TIME_RANGES: TimeRange[] = ['1h', '24h', '7d', '30d']
const AUTO_REFRESH_INTERVAL_MS = 5000

function getTimeRange(range: TimeRange): { start: number; end: number; bucketSizeMs: number } {
  const end = Date.now()
  const ms: Record<TimeRange, number> = {
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000
  }
  const bucket: Record<TimeRange, number> = {
    '1h': 5 * 60 * 1000,
    '24h': 60 * 60 * 1000,
    '7d': 6 * 60 * 60 * 1000,
    '30d': 24 * 60 * 60 * 1000
  }
  return { start: end - ms[range], end, bucketSizeMs: bucket[range] }
}

const TrafficPage: React.FC = () => {
  const { t } = useTranslation()
  const [activeView, setActiveView] = useState<DataUsageType>('host')
  const [timeRange, setTimeRange] = useState<TimeRange>('24h')
  const [rankings, setRankings] = useState<AggregatedData[]>([])
  const [trendData, setTrendData] = useState<
    { timestamp: number; upload: number; download: number }[]
  >([])
  const [selectedRow, setSelectedRow] = useState<string | null>(null)
  const [subStats, setSubStats] = useState<AggregatedData[]>([])
  const [proxyStatsMap, setProxyStatsMap] = useState<Record<string, AggregatedData[]>>({})
  const [selectedSubRow, setSelectedSubRow] = useState<string | null>(null)
  const [totalStats, setTotalStats] = useState({ upload: 0, download: 0, total: 0, count: 0 })
  const [bucketSizeMs, setBucketSizeMs] = useState(60 * 60 * 1000)
  const loadGenerationRef = useRef(0)
  const overviewRequestRef = useRef(0)
  const [detailLoading, setDetailLoading] = useState(false)
  const [expandingKey, setExpandingKey] = useState<string | null>(null)
  const detailLoadIdRef = useRef(0)
  const [historyBusy, setHistoryBusy] = useState(false)
  const [historyNotice, setHistoryNotice] = useState('')
  const [detailNotice, setDetailNotice] = useState('')
  const [overviewLoaded, setOverviewLoaded] = useState(false)
  const clearOperation = useRef(false)

  const load = useCallback(
    async (
      resetSelection = true,
      generation = loadGenerationRef.current,
      isCancelled: () => boolean = () => false
    ) => {
      const request = ++overviewRequestRef.current
      const { start, end, bucketSizeMs: bms } = getTimeRange(timeRange)
      const { rankings: agg, trend, totals } = await getTrafficOverview(activeView, start, end, bms)

      if (
        isCancelled() ||
        generation !== loadGenerationRef.current ||
        request !== overviewRequestRef.current
      )
        return

      setBucketSizeMs(bms)
      setRankings(agg)
      setTrendData(trend)
      setTotalStats(totals)
      setOverviewLoaded(true)
      setHistoryNotice('')

      if (resetSelection) {
        setSelectedRow(null)
        setSubStats([])
        setProxyStatsMap({})
        setSelectedSubRow(null)
      }
    },
    [activeView, timeRange]
  )

  useEffect(() => {
    const generation = ++loadGenerationRef.current
    ++detailLoadIdRef.current
    setOverviewLoaded(false)
    setRankings([])
    setTrendData([])
    setDetailNotice('')
    setHistoryNotice('')
    setSelectedRow(null)
    setSubStats([])
    setProxyStatsMap({})
    setSelectedSubRow(null)
    setDetailLoading(false)
    setExpandingKey(null)
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    let cancelled = false
    let refreshing = false
    let resetSelection = true
    let hasSnapshot = false

    const clearRefreshTimer = (): void => {
      if (refreshTimer === null) return
      clearTimeout(refreshTimer)
      refreshTimer = null
    }

    const refresh = async (): Promise<void> => {
      if (cancelled || document.hidden || refreshing) return
      if (clearOperation.current) {
        refreshTimer = setTimeout(() => void refresh(), AUTO_REFRESH_INTERVAL_MS)
        return
      }
      refreshing = true
      try {
        await load(resetSelection, generation, () => cancelled || document.hidden)
        if (!cancelled && !document.hidden) hasSnapshot = true
      } catch {
        if (!cancelled)
          setHistoryNotice(
            hasSnapshot
              ? '历史读取未确认，保留当前范围上次读取的内容。'
              : '所选范围读取失败，稍后会自动重试。'
          )
      } finally {
        refreshing = false
      }
      if (cancelled || document.hidden || generation !== loadGenerationRef.current) return
      resetSelection = false
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        void refresh()
      }, AUTO_REFRESH_INTERVAL_MS)
    }

    const handleVisibilityChange = (): void => {
      if (document.hidden) clearRefreshTimer()
      else void refresh()
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    void refresh()

    return () => {
      cancelled = true
      clearRefreshTimer()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [load])

  const handleSelectRow = useCallback(
    async (label: string) => {
      if (selectedRow === label) {
        detailLoadIdRef.current += 1
        setDetailLoading(false)
        setSelectedRow(null)
        setSubStats([])
        setProxyStatsMap({})
        setSelectedSubRow(null)
        return
      }
      setSelectedRow(label)
      setSubStats([])
      setDetailNotice('')
      setSelectedSubRow(null)
      setProxyStatsMap({})
      const detailLoadId = ++detailLoadIdRef.current
      setDetailLoading(true)

      try {
        const { start, end } = getTimeRange(timeRange)
        const subs =
          activeView === 'host'
            ? await getDevicesByHost(label, start, end)
            : await getSubStatsByHost(activeView, label, start, end)
        if (detailLoadId === detailLoadIdRef.current) {
          setSubStats(subs)
        }
      } catch {
        if (detailLoadId === detailLoadIdRef.current)
          setDetailNotice('详情读取失败，请重新选择此项重试。')
      } finally {
        if (detailLoadId === detailLoadIdRef.current) {
          setDetailLoading(false)
        }
      }
    },
    [selectedRow, activeView, timeRange]
  )

  const handleSubRowClick = useCallback(
    async (parentLabel: string, subLabel: string) => {
      const compositeKey = `${parentLabel}:${subLabel}`
      if (selectedSubRow === compositeKey) {
        setSelectedSubRow(null)
        return
      }
      setSelectedSubRow(compositeKey)
      setDetailNotice('')

      if (proxyStatsMap[compositeKey]) return
      const generation = loadGenerationRef.current
      const { start, end } = getTimeRange(timeRange)
      setExpandingKey(compositeKey)
      try {
        const proxies = await getProxyStatsByHost(activeView, parentLabel, subLabel, start, end)
        if (generation === loadGenerationRef.current)
          setProxyStatsMap((prev) => ({ ...prev, [compositeKey]: proxies }))
      } catch {
        if (generation === loadGenerationRef.current)
          setDetailNotice('代理详情读取失败，请收起后重新展开重试。')
      } finally {
        if (generation === loadGenerationRef.current)
          setExpandingKey((current) => (current === compositeKey ? null : current))
      }
    },
    [selectedSubRow, proxyStatsMap, activeView, timeRange]
  )

  const handleClearAll = useCallback(async () => {
    if (clearOperation.current || historyBusy) return
    clearOperation.current = true
    ++overviewRequestRef.current
    setHistoryBusy(true)
    try {
      await clearTrafficUsageData()
      await load()
      setHistoryNotice('本应用历史已清空，现有核心和连接不变。')
    } catch {
      setHistoryNotice('历史清空未完成或已取消，保留显示内容；可重新读取核对。')
    } finally {
      clearOperation.current = false
      setHistoryBusy(false)
    }
  }, [historyBusy, load])

  const timeRangeLabel: Record<TimeRange, string> = {
    '1h': t('traffic.timeRange.1h'),
    '24h': t('traffic.timeRange.24h'),
    '7d': t('traffic.timeRange.7d'),
    '30d': t('traffic.timeRange.30d')
  }

  const viewLabels: Record<DataUsageType, string> = {
    sourceIP: t('traffic.view.sourceIP'),
    host: t('traffic.view.host'),
    outbound: t('traffic.view.outbound'),
    process: t('traffic.view.process')
  }

  return (
    <BasePage
      title={t('sider.cards.traffic')}
      contained
      header={
        <div className="app-nodrag flex items-center gap-2">
          <Tabs
            size="sm"
            selectedKey={timeRange}
            isDisabled={historyBusy}
            onSelectionChange={(k) => setTimeRange(k as TimeRange)}
          >
            {TIME_RANGES.map((r) => (
              <Tab key={r} title={timeRangeLabel[r]} />
            ))}
          </Tabs>
          <Button
            size="sm"
            variant="light"
            color="danger"
            isIconOnly
            title={t('traffic.clearAll')}
            onPress={handleClearAll}
            isDisabled={historyBusy}
          >
            <CgTrash className="text-[16px]" />
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3 p-2">
        {historyNotice && <p role="status">{historyNotice}</p>}
        {/* Summary stats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {[
            { label: t('traffic.sessions'), value: totalStats.count.toString() },
            { label: t('traffic.upload'), value: calcTraffic(totalStats.upload) },
            { label: t('traffic.download'), value: calcTraffic(totalStats.download) },
            { label: t('traffic.total'), value: calcTraffic(totalStats.total) }
          ].map(({ label, value }) => (
            <div
              key={label}
              className="flex flex-col items-center rounded-xl border border-foreground/10 bg-content1 py-3 shadow-sm"
            >
              <span className="text-[11px] text-foreground/50 uppercase tracking-wide">
                {label}
              </span>
              <span className="mt-0.5 text-sm font-bold text-foreground">
                {overviewLoaded ? value : '—'}
              </span>
            </div>
          ))}
        </div>
        {overviewLoaded && totalStats.count === 0 && (
          <p className="text-xs text-default-500">
            所选时间范围暂无已保存用量。开启流量记录后会显示后续统计。
          </p>
        )}

        {/* View tabs */}
        <Tabs
          size="sm"
          selectedKey={activeView}
          isDisabled={historyBusy}
          onSelectionChange={(k) => setActiveView(k as DataUsageType)}
        >
          {(Object.keys(viewLabels) as DataUsageType[]).map((v) => (
            <Tab key={v} title={viewLabels[v]} />
          ))}
        </Tabs>

        {/* Rankings + Chart */}
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <div className="col-span-1 h-52 overflow-hidden rounded-xl border border-foreground/10 bg-content1 p-3 shadow-sm">
            <TrafficRankings
              title={viewLabels[activeView]}
              data={rankings}
              selectedRow={selectedRow}
              onSelect={handleSelectRow}
            />
          </div>
          <div className="sm:col-span-3 h-52 overflow-hidden rounded-xl border border-foreground/10 bg-content1 p-3 shadow-sm">
            <TrafficTrendChart data={trendData} bucketSizeMs={bucketSizeMs} />
          </div>
        </div>

        {/* Detail table */}
        {detailNotice && (
          <p role="status" className="text-xs text-warning">
            {detailNotice}
          </p>
        )}
        {selectedRow && (
          <TrafficDetailsTable
            selectedRow={selectedRow}
            activeView={activeView}
            subStats={subStats}
            proxyStatsMap={proxyStatsMap}
            selectedSubRow={selectedSubRow}
            onSubRowClick={handleSubRowClick}
            isLoading={detailLoading}
            expandingKey={expandingKey}
          />
        )}
        <RelayTrafficHistoryControls
          onChanged={() => load()}
          busy={historyBusy}
          onBusy={setHistoryBusy}
        />
      </div>
    </BasePage>
  )
}

export default TrafficPage
