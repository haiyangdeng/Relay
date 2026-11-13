import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RelayUpdatePanel } from './update-panel'

describe('Trusted resource candidate presentation', () => {
  it('does not check or download on render and never claims a fixed-resource fetch installs an update', () => {
    const onBusy = vi.fn()
    const html = renderToStaticMarkup(createElement(RelayUpdatePanel, { busy: false, onBusy }))
    expect(onBusy).not.toHaveBeenCalled()
    expect(html).toContain('不发现远端最新版本')
    expect(html).toContain('不会把重新下载显示为升级完成')
    expect(html).toContain('下载并校验候选')
    expect(html).not.toContain('准备可信资源获取')
  })
})
