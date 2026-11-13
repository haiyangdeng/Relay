import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RelayDedicatedListenersPanel } from './dedicated-listeners-panel'
import { RelayAiClientsPanel } from './ai-clients-panel'

describe('dedicated listener entry points', () => {
  it('leaves dedicated listeners disabled by default and supports a SOCKS-only draft', () => {
    const props = { disabled: false, defaultRoute: '节点', onChange: () => {} }
    const initial = renderToStaticMarkup(createElement(RelayDedicatedListenersPanel, props))
    expect(initial).not.toContain('checked=""')
    const socks = renderToStaticMarkup(
      createElement(RelayDedicatedListenersPanel, {
        ...props,
        disabled: true,
        plan: { socksPort: 17890, route: '节点' }
      })
    )
    expect(socks).toContain('<fieldset disabled="">')
    expect(socks).toContain('value="17890"')
    expect(socks).toContain('value="节点"')
  })
  it('requires an explicit association check instead of showing a saved success on mount', () => {
    const markup = renderToStaticMarkup(
      createElement(RelayAiClientsPanel, {
        claudeCodePort: 17891,
        busy: false,
        onBusy: () => {},
        onAssociate: () => {}
      })
    )
    expect(markup).toContain('检查本次监听与客户端关联')
    expect(markup).not.toContain('已确认属于本次实例')
    expect(markup).not.toContain('将专用HTTP入口填入Code草稿')
  })
})
