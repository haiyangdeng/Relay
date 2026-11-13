import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RelayVariantsPanel } from './variants-panel'

describe('Variant resource UI scope', () => {
  it('requires an explicit inventory/metadata and file picker before copying and does not claim that selecting resources starts a runtime', () => {
    const onBusy = vi.fn()
    const html = renderToStaticMarkup(createElement(RelayVariantsPanel, { busy: false, onBusy }))
    expect(onBusy).not.toHaveBeenCalled()
    expect(html).toMatch(/<button disabled="">导入资源文件…/)
    expect(html).not.toContain('确认复制并校验')
    expect(html).toContain('先导入并选择固定可信模型')
    expect(html).toContain('运行中的实例不会自动切换')
    expect(html).not.toContain('sourcePath')
    expect(html).toContain('可信核心版本')
    expect(html).toContain('请先读取可信清单')
  })
})
