import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { readOnlyFixture } from '../../../../main/relay/__fixtures__/read-only'
import type { RelayObservation } from '../../../../shared/relay/protocol'
import { RelayDiagnosticsPanel } from './diagnostics-panel'

describe('Read-only diagnostics presentation', () => {
  function observation(): RelayObservation {
    return {
      evidenceId: 'fixture',
      source: 'legacy-readonly',
      parameters: { httpPort: 7890, node: 'fixture-node', internalExceptions: '' },
      report: readOnlyFixture()
    }
  }
  it('separates five configuration checks from six pending runtime checks and never changes timezone', () => {
    const markup = renderToStaticMarkup(
      createElement(RelayDiagnosticsPanel, {
        observation: observation(),
        busy: false,
        onGuardPlan: () => {
          throw new Error('must not run during render')
        }
      })
    )
    expect(markup.match(/<article>/g)).toHaveLength(11)
    expect(markup.match(/>待验证<\/span>/g)).toHaveLength(6)
    expect(markup).toContain('时区：Asia/Taipei')
    expect(markup).toContain('不调整系统设置')
    expect(markup).toContain('现有 Clash（只读）')
    expect(markup).not.toContain('已保护')
    expect(markup).toContain('fixture-node')
    expect(markup).not.toContain('>group</option>')
  })
  it('has no guard-plan selector without connected core evidence', () => {
    const value = observation()
    value.report.snapshot.controllerConnected = false
    const markup = renderToStaticMarkup(
      createElement(RelayDiagnosticsPanel, {
        observation: value,
        busy: false,
        onGuardPlan: () => {}
      })
    )
    expect(markup).not.toContain('<select')
    expect(markup).toContain('不能生成部署方案')
  })
})
