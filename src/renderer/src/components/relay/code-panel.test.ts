import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { codeFixture } from '../../../../main/relay/__fixtures__/code'
import { preferenceFixture } from '../../../../main/relay/__fixtures__/preferences'
import { RelayCodePanel } from './code-panel'

describe('Joint Code configuration presentation', () => {
  it('separates the actual file preparation from the JSON draft and prepares and applies from a single action', () => {
    const markup = renderToStaticMarkup(
      createElement(RelayCodePanel, {
        notice: '',
        busy: false,
        ready: true,
        onPrepare: () => {},
        onApply: () => {},
        onOpen: () => {}
      })
    )
    expect(markup).toContain('JSON 草稿不写入实际设置')
    expect(markup).toMatch(/<button>备份并配置<\/button>/)
    expect(markup).toContain('入口随 Relay 打包，使用本次 Relay 已核实的专用 HTTP')
    expect(markup).toContain('仅复用代理与资料状态匹配的窗口')
    expect(markup).toContain('修改浏览器配置前需退出该专用资料')
  })
  it('shows missing helper and active browser instead of a ready configuration', () => {
    const preparation = {
      ...codeFixture(),
      evidenceId: 'a'.repeat(36),
      parameters: preferenceFixture().preferences,
      helperReady: false,
      canApply: false,
      browserState: 'running' as const
    }
    const markup = renderToStaticMarkup(
      createElement(RelayCodePanel, {
        preparation,
        notice: '',
        busy: false,
        ready: true,
        onPrepare: () => {},
        onApply: () => {},
        onOpen: () => {}
      })
    )
    expect(markup).toContain('资源缺失，不能配置')
    expect(markup).toContain('仍在运行，请先退出该资料')
    expect(markup).toMatch(/<button>备份并配置<\/button>/)
  })
})
