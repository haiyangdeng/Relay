import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RelaySmartToolsPanel } from './smart-tools-panel'
describe('Smart tools explicit user entry', () => {
  it('offers no clear or read authority without a confirmed current instance', () => {
    const html = renderToStaticMarkup(createElement(RelaySmartToolsPanel, {}))
    expect(html).toContain('启动固定Smart实例后可使用这些工具')
    expect(html).toMatch(/<button type="button" disabled="">清除统计缓存…/)
    expect(html).toMatch(/<button type="button" disabled="">读取学习排名/)
    expect(html).toContain('点击清除后执行')
  })
  it('requires manual status refresh even for an owned instance; does not label ranking as health', () => {
    const html = renderToStaticMarkup(
      createElement(RelaySmartToolsPanel, {
        ordinaryInstanceId: '11111111-1111-4111-8111-111111111111'
      })
    )
    expect(html).toMatch(/<button type="button">刷新工具状态/)
    expect(html).toMatch(/<button type="button" disabled="">清除统计缓存…/)
    expect(html).not.toContain('延迟')
    expect(html).not.toContain('已持久化')
  })
})
