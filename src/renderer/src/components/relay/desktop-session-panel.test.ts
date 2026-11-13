import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { desktopSnapshot } from '../../../../main/relay/__fixtures__/desktop-session'
import { RelayDesktopSessionPanel } from './desktop-session-panel'

describe('Desktop session control presentation', () => {
  it('keeps cancel usable while waiting on a setter and never claims account login success', () => {
    const markup = renderToStaticMarkup(
      createElement(RelayDesktopSessionPanel, {
        state: {
          host: 'running',
          pending: true,
          uncertain: false,
          snapshot: desktopSnapshot('starting')
        },
        notice: '',
        busy: true,
        ready: true,
        onAction: () => {}
      })
    )
    expect(markup).toContain('<button>取消并恢复</button>')
    expect(markup).toContain('等待在途回调')
    expect(markup).not.toContain('已登录成功')
    expect(markup).toContain('直接使用本机安装的 Microsoft Edge')
    expect(markup).toContain('SOCKS 127.0.0.1:17890')
    expect(markup).toContain('当前 Relay 的固定节点专用监听持有')
    expect(markup).toContain('监听不能替代此专用监听')
    expect(markup).toContain('不会自动迁移端口')
    expect(markup).toContain('未登录微软账号的专用 Edge 资料')
    expect(markup).toContain('策略作用于当前用户全部 Edge 资料')
    expect(markup).not.toContain('Chrome')
  })
  it('separates recovery consent from cancellation or close and shows uncertainty', () => {
    const snapshot = desktopSnapshot('recoveryNeeded')
    snapshot.requiresRecoveryConsent = true
    const markup = renderToStaticMarkup(
      createElement(RelayDesktopSessionPanel, {
        state: { host: 'running', pending: false, uncertain: true, snapshot },
        notice: '',
        busy: false,
        ready: true,
        onAction: () => {}
      })
    )
    expect(markup).toContain('<button disabled="">取消并恢复</button>')
    expect(markup).toContain('<button>确认恢复记录…</button>')
    expect(markup).toContain('取消或关闭不能代替授权')
    expect(markup).toContain('未自动重试切换')
  })
})
