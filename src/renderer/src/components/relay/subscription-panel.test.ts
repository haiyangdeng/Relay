import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { RelayProfilePreparation } from '../../../../shared/relay/profiles'
import { RelaySubscriptionPanel } from './subscription-panel'

const props = {
  name: 'Fixture',
  url: '',
  proxyPort: 18191,
  busy: false,
  notice: '',
  onName: () => {},
  onURL: () => {},
  onPort: () => {},
  onPrepare: vi.fn(),
  onDownload: vi.fn(),
  onSave: vi.fn(),
  onCancel: () => {}
}
const profile: RelayProfilePreparation = {
  evidenceId: 'fixture',
  name: 'Fixture',
  sha256: 'a'.repeat(64),
  bytes: 100,
  inspection: { structure: 'passed', coreCompatibility: 'notVerified', active: false, issues: [] }
}
describe('Subscription snapshot controls and scope', () => {
  it('does not download on render or offer unprepared download/save and explains the route and update limits', () => {
    const html = renderToStaticMarkup(createElement(RelaySubscriptionPanel, props))
    expect(props.onDownload).not.toHaveBeenCalled()
    expect(html).toMatch(/type="password"/)
    expect(html).toMatch(/<button disabled="">下载并导入订阅/)
    expect(html).not.toContain('确认并保存订阅副本')
    expect(html).toContain('不自动回退直连')
    expect(html).toContain('不定时更新')
    expect(html).toContain('不加载提供者')
  })
  it('keeps cancellation available during download but does not cancel an in-progress private write', () => {
    for (const phase of ['downloading', 'saving'] as const) {
      const html = renderToStaticMarkup(
        createElement(RelaySubscriptionPanel, {
          ...props,
          busy: true,
          state: { phase, pending: true, operationId: 'fixture' }
        })
      )
      expect(html).toMatch(
        phase === 'saving' ? /<button disabled="">取消本次请求/ : /<button>取消本次请求/
      )
    }
  })
  it('never offers a stale staged result as savable and separates structure from core acceptance', () => {
    const html = renderToStaticMarkup(
      createElement(RelaySubscriptionPanel, {
        ...props,
        preparation: {
          evidenceId: 'expired',
          name: 'Fixture',
          origin: 'https://example.invalid',
          proxyPort: 18191
        },
        profile,
        state: { phase: 'idle', pending: false }
      })
    )
    expect(html).not.toContain('确认并保存订阅副本')
    expect(html).toMatch(/<button disabled="">下载并导入订阅/)
    expect(html).toContain('核心兼容性未验证，未启用')
  })
})
