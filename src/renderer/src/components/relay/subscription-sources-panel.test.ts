import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RelaySubscriptionSourcesPanel } from './subscription-sources-panel'

describe('Private subscription source controls', () => {
  it('does no IO on render, explains credential storage and requires preparation for mutation', () => {
    const onBusy = vi.fn(),
      onSaved = vi.fn(async () => {}),
      html = renderToStaticMarkup(
        createElement(RelaySubscriptionSourcesPanel, { busy: false, onBusy, onSaved })
      )
    expect(onBusy).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
    expect(html).toContain('未加密')
    expect(html).toContain('不覆盖旧文件')
    expect(html).toContain('不改变正在使用的配置')
    expect(html).toContain('type="password"')
    expect(html).toContain('高级订阅选项')
    expect(html).toContain('重启后不自动恢复')
    expect(html).toMatch(/<button disabled="">启用本次运行调度/)
    expect(html).not.toContain('确认本次来源操作')
    expect(html).toMatch(/<button disabled="">手动更新/)
    expect(html).toMatch(/<button disabled="">使用历史版本/)
  })
})
