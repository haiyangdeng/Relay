import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { guardReadinessFixture } from '../../../../main/relay/__fixtures__/guard'
import { RelayGuardReadinessPanel } from './guard-readiness-panel'

describe('Guard readiness presentation', () => {
  it('has a single explicit read action, labels system state unknown and offers no activation', () => {
    const html = renderToStaticMarkup(
      createElement(RelayGuardReadinessPanel, {
        report: guardReadinessFixture(),
        busy: false,
        ready: true,
        notice: '',
        onRead: () => {}
      })
    )
    expect(html).toContain('系统扩展状态：未查询')
    expect(html).toContain('系统过滤配置：未查询')
    expect(html).toContain('实际阻断：未验收')
    expect(html).toContain('未处于 App 包内')
    expect(html.match(/<button/g)).toHaveLength(1)
    expect(html).not.toContain('>已保护<')
  })
  it('does not convert ad-hoc signing into deployment readiness and disables read while busy', () => {
    const report = guardReadinessFixture()
    report.application = {
      ...report.application,
      presence: 'present',
      identity: 'matches',
      signature: 'adHoc'
    }
    const html = renderToStaticMarkup(
      createElement(RelayGuardReadinessPanel, {
        report,
        busy: true,
        ready: true,
        notice: '',
        onRead: () => {}
      })
    )
    expect(html).toContain('本地临时签名')
    expect(html).toContain('不能作为正式保护部署凭证')
    expect(html).toMatch(/<button disabled=""/)
  })
})
