import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type {
  RelayRuntimePreparation,
  RelayRuntimeCheckResult
} from '../../../../shared/relay/runtime'
import { RelayRuntimePanel } from './runtime-panel'

const preparation: RelayRuntimePreparation = {
  evidenceId: 'fixture',
  profile: {
    id: 'fixture',
    name: 'Local',
    sha256: 'a'.repeat(64),
    createdAt: '2026-10-24',
    summary: { proxies: 1, groups: 1, rules: 1, proxyProviders: 0, ruleProviders: 0 }
  },
  catalogue: {
    nodes: [{ name: 'Node', type: 'ss' }],
    groups: [{ name: 'Group', type: 'select', members: ['Node'], providers: [], dynamic: false }],
    proxyProviders: [],
    ruleProviders: [],
    truncated: true
  },
  scope: 'isolated-projection',
  canValidate: true,
  fullSourceVerified: false,
  active: false,
  excluded: ['DNS not checked'],
  issues: []
}
describe('Declaration and scoped core-check presentation', () => {
  it('labels source declarations, truncation and unverified complete config independently of check success', () => {
    const checked: RelayRuntimeCheckResult = {
      status: 'passed',
      scope: 'isolated-projection',
      fullSourceVerified: false,
      active: false,
      runtimeSHA256: 'a'.repeat(64),
      warnings: ['Connectivity not verified']
    }
    const html = renderToStaticMarkup(
      createElement(RelayRuntimePanel, {
        preparation,
        checked,
        busy: false,
        notice: '',
        onCheck: () => {}
      })
    )
    expect(html).toContain('隔离投影校验通过')
    expect(html).toContain('完整原配置兼容性未验证')
    expect(html).toContain('不代表实际节点状态')
    expect(html).toContain('本次显示已截断')
    expect(html).toContain('Connectivity not verified')
    expect(html).toMatch(/<button disabled=""/)
  })
  it('does not offer unprepared or blocked checks', () => {
    const html = renderToStaticMarkup(
      createElement(RelayRuntimePanel, { busy: false, notice: '', onCheck: () => {} })
    )
    expect(html).toMatch(/<button disabled=""/)
    const blocked = renderToStaticMarkup(
      createElement(RelayRuntimePanel, {
        preparation: {
          ...preparation,
          canValidate: false,
          issues: ['Unsupported options retained']
        },
        busy: false,
        notice: '',
        onCheck: () => {}
      })
    )
    expect(blocked).toMatch(/<button disabled=""/)
    expect(blocked).toContain('Unsupported options retained')
  })
})
