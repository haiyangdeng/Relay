import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RelayPluginsPanel } from './plugins-panel'

describe('Plugin installation remains an explicit permission workflow', () => {
  it('does not install, log in or register a network request during render', () => {
    const onBusy = vi.fn(),
      html = renderToStaticMarkup(createElement(RelayPluginsPanel, { busy: false, onBusy }))
    expect(onBusy).not.toHaveBeenCalled()
    expect(html).toMatch(/<button disabled="">安装插件/)
    expect(html).toMatch(/<button disabled="">取消本次插件操作/)
    expect(html).toContain('尚无有效插件状态')
    expect(html).toContain('仅移除本地插件不会撤销服务商端设备')
    expect(html).toContain('可手动重新发现网关，保留旧订阅')
    expect(html).toContain('不跨路由自动重放')
    expect(html).toContain('调度默认关闭')
    expect(html).toContain('公开CPX描述HTTPS地址')
    expect(html).toContain('选择本地CPX描述文件')
    expect(html).toMatch(/<button disabled="">读取公开描述…/)
    expect(html).toContain('本次运行自动更新周期')
    expect(html).toContain('value="60"')
    expect(html).toContain('不会在打开面板时联网或恢复旧授权')
  })
})
