import { Switch } from '@heroui/react'
import { calcTraffic } from '@renderer/utils/calc'
import { Fragment, useSyncExternalStore, useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useLocation, useNavigate } from 'react-router-dom'
import { isRelayNavigationActive, relayNavigationTarget } from '@renderer/utils/relay-workspace'
import {
  DndContext,
  closestCorners,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import { SortableContext, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { useProfileConfig } from '@renderer/hooks/use-profile-config'
import { mergeSiderOrder, SIDER_CARD_LABELS, SIDER_CARD_ROUTES } from '@renderer/utils/sider'
import { getAppConfig, patchAppConfig } from '@renderer/utils/ipc'
import type { IconType } from 'react-icons'
import {
  IoGlobeOutline,
  IoHardwareChipOutline,
  IoDocumentTextOutline,
  IoGitNetworkOutline,
  IoGitBranchOutline,
  IoLayersOutline,
  IoCodeSlashOutline,
  IoLinkOutline,
  IoServerOutline,
  IoScanOutline,
  IoReaderOutline,
  IoCloudDownloadOutline,
  IoEarthOutline,
  IoPieChartOutline,
  IoChevronForwardOutline,
  IoSettingsOutline,
  IoRefreshOutline,
  IoApertureOutline,
  IoArrowUpOutline,
  IoArrowDownOutline
} from 'react-icons/io5'
import { DEFAULT_SIDER_ORDER } from '../../../../shared/appConfig'
import { ordinaryRecoveryNotice } from '../../../../shared/relay/tun'
import { relayDefaultSidebarLayout } from '../../../../shared/relay/ui-preferences'
import {
  activeTunSwitch,
  tunSwitchProgress,
  tunStoppingNotice,
  type TunSwitchBinding
} from './tun-controller'
import { useSidebarStatus, type SidebarStatus, type SidebarSwitch } from './use-sidebar-status'
import { RelayCoreStatus } from './core-presentation'
import './navigation.css'

type TrafficPoint = { upload: number; download: number }
function TrafficSparkline({ points }: { points: TrafficPoint[] }): React.JSX.Element | null {
  const gradientId = useId()
  if (points.length < 2) return null
  const peak = Math.max(1, ...points.flatMap((point) => [point.upload, point.download]))
  const line = (field: keyof TrafficPoint): string =>
    points
      .map(
        (point, index) =>
          `${index ? 'L' : 'M'}${(index * 200) / (points.length - 1)},${28 - (point[field] / peak) * 25}`
      )
      .join(' ')
  return (
    <svg
      className="relay-nav-traffic"
      viewBox="0 0 200 30"
      preserveAspectRatio="none"
      aria-label="本次核心最近观测的上传和下载速率"
    >
      <defs>
        <linearGradient id={`${gradientId}-upload`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#43df88" stopOpacity="0.42" />
          <stop offset="100%" stopColor="#43df88" stopOpacity="0.02" />
        </linearGradient>
        <linearGradient id={`${gradientId}-download`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#27d7f5" stopOpacity="0.4" />
          <stop offset="100%" stopColor="#27d7f5" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path
        d={`${line('upload')} L200,30 L0,30 Z`}
        fill={`url(#${gradientId}-upload)`}
        className="relay-nav-traffic-area"
      />
      <path
        d={`${line('download')} L200,30 L0,30 Z`}
        fill={`url(#${gradientId}-download)`}
        className="relay-nav-traffic-area"
      />
      <path d={line('upload')} className="relay-nav-upload" />
      <path d={line('download')} className="relay-nav-download" />
    </svg>
  )
}

const cardIcons: Record<SiderCardKey, IconType> = {
  sysproxy: IoGlobeOutline,
  tun: IoHardwareChipOutline,
  profile: IoDocumentTextOutline,
  proxy: IoGitNetworkOutline,
  rule: IoGitBranchOutline,
  resource: IoLayersOutline,
  override: IoCodeSlashOutline,
  connection: IoLinkOutline,
  mihomo: IoHardwareChipOutline,
  dns: IoServerOutline,
  sniff: IoScanOutline,
  log: IoReaderOutline,
  substore: IoCloudDownloadOutline,
  network: IoEarthOutline,
  usage: IoPieChartOutline
}

function NavigationItem({
  id,
  compact,
  locked,
  wide,
  profileName,
  status,
  closingTun,
  switchingSystem,
  startingTun,
  panelSwitch,
  pending,
  change,
  refresh,
  trafficHistory
}: {
  id: SiderCardKey
  compact: boolean
  locked: boolean
  wide: boolean
  profileName?: string
  status: SidebarStatus
  closingTun: boolean
  panelSwitch?: TunSwitchBinding
  startingTun: boolean
  switchingSystem: boolean
  pending: boolean
  change(kind: SidebarSwitch, enabled: boolean): Promise<void>
  refresh(): Promise<void>
  trafficHistory: TrafficPoint[]
}): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const location = useLocation()
  const active = isRelayNavigationActive(location.pathname, location.search, SIDER_CARD_ROUTES[id])
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id,
    disabled: locked
  })
  const label = t(SIDER_CARD_LABELS[id])
  const Icon = cardIcons[id]
  const managed = status.system?.status === 'active' || status.system?.status === 'applied'
  const systemUnobserved = !status.systemObserved
  const tunEnabled =
    status.tun?.session.phase === 'active' && status.tun.session.traffic === 'forwarding'
  const toggles: Partial<
    Record<SiderCardKey, { checked: boolean; disabled: boolean; title: string }>
  > = {
    sysproxy: {
      checked: managed,
      // A click joins any read-only inspection and checks a fresh native report.
      disabled: status.systemWriting === true,
      title: systemUnobserved ? '状态未获取；点击检查并启用系统代理' : '系统代理（使用已保存设置）'
    },
    tun: {
      checked: panelSwitch?.checked ?? tunEnabled,
      // The quick action inspects the helper and session again. Background stats
      // and a previous helper read must not veto a new request.
      disabled: panelSwitch?.disabled ?? !!status.tun?.session.pending,
      title: closingTun
        ? tunStoppingNotice
        : status.tun?.helper === 'missing'
          ? '首次使用需安装 TUN 权限组件'
          : '虚拟网卡'
    },
    dns: {
      checked: status.dns === true,
      disabled:
        status.dns === undefined ||
        !status.local ||
        status.local.pending ||
        status.local.uncertain ||
        !!status.tun?.session.owned,
      title: '启用 DNS；运行时应用到当前配置'
    },
    sniff: {
      checked: status.sniff === true,
      disabled:
        status.sniff === undefined ||
        !status.local ||
        status.local.pending ||
        status.local.uncertain ||
        !!status.tun?.session.owned,
      title: '启用嗅探；运行时应用到当前配置'
    }
  }
  const toggle = toggles[id]
  const networkSwitch = id === 'sysproxy' || id === 'tun'
  const openSettings = (): void => {
    void navigate(relayNavigationTarget(SIDER_CARD_ROUTES[id]))
  }
  const count = id === 'proxy' ? status.groups : id === 'rule' ? status.rules : undefined
  const activeColors = 'border-primary bg-primary/10 text-foreground'
  return (
    <div
      className={`relative min-w-0 ${wide ? 'col-span-2' : ''}`}
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
    >
      <button
        type="button"
        onClick={openSettings}
        title={id === 'profile' && profileName ? `${label} · ${profileName}` : label}
        className={`relay-nav-card w-full min-w-0 rounded-xl border p-2.5 text-sm break-words flex flex-col ${compact ? 'items-center justify-center min-h-12' : 'items-start justify-between gap-2 min-h-[68px] text-left font-semibold'} ${active ? activeColors : 'border-default-200 bg-content1 text-foreground hover:bg-default-100'} `}
        data-card={id}
        style={{
          touchAction: locked ? 'auto' : 'none'
        }}
        {...attributes}
        {...listeners}
        aria-disabled={undefined}
        aria-current={active ? 'page' : undefined}
        aria-label={label}
      >
        {compact ? (
          <Icon className="relay-nav-icon text-xl shrink-0" aria-hidden="true" />
        ) : id === 'profile' ? (
          <span className="relay-nav-profile-row">
            <Icon className="relay-nav-icon relay-nav-profile-icon" aria-hidden="true" />
            <span className="relay-nav-profile-copy">
              <span className="truncate">{profileName || label}</span>
              {profileName && <span className="relay-nav-subtitle">{label}</span>}
            </span>
            <IoChevronForwardOutline className="relay-nav-chevron" aria-hidden="true" />
          </span>
        ) : id === 'mihomo' ? (
          <>
            <span className="relay-nav-core-version">
              <IoApertureOutline className="relay-nav-core-icon" aria-hidden="true" />
              <RelayCoreStatus
                local={status.local}
                tun={status.tun}
                sidebar
                version={status.version}
              />
            </span>
            <span className="relay-nav-core-detail">
              <IoSettingsOutline className="relay-nav-icon" aria-hidden="true" />
              <span>{label}</span>
              <span className="relay-nav-memory" title="Relay 内核常驻内存">
                {status.memory === undefined ? '—' : calcTraffic(status.memory)}
              </span>
            </span>
          </>
        ) : id === 'connection' ? (
          <>
            <span className="relay-nav-connection-heading">
              <span className="relay-nav-inline-label">
                <Icon className="relay-nav-icon" aria-hidden="true" />
                <span>{label}</span>
              </span>
              <span className="relay-nav-rates">
                <span>
                  <IoArrowUpOutline className="relay-nav-upload-arrow" aria-hidden="true" />
                  {status.rates ? calcTraffic(status.rates.upload) + '/s' : '—'}
                </span>
                <span>
                  <IoArrowDownOutline className="relay-nav-download-arrow" aria-hidden="true" />
                  {status.rates ? calcTraffic(status.rates.download) + '/s' : '—'}
                </span>
              </span>
            </span>
            <TrafficSparkline points={trafficHistory} />
          </>
        ) : id === 'log' || id === 'substore' ? (
          <span className="relay-nav-inline-label relay-nav-short-row">
            <Icon className="relay-nav-icon" aria-hidden="true" />
            <span>{label}</span>
            <IoChevronForwardOutline className="relay-nav-chevron" aria-hidden="true" />
          </span>
        ) : (
          <>
            <span className="relay-nav-card-top">
              <Icon className="relay-nav-icon" aria-hidden="true" />
              {(id === 'proxy' || id === 'rule') && (
                <span className="relay-nav-count">{count ?? '—'}</span>
              )}
            </span>
            <span className="relay-nav-card-bottom">
              <span className="min-w-0 truncate">
                {label}
                {id === 'tun' && (closingTun || startingTun) && (
                  <span className="ml-1 text-xs font-normal opacity-75">
                    {closingTun ? '· 正在关闭' : '· 正在开启'}
                  </span>
                )}
                {id === 'sysproxy' && (switchingSystem || systemUnobserved) && (
                  <span className="ml-1 text-xs font-normal opacity-75">
                    {switchingSystem ? '· 切换中' : '· 状态未获取'}
                  </span>
                )}
              </span>
              {!toggle && (
                <IoChevronForwardOutline className="relay-nav-chevron" aria-hidden="true" />
              )}
            </span>
          </>
        )}
      </button>
      {networkSwitch && toggle ? (
        <button
          type="button"
          role="switch"
          aria-label={`${label}快捷开关`}
          aria-checked={toggle.checked}
          title={toggle.title}
          disabled={pending || toggle.disabled}
          className="relay-nav-network-switch"
          onClick={() => {
            if (id === 'tun' && panelSwitch) panelSwitch.setEnabled(!toggle.checked)
            else void change(id, !toggle.checked)
          }}
        >
          <span aria-hidden="true" />
        </button>
      ) : !compact && toggle ? (
        <div className="relay-nav-toggle" onPointerDown={(event) => event.stopPropagation()}>
          <Switch
            size="sm"
            classNames={{ base: 'relay-nav-switch', wrapper: 'relay-nav-switch-track' }}
            aria-label={`${label}快捷开关`}
            title={toggle.title}
            isSelected={toggle.checked}
            isDisabled={pending || toggle.disabled}
            onValueChange={(value) => void change(id as SidebarSwitch, value)}
          />
        </div>
      ) : null}
      {!compact && id === 'mihomo' && (
        <button
          type="button"
          className="relay-nav-core-refresh"
          aria-label="刷新核心状态"
          title="刷新核心状态"
          disabled={pending}
          onClick={() => void refresh()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <IoRefreshOutline aria-hidden="true" />
        </button>
      )}
    </div>
  )
}

export function RelayNavigation({ compact }: { compact: boolean }): React.JSX.Element {
  const { appConfig, mutateAppConfig } = useAppConfig()
  const { profileConfig } = useProfileConfig()
  const sidebar = useSidebarStatus(profileConfig?.current)
  const panelSwitch = useSyncExternalStore(
    activeTunSwitch.subscribe,
    activeTunSwitch.read,
    activeTunSwitch.read
  )
  const transition = useSyncExternalStore(
    tunSwitchProgress.subscribe,
    tunSwitchProgress.read,
    tunSwitchProgress.read
  )
  const ordinaryRecovery = sidebar.status.tun?.ordinaryRecovery
  const closingTun = transition === 'stop' || sidebar.status.tun?.session.phase === 'stopping'
  const [traffic, setTraffic] = useState<{ owner: string; points: TrafficPoint[] }>({
    owner: '',
    points: []
  })
  const rates = sidebar.status.rates,
    trafficOwner = `${sidebar.status.local?.instanceId ?? ''}:${sidebar.status.local?.configurationRevision ?? ''}`
  useEffect(() => {
    if (
      !rates ||
      !sidebar.status.local?.instanceId ||
      ![rates.upload, rates.download].every((value) => Number.isFinite(value) && value >= 0)
    ) {
      setTraffic({ owner: '', points: [] })
      return
    }
    setTraffic((previous) => ({
      owner: trafficOwner,
      points: [...(previous.owner === trafficOwner ? previous.points : []), { ...rates }].slice(-30)
    }))
  }, [rates, trafficOwner, sidebar.status.local?.instanceId])
  const profileName = profileConfig?.items?.find((item) => item.id === profileConfig.current)?.name
  const saved = appConfig?.siderOrder ?? DEFAULT_SIDER_ORDER
  const layout = appConfig?.siderCardLayout ?? relayDefaultSidebarLayout
  const [order, setOrder] = useState<SiderCardKey[]>(() => mergeSiderOrder(saved))
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState('')
  const saving = useRef(false)
  const locked = !appConfig || pending || appConfig.lockSiderCards === true
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
  const visible = order.filter((id) => layout[id] !== 'hidden')
  useEffect(() => setOrder(mergeSiderOrder(saved)), [saved])
  const reorder = async ({ active, over }: DragEndEvent): Promise<void> => {
    if (saving.current || locked || !over || active.id === over.id) return
    const next = [...order]
    const from = next.findIndex((id) => id === active.id)
    const to = next.findIndex((id) => id === over.id)
    if (from < 0 || to < 0) return
    next.splice(to, 0, next.splice(from, 1)[0])
    saving.current = true
    setPending(true)
    try {
      await patchAppConfig({ siderOrder: next })
      await mutateAppConfig()
      const confirmed = await getAppConfig()
      setOrder(mergeSiderOrder(confirmed.siderOrder))
      setNotice('')
    } catch {
      setNotice('侧栏顺序保存或回读未确认，请重新读取界面偏好。')
    } finally {
      saving.current = false
      setPending(false)
    }
  }
  const lastSwitchIndex = Math.max(visible.indexOf('sysproxy'), visible.indexOf('tun'))
  const networkNotice = (ordinaryRecovery || closingTun || sidebar.notice) && (
    <p role="status" className="col-span-full text-xs px-1 pb-2">
      {ordinaryRecovery
        ? ordinaryRecoveryNotice(ordinaryRecovery)
        : closingTun
          ? tunStoppingNotice
          : sidebar.notice}
      {ordinaryRecovery?.phase === 'failed' && (
        <a href="#/relay?panel=tun" className="ml-1 text-primary">
          打开虚拟网卡设置
        </a>
      )}
    </p>
  )
  return (
    <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={reorder}>
      <SortableContext items={visible}>
        <div
          className={`relay-navigation grid gap-2 mb-3 ${compact ? 'grid-cols-1' : 'grid-cols-2'}`}
          data-compact={compact}
        >
          {visible.map((id, index) => (
            <Fragment key={id}>
              <NavigationItem
                id={id}
                compact={compact}
                locked={locked}
                wide={!compact && layout[id] === 'col-span-2'}
                profileName={profileName}
                status={sidebar.status}
                closingTun={closingTun}
                switchingSystem={sidebar.switchingSystem}
                panelSwitch={id === 'tun' ? panelSwitch : undefined}
                startingTun={transition === 'start' || sidebar.switchingTun}
                pending={
                  sidebar.pending ||
                  !!transition ||
                  closingTun ||
                  ordinaryRecovery?.phase === 'resuming'
                }
                change={sidebar.change}
                refresh={sidebar.refresh}
                trafficHistory={traffic.owner === trafficOwner && rates ? traffic.points : []}
              />
              {index === lastSwitchIndex && networkNotice}
            </Fragment>
          ))}
        </div>
        {lastSwitchIndex === -1 && networkNotice}
        {notice && <p role="status">{notice}</p>}
      </SortableContext>
    </DndContext>
  )
}
