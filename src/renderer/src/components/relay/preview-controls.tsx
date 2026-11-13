import React from 'react'
import { IoLockClosedOutline } from 'react-icons/io5'
import useSWR from 'swr'
import { Navigate, useLocation } from 'react-router-dom'
import {
  isRelayNavigationActive,
  RELAY_WORKSPACE_ROUTES,
  relayNavigationTarget
} from '@renderer/utils/relay-workspace'
import { useAppConfig } from '@renderer/hooks/use-app-config'
import { getSiderCardRoute } from '@renderer/utils/sider'
import type { RelayStatus } from '../../../../shared/relay/protocol'
import { SIMPLE_MODULES } from '../../../../shared/simple-config'
import { RelayNavigation } from './navigation'

// This renderer is paired with the preview-only main entry. Enabling live
// control requires a separate, implemented runtime and explicit handover.
export const RELAY_PREVIEW_ONLY = true

interface ControlsProps {
  iconOnly?: boolean
  expanded?: boolean
  liveControls?: React.ReactNode
  clashViewsReady?: boolean
}

const modules = [
  'System Proxy',
  'TUN',
  'Profiles & Nodes',
  'Rules & DNS',
  'Connections & Logs',
  'Core Settings',
  'Desktop Login',
  'Connection Guard'
]
const moduleLinks: Record<string, string> = {
  'System Proxy': '#/sysproxy',
  TUN: '#/tun',
  'Profiles & Nodes': '#/profiles',
  'Rules & DNS': '#/rules',
  'Connections & Logs': '#/connections',
  'Core Settings': '#/mihomo',
  'Desktop Login': '#/relay?panel=desktop-login',
  'Connection Guard': '#/relay?panel=guard'
}

export function RelayPreviewControls({
  iconOnly = false,
  expanded = false,
  liveControls,
  clashViewsReady = false
}: ControlsProps): React.JSX.Element {
  const location = useLocation()
  const compact = iconOnly && !expanded
  return (
    <section className="min-h-0 flex-1 overflow-y-auto px-2 py-3" aria-label="Relay功能入口">
      {!clashViewsReady && (
        <p className="text-xs text-default-600 mb-3 leading-relaxed" id="relay-controls-locked">
          {compact ? '暂不可用' : '完整Clash后端尚未接入，以下侧栏功能暂不可操作。'}
        </p>
      )}
      {liveControls ?? (
        <div
          role="group"
          aria-label="网络模式（未接入）"
          className={`grid gap-1 mb-3 ${iconOnly ? 'grid-cols-1' : 'grid-cols-3'}`}
        >
          {['Rule', 'Global', 'Direct'].map((label) => (
            <button
              key={label}
              type="button"
              disabled
              aria-label={`${label}（尚未接入）`}
              aria-describedby="relay-controls-locked"
              title="完整Clash后端尚未接入，不能在这里切换网络模式"
              className="rounded-lg border border-default-200 bg-default-100 px-1 py-2 text-xs text-default-500 cursor-not-allowed"
            >
              {compact ? label[0] : label}
            </button>
          ))}
        </div>
      )}
      {clashViewsReady && <RelayNavigation compact={compact} />}
      <div className={`grid gap-2 ${iconOnly ? 'grid-cols-1' : 'grid-cols-2'}`}>
        {modules
          .filter(
            (label) => !clashViewsReady || ['Desktop Login', 'Connection Guard'].includes(label)
          )
          .map((label) =>
            clashViewsReady ? (
              <a
                key={label}
                href={moduleLinks[label]}
                aria-label={`打开${label}`}
                aria-current={
                  isRelayNavigationActive(
                    location.pathname,
                    location.search,
                    moduleLinks[label].slice(1)
                  )
                    ? 'page'
                    : undefined
                }
                className="relay-sidebar-shortcut flex min-w-0 flex-col gap-2 rounded-xl border p-3 text-left"
              >
                <span className="text-xs font-medium break-words">
                  {compact ? label[0] : label === 'Desktop Login' ? '桌面登录' : '连接保护'}
                </span>
              </a>
            ) : (
              <button
                key={label}
                type="button"
                disabled
                aria-label={`${label}（尚未接入）`}
                aria-describedby="relay-controls-locked"
                title={`${label}：功能尚未接入`}
                className="flex min-w-0 flex-col gap-2 rounded-xl border border-default-200 bg-default-50 p-3 text-left text-default-500 cursor-not-allowed"
              >
                <IoLockClosedOutline className="text-lg shrink-0" aria-hidden="true" />
                {!compact && <span className="text-xs font-medium break-words">{label}</span>}
                {!compact && <span className="text-xs">待接入</span>}
              </button>
            )
          )}
      </div>
    </section>
  )
}

interface PreviewPageProps {
  path: string
  children?: React.ReactNode
}

export function RelayPreviewPage({ path, children }: PreviewPageProps): React.ReactNode {
  const { appConfig } = useAppConfig()
  if (['/relay', '/proxies', '/sysproxy', '/traffic'].includes(path)) return children
  if (path === '/') {
    if (!appConfig) return null
    return (
      <Navigate
        to={
          appConfig.rememberSelectedSiderCard
            ? getSiderCardRoute(appConfig.lastSelectedSiderCard)
            : '/relay?panel=profiles'
        }
        replace
      />
    )
  }
  if (Object.hasOwn(RELAY_WORKSPACE_ROUTES, path))
    return <Navigate to={relayNavigationTarget(path)} replace />
  if (path.startsWith('/simple/')) {
    const module = path.slice('/simple/'.length)
    if (Object.hasOwn(SIMPLE_MODULES, module))
      return <Navigate to={`/relay?panel=simple&module=${encodeURIComponent(module)}`} replace />
  }
  // Do not mount upstream editors: some perform follow-up writes after a failed
  // save. The main-process boundary remains in place independently of this UI.
  return (
    <section className="m-6 rounded-2xl border border-default-200 bg-content1 p-6">
      <h1 className="text-xl font-semibold mb-3">该功能尚未接入</h1>
      <p className="text-sm text-default-600 leading-relaxed mb-4">
        当前功能仍在迁移，请使用已接通页面；其余网络控制和完整工作流尚未完成。
      </p>
      <a className="text-primary underline text-sm" href="#/relay">
        返回 AI Workspace
      </a>
    </section>
  )
}

export function RelayProxyRecoveryNotice(): React.JSX.Element | null {
  const { data } = useSWR<RelayStatus>(
    'relayStatus',
    () => window.electron.ipcRenderer.invoke('relayStatus') as Promise<RelayStatus>,
    { refreshInterval: 2000, revalidateOnFocus: false, errorRetryCount: 0 }
  )
  const status = data?.systemProxyStatus
  if (status !== 'pending' && status !== 'conflict' && status !== 'uncertain') return null

  return (
    <div
      role="status"
      className="px-4 py-2 text-xs bg-warning-50 text-warning-800 border-b border-warning-200"
    >
      系统代理恢复记录待核对。{' '}
      <a className="underline" href="#/sysproxy">
        查看系统代理
      </a>
    </div>
  )
}
