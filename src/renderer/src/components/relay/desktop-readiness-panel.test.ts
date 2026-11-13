import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { desktopReadinessFixture } from '../../../../main/relay/__fixtures__/desktop-readiness'
import { RelayDesktopReadinessPanel } from './desktop-readiness-panel'

describe('Desktop readiness presentation', () => {
  it('shows matched conditions as a snapshot without a login or restore button', () => {
    const markup = renderToStaticMarkup(
      createElement(RelayDesktopReadinessPanel, {
        report: desktopReadinessFixture(),
        busy: false,
        ready: true,
        notice: '',
        onRead: () => {}
      })
    )
    expect(markup).toContain('开始时仍需重新核对和系统确认')
    expect(markup).toContain('未取得会话锁，代理端口未探测')
    expect(markup).toContain('旧桌面登录记录')
    expect(markup.match(/<button/g)).toHaveLength(1)
    expect(markup).not.toContain('已登录')
    expect(markup).toContain('Microsoft Edge')
    expect(markup).toContain('Edge 强制策略：符合登录要求')
    expect(markup).toContain('Edge 进程：已完全退出')
    expect(markup).not.toContain('Relay 浏览器入口')
    expect(markup).not.toContain('Chrome')
  })
  it('shows missing policies and running Edge as separate unmet conditions', () => {
    const markup = renderToStaticMarkup(
      createElement(RelayDesktopReadinessPanel, {
        report: {
          ...desktopReadinessFixture(),
          edgePoliciesReady: false,
          edgeClosed: false,
          browserReady: false,
          configurationReady: false
        },
        busy: false,
        ready: true,
        notice: '',
        onRead: () => {}
      })
    )
    expect(markup).toContain('登录条件需要处理或补充')
    expect(markup).toContain('Edge 强制策略：尚未符合登录要求')
    expect(markup).toContain('Edge 进程：仍在运行或无法确认已退出')
    expect(markup).not.toContain('本次配置条件匹配')
  })
  it('presents an external change as blocked and unreadable legacy state as unresolved', () => {
    const report = desktopReadinessFixture()
    report.configurationReady = false
    report.records[0] = {
      source: 'relay',
      state: 'pending',
      phase: 'active',
      decisions: { http: 'blocked', https: 'restoreEligible' }
    }
    report.records[1] = {
      source: 'legacy',
      state: 'unreadable',
      phase: 'unreadable',
      decisions: { http: 'unconfirmed', https: 'unconfirmed' }
    }
    const markup = renderToStaticMarkup(
      createElement(RelayDesktopReadinessPanel, {
        report,
        busy: true,
        ready: true,
        notice: '',
        onRead: () => {}
      })
    )
    expect(markup).toContain('禁止覆盖')
    expect(markup).toContain('不能排除待恢复会话')
    expect(markup).toMatch(/<button disabled=""/)
  })
})
