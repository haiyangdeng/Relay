import { Link } from 'react-router-dom'
import type { IconType } from 'react-icons'
import {
  IoFlash,
  IoLayers,
  IoShieldCheckmark,
  IoCheckmark,
  IoCodeSlashOutline,
  IoTerminalOutline,
  IoLaptopOutline,
  IoGitNetworkOutline,
  IoPulseOutline,
  IoServer,
  IoSettings,
  IoChevronForwardOutline
} from 'react-icons/io5'
import relayMascot from '@renderer/assets/relay-mascot-transparent.png'
import { relayWorkspaceLink } from '@renderer/utils/relay-workspace'
import useSWR from 'swr'
import type { RelayStatus } from '../../../../shared/relay/protocol'
import { corePresentationKey, readCorePresentation, RelayCoreStatus } from './core-presentation'

const shortcuts = [
  ['clients', 'Claude 与 Codex', '专用代理与客户端配置', IoCodeSlashOutline, 'blue', 'tile'],
  ['code', 'Claude Code 配置', '启动入口、参数与配置', IoTerminalOutline, 'violet', 'tile'],
  [
    'desktop-login',
    '桌面登录',
    'Microsoft Edge 登录与默认浏览器恢复',
    IoLaptopOutline,
    'cyan',
    'symbol'
  ],
  ['guard', '连接保护', '查看保护能力与当前状态', IoCheckmark, 'green', 'tile'],
  ['core', '本地代理', '启动设置与固定节点', IoGitNetworkOutline, 'cyan', 'symbol'],
  ['diagnostics', '配置检测', '核对配置、归属与端口', IoPulseOutline, 'blue', 'tile'],
  ['backup', '备份与恢复', '本地备份与远程存储', IoServer, 'amber', 'symbol'],
  ['settings', '设置', '界面、窗口、维护与更新', IoSettings, 'violet', 'symbol']
] as const

function OverviewIcon({
  icon: Icon,
  tone,
  appearance = 'symbol'
}: {
  icon: IconType
  tone: string
  appearance?: 'tile' | 'symbol'
}): React.JSX.Element {
  return (
    <span className={`relay-overview-icon relay-tone-${tone}`} data-appearance={appearance}>
      <Icon aria-hidden="true" />
    </span>
  )
}

export function RelayOverviewPanel({
  status,
  active
}: {
  status?: RelayStatus
  active: boolean
}): React.JSX.Element {
  const { data } = useSWR(active ? corePresentationKey : null, readCorePresentation)
  return (
    <div className="relay-overview">
      <section className="relay-hero">
        <div className="relay-hero-copy">
          <span className="relay-eyebrow">YOUR NETWORK, IN VIEW</span>
          <h1>Relay</h1>
          <p>管理配置、代理连接与客户端工作流。</p>
          <div className="relay-pills">
            <span>配置与运行状态以本次读取结果为准</span>
          </div>
        </div>
        <div className="relay-hero-art">
          <img src={relayMascot} alt="Relay 松鼠" width="256" height="256" />
        </div>
      </section>
      <div className="relay-status-grid">
        <div>
          <OverviewIcon icon={IoFlash} tone="cyan" />
          <div>
            <small>代理核心</small>
            <strong>Mihomo</strong>
            <p>
              <RelayCoreStatus {...data} />
            </p>
          </div>
        </div>
        <div>
          <OverviewIcon icon={IoLayers} tone="green" />
          <div>
            <small>本地配置组件</small>
            <strong>{status ? (status.nativeReady ? '可用' : '不可用') : '待读取'}</strong>
            <p>客户端配置与备份恢复</p>
          </div>
        </div>
        <div>
          <OverviewIcon icon={IoShieldCheckmark} tone="violet" />
          <div>
            <small>系统防直连</small>
            <strong>本版未提供</strong>
            <p>专用代理可绑定指定节点</p>
          </div>
        </div>
      </div>
      <nav className="relay-shortcuts" aria-label="工作区快捷入口">
        {shortcuts.map(([panel, title, description, Icon, tone, appearance]) => (
          <Link key={panel} to={relayWorkspaceLink(panel)}>
            <OverviewIcon icon={Icon} tone={tone} appearance={appearance} />
            <div>
              <strong>{title}</strong>
              <span>{description}</span>
            </div>
            <IoChevronForwardOutline className="relay-overview-arrow" aria-hidden="true" />
          </Link>
        ))}
      </nav>
    </div>
  )
}
