import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RelaySubStorePanel } from './substore-panel'

describe('Sub-Store explicit startup and conversion UI', () => {
  it('requires verified resources before startup and a new conversion before saving', () => {
    const onBusy = vi.fn(),
      html = renderToStaticMarkup(createElement(RelaySubStorePanel, { busy: false, onBusy }))
    expect(onBusy).not.toHaveBeenCalled()
    expect(html).toMatch(/<button disabled="">启动本次Sub-Store/)
    expect(html).toMatch(/<button disabled="">打开隔离管理窗口/)
    expect(html).toMatch(/<button disabled="">转换并保存配置/)
    expect(html).toContain('不自动切换或热载')
  })
})
