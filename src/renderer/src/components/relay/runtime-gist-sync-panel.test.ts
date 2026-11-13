import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { RelayRuntimeGistSourcePicker } from './runtime-gist-source'
import { RelayRuntimeGistSyncPanel } from './runtime-gist-sync-panel'

describe('session runtime Gist automatic sync UI', () => {
  it('keeps an unavailable selected TUN session visible instead of selecting a local fallback', () => {
    const onChange = vi.fn(),
      sessionId = '11111111-1111-4111-8111-111111111111'
    const html = renderToStaticMarkup(
      createElement(RelayRuntimeGistSourcePicker, {
        label: '来源',
        source: { kind: 'tun-managed', sessionId },
        onChange
      })
    )
    expect(html).toContain('所选会话已失效')
    expect(html).toContain('不是核心内存全量导出')
    expect(html).toMatch(/value="tun-managed" disabled="" selected=""/)
    expect(onChange).not.toHaveBeenCalled()
  })

  it('renders inertly and explains authorization, source and remote overwrite limits', () => {
    const onBusy = vi.fn(),
      html = renderToStaticMarkup(createElement(RelayRuntimeGistSyncPanel, { busy: false, onBusy }))
    expect(onBusy).not.toHaveBeenCalled()
    for (const text of [
      '默认关闭，保存账号不等于授权',
      '点击开启后绑定',
      '显式选择支持读取的托管TUN会话',
      '不创建或自动发现Gist',
      '并发覆盖的窗口',
      '不自动恢复',
      '不会停止代理核心或改变网络设置',
      '初始渲染不会自动联网、解密凭据或开启同步'
    ])
      expect(html).toContain(text)
    expect(html).not.toContain('type="password"')
    expect(html).toMatch(/<button disabled="">授权本次会话运行配置自动同步/)
    expect(html).not.toContain('最近已捕获配置')
  })
})
