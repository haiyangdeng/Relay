import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RelayProvidersPanel } from './providers-panel'

describe('Provider snapshot controls', () => {
  it('requires an explicit source and distinguishes static snapshots from live providers', () => {
    const onSaved = vi.fn(async () => {}),
      onBusy = vi.fn()
    const html = renderToStaticMarkup(
      createElement(RelayProvidersPanel, { profiles: [], busy: false, onBusy, onSaved })
    )
    expect(onBusy).not.toHaveBeenCalled()
    expect(onSaved).not.toHaveBeenCalled()
    expect(html).toContain('不会读取原Clash缓存路径')
    expect(html).toContain('不运行定时更新／健康检查')
    expect(html).toContain('完整核心兼容性未验证')
    expect(html).toMatch(/<button disabled="">读取提供者及缓存/)
    expect(html).toMatch(/<button disabled="">保存缓存配置副本/)
    expect(html).toMatch(/<button disabled="">取消本次操作/)
  })
})
