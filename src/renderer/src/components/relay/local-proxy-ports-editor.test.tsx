import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RelayLocalProxyPortsEditor } from './local-proxy-ports-editor'

describe('ordinary listener settings and live state', () => {
  it('shows four editable startup ports separately from the still-running listeners', () => {
    const html = renderToStaticMarkup(
      createElement(RelayLocalProxyPortsEditor, {
        ports: { http: 0, mixed: 19234, socks: 19235, redir: 19236 },
        livePorts: { http: 18191, mixed: 0, socks: 0, redir: 0 },
        disabled: false,
        onChange: () => {}
      })
    )
    for (const label of ['HTTP 端口', '混合端口', 'SOCKS 端口', 'Redir 端口']) {
      expect(html).toContain(`aria-label="本地 ${label}"`)
      expect(html).toContain(`aria-label="启用${label}"`)
    }
    expect(html).toContain('value="19234"')
    expect(html).toContain('HTTP 端口 18191')
    expect(html).toContain('混合端口 关闭')
    expect(html).toContain('下次核心启动时生效')
    expect(html).toContain('不会自动配置系统流量重定向')
  })
  it('never describes a saved but stopped listener as currently running', () => {
    const html = renderToStaticMarkup(
      createElement(RelayLocalProxyPortsEditor, {
        ports: { http: 18191, mixed: 19234, socks: 19235, redir: 0 },
        disabled: true,
        onChange: () => {}
      })
    )
    expect(html).not.toContain('当前实际监听')
  })
})
