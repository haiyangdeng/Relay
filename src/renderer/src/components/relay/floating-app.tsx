import { useEffect, useState } from 'react'
import {
  parseFloatingTrafficSnapshot,
  type RelayFloatingTrafficSnapshot
} from '../../../../shared/relay/floating-traffic'
import { formatFloatingTraffic } from '../../utils/floating-traffic'
import MihomoIcon from '../base/mihomo-icon'

export function RelayFloatingView({
  snapshot,
  transparent = false
}: {
  snapshot: RelayFloatingTrafficSnapshot
  transparent?: boolean
}): React.JSX.Element {
  const traffic = formatFloatingTraffic(snapshot),
    tun =
      snapshot.status === 'ready' &&
      'kind' in snapshot.sample &&
      snapshot.sample.kind === 'tun-managed'
  const rate =
    snapshot.status === 'ready' && snapshot.spinFloatingIcon
      ? snapshot.sample.up + snapshot.sample.down
      : 0
  // Clash Party v2.0.4 rate bands, expressed as one turn at 60 frames/s.
  const spinDuration =
    rate === 0
      ? undefined
      : rate < 1024
        ? '3s'
        : rate < 1048576
          ? '2s'
          : rate < 1073741824
            ? '1.5s'
            : '1.2s'

  return (
    <div
      className="app-drag h-screen w-screen overflow-hidden"
      style={{
        background: transparent ? 'rgba(237, 244, 242, 0.88)' : '#edf4f2',
        color: '#20352f'
      }}
    >
      <div className="floating-bg flex h-full w-full items-center gap-2 border border-divider p-2">
        <div
          className="flex h-full shrink-0 items-center justify-center"
          style={{ width: 38 }}
          aria-hidden="true"
        >
          <MihomoIcon
            className={
              spinDuration ? 'floating-icon relay-floating-spin h-9 w-7' : 'floating-icon h-9 w-7'
            }
            style={spinDuration ? { animationDuration: spinDuration } : undefined}
          />
        </div>
        <div className="min-w-0 flex-1">
          <p className="floating-text text-xs">
            Relay · {tun ? 'TUN核心' : snapshot.status === 'ready' ? '普通实例' : '自有核心'}
          </p>
          {traffic ? (
            <div role="status" className="floating-text text-right text-xs font-bold tabular-nums">
              <p aria-label="上传速率">↑ {traffic.upload}</p>
              <p aria-label="下载速率">↓ {traffic.download}</p>
            </div>
          ) : (
            <p role="status" className="floating-text text-xs">
              {snapshot.status === 'loading'
                ? '正在读取流量…'
                : snapshot.status === 'hidden'
                  ? '流量读取已暂停'
                  : '流量未确认'}
            </p>
          )}
          <p className="app-nodrag floating-text text-[10px]" title="右键打开Relay菜单">
            本次核心汇总 · 右键菜单
          </p>
        </div>
      </div>
    </div>
  )
}

export function RelayFloatingApp({
  transparent = false
}: {
  transparent?: boolean
}): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<RelayFloatingTrafficSnapshot>({
    version: 1,
    status: 'loading'
  })
  useEffect(() => {
    const bridge = window.relayFloatingTraffic
    if (!bridge) {
      setSnapshot({ version: 1, status: 'unavailable' })
      return
    }
    return bridge.onSnapshot((raw) => {
      setSnapshot(parseFloatingTrafficSnapshot(raw) ?? { version: 1, status: 'unavailable' })
    })
  }, [])
  return <RelayFloatingView snapshot={snapshot} transparent={transparent} />
}
