import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RelayConfigurationEditPanel } from './configuration-edit-panel'

describe('Persisted configuration editor', () => {
  it('requires explicit reads and saving, and keeps parser acceptance separate from runtime application', () => {
    const onBusy = vi.fn()
    const html = renderToStaticMarkup(
      createElement(RelayConfigurationEditPanel, { busy: false, onBusy })
    )
    expect(onBusy).not.toHaveBeenCalled()
    expect(html).toContain('读取保存的编辑与来源')
    expect(html).toContain('确认热载')
    expect(html).toContain('检查已保存的编辑')
    expect(html).toContain('外部资源可在下方绑定私有缓存')
    expect(html).toContain('profileOverrideSets按来源保存多组配置级覆写')
    expect(html).toContain('从草稿读入此来源覆写')
    expect(html).toContain('将此来源覆写写入草稿')
    expect(html).toContain('从草稿移除此来源覆写')
    expect(html).toContain('切换来源会清空尚未写入')
    expect(html).toContain('保存和清除绑定最近读取的版本')
    expect(html).toMatch(/<button disabled="">保存编辑/)
    expect(html).toMatch(/<button disabled="">将此来源覆写写入草稿/)
    expect(html).toMatch(/<button disabled="">清除保存的编辑/)
    expect(html).toMatch(/<button disabled="">预览合并顺序与DNS状态/)
    expect(html).toMatch(/<button disabled="">检查这份完整候选/)
  })
})
