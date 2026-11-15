import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { readOnlyFixture } from '../../../../main/relay/__fixtures__/read-only'
import type { RelayObservation } from '../../../../shared/relay/protocol'
import { externalDiagnosticRecord } from '../../../../shared/relay/diagnostic-evidence'
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
  function owned(): RelayObservation {
    const value = observation()
    value.source = 'relay-owned'
    const guard = value.report.checks.find((row) => row.id === 'guard')
    if (!guard) throw new Error('Missing guard fixture')
    guard.value = '当前安装包未提供系统级防直连组件'
    const record = externalDiagnosticRecord({
      schemaVersion: 1,
      recordedAt: '2026-11-14T02:00:00Z',
      binding: {
        architecture: 'x64',
        appVersion: '1.0.0',
        appBuild: '7',
        coreSHA256: 'a'.repeat(64),
        configurationRevision: 'b'.repeat(64)
      },
      tests: [
        {
          id: 'webrtc',
          testedAt: '2026-11-14T01:00:00Z',
          result: 'noLeakObserved',
          browser: { bundleId: 'com.microsoft.edgemac', version: '100.0', profile: 'edge-default' },
          method: 'ICE probe',
          scope: ['Only Edge default profile'],
          limitations: ['No packet capture'],
          evidenceSHA256: 'c'.repeat(64)
        }
      ]
    })
    value.owned = {
      running: true,
      ports: {
        systemHTTPPort: 18191,
        systemSOCKSPort: 18191,
        codeHTTPPort: 17891,
        dedicatedSOCKSPort: 17890
      },
      binding: record.binding,
      external: { status: 'available', record, bindingMatches: true, browserMatches: [true] }
    }
    return value
  }
  const render = (observation: RelayObservation): string =>
    renderToStaticMarkup(
      createElement(RelayDiagnosticsPanel, { observation, busy: false, onGuardPlan: () => {} })
    )
  it('updates the main card for only the measured browser while preserving pending protocol and scope', () => {
    const value = owned(),
      markup = render(value)
    const main = markup.split('aria-label="外部实测记录"')[0]
    expect(main).toContain('已有实测记录')
    expect(main).toContain('Edge：本次探针未发现泄漏')
    expect(main).not.toContain('专用 Chrome：')
    expect(main).toContain('未提供')
    expect(markup).toContain('No packet capture')
    expect(markup).toContain('本按钮没有重新执行探针')
    expect(markup).toContain('Relay 当前实例（只读）')
    expect(markup).not.toContain('现有 Clash')
    expect(value.report.checks.slice(5).every((check) => check.state === 'pending')).toBe(true)
  })
  it.each(['binding', 'browser'] as const)(
    'keeps %s mismatches historical without updating the main card',
    (kind) => {
      const value = owned()
      if (!value.owned) throw new Error('Missing owned fixture')
      if (kind === 'binding') value.owned.external.bindingMatches = false
      else value.owned.external.browserMatches = [false]
      const markup = render(value),
        main = markup.split('aria-label="外部实测记录"')[0]
      expect(main).not.toContain('已有实测记录')
      expect(markup).toContain('历史 / 绑定未确认')
    }
  )
  it('prioritizes an observed failure over another passing probe and never marks login or account tested', () => {
    const value = owned()
    if (!value.owned?.external.record) throw new Error('Missing evidence fixture')
    const external = value.owned.external
    value.owned.external.record.tests.push({
      ...value.owned.external.record.tests[0],
      result: 'failed'
    })
    external.browserMatches.push(true)
    const markup = render(value),
      main = markup.split('aria-label="外部实测记录"')[0]
    expect(main).toContain('实测发现异常')
    expect(main).not.toContain('>已有实测记录<')
    expect(markup).toContain('登录回调和账号请求本轮未测试')
  })
})
