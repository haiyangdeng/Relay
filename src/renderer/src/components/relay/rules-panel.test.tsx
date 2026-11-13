import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  defaultEditDocument,
  configurationEditDocument
} from '../../../../shared/relay/configuration-edit'
import {
  patchRule,
  positionedRule,
  rulePatchDocument,
  ruleRows,
  adoptRuleState,
  saveRuleCopy
} from '../../utils/relay-rule-editor'
import RuleItem from '../rules/rule-item'
import type { LocalProxyState } from '../../../../shared/relay/local-proxy'
import type { TunSessionState } from '../../../../shared/relay/tun'
import {
  RelayRulesManager,
  RelayProfileRulesManager,
  RelayRuntimeRulesPanel,
  RelayTunRuntimeRulesPanel
} from './rules-panel'

vi.mock('@renderer/components/proxies/sortable-group', () =>
  vi.importActual('../proxies/sortable-group')
)
vi.mock('@renderer/utils/ipc', () => ({ saveSimpleRules: vi.fn(), mihomoRulesDisable: vi.fn() }))
vi.mock('../base/toast', () => ({ toast: { error: vi.fn() } }))

const profile = {
  id: '00000000-0000-4000-8000-000000000001',
  sha256: 'a'.repeat(64),
  name: 'Saved source',
  createdAt: '2026-11-01',
  summary: { proxies: 0, groups: 0, rules: 1, proxyProviders: 0, ruleProviders: 0 }
}
describe('Relay structured rule editing boundaries', () => {
  it('shows the chosen saved profile as the default rule scope without inventing live state', () => {
    const onBusy = vi.fn()
    const html = renderToStaticMarkup(
      createElement(RelayRulesManager, { busy: false, onBusy, preferredProfile: profile })
    )
    expect(onBusy).not.toHaveBeenCalled()
    expect(html).toContain(`data-relay-saved-rules="${profile.id}"`)
    expect(html).toContain('Saved source · 1 条规则 · 已保存配置')
    expect(html).toContain('筛选保存的规则')
    expect(html).toContain('编辑规则</button>')
    expect(html).toContain('编辑规则与高级设置')
    expect(html).not.toContain('运行规则临时开关')
    expect(html).not.toContain('aria-label="临时启用规则')
  })
  it('keeps the three scopes inert before explicit reads and never mounts a legacy rules provider', () => {
    const onBusy = vi.fn()
    const patch = renderToStaticMarkup(createElement(RelayRulesManager, { busy: false, onBusy })),
      full = renderToStaticMarkup(
        createElement(RelayProfileRulesManager, { profile, busy: false, onBusy })
      ),
      runtime = renderToStaticMarkup(createElement(RelayRuntimeRulesPanel, { busy: false, onBusy }))
    expect(onBusy).not.toHaveBeenCalled()
    expect(patch).toContain('完整规则另存副本、规则补丁、运行临时开关是三种独立操作')
    expect(patch).not.toContain('保存所选范围规则补丁')
    expect(full).toContain('读取完整规则草稿')
    expect(full).toContain('不自动选择或启用副本')
    expect(full).not.toContain('检查完整规则并准备新副本')
    expect(runtime).toContain('重新载入配置后恢复')
    expect(runtime).not.toContain('临时启用规则 1')
  })
  it('gives duplicate rows independent identities without normalizing an unknown or complex original', () => {
    const raw = ' AND,((DOMAIN,a.invalid),(DOMAIN,b.invalid)),PROXY,no-resolve,src '
    const rows = ruleRows([raw, raw])
    expect(rows.map((row) => row.value)).toEqual([raw, raw])
    expect(rows[0].key).not.toBe(rows[1].key)
    expect(positionedRule(raw, '', raw)).toBe(raw)
  })
  it('keeps TUN rules inert and allows stable TUN reads independently from the persistent edit gate without an HTTP port', () => {
    const onBusy = vi.fn(),
      state: TunSessionState = {
        phase: 'active',
        pending: false,
        owned: true,
        sessionId: profile.id,
        traffic: 'forwarding',
        restorationVerified: false,
        protectionVerified: false,
        warnings: []
      },
      html = renderToStaticMarkup(
        createElement(RelayRulesManager, {
          busy: true,
          runtimeBusy: false,
          tunState: state,
          onBusy
        })
      )
    expect(onBusy).not.toHaveBeenCalled()
    expect(html).toContain('<button>读取当前TUN运行规则</button>')
    expect(html).toContain('不需要HTTP代理端口')
    expect(html).not.toContain('TUN运行规则筛选')
    const pending = renderToStaticMarkup(
      createElement(RelayTunRuntimeRulesPanel, {
        busy: false,
        onBusy,
        state: { ...state, pending: true }
      })
    )
    expect(pending).toContain('<button disabled="">读取当前TUN运行规则</button>')
    const unknown = renderToStaticMarkup(
      createElement(RelayTunRuntimeRulesPanel, { busy: false, onBusy, state, unconfirmed: true })
    )
    expect(unknown).toContain('<button disabled="">读取当前TUN运行规则</button>')
    expect(unknown).not.toContain('TUN运行规则筛选')
  })
  it('preserves untouched signed position prefixes and complex inner commas while validating new positions', () => {
    const raw = ' -2 ,AND,((DOMAIN,a.invalid),(DOMAIN,b.invalid)),PROXY,no-resolve',
      parsed = patchRule(raw)
    expect(parsed.position).toBe(' -2 ')
    expect(parsed.rule).toBe('AND,((DOMAIN,a.invalid),(DOMAIN,b.invalid)),PROXY,no-resolve')
    expect(positionedRule(parsed.rule, parsed.position, raw)).toBe(raw)
    expect(positionedRule('MATCH,REJECT', '0')).toBe('0,MATCH,REJECT')
    for (const value of ['1.5', '-1', '+1', '9007199254740992'])
      expect(() => positionedRule('MATCH,REJECT', value)).toThrow()
  })
  it('changes one patch scope while retaining every other scope, rule order and unrelated field', () => {
    const second = '00000000-0000-4000-8000-000000000002',
      base = configurationEditDocument({
        ...defaultEditDocument(),
        rulePatch: { prepend: ['MATCH,DIRECT'] },
        profileRulePatchSets: [
          { profileId: profile.id, rulePatch: { append: ['MATCH,REJECT'] } },
          { profileId: second, rulePatch: { delete: ['DOMAIN,b.invalid,DIRECT'] } }
        ],
        controlDns: false,
        controlSniff: false,
        confirmedDnsFingerprint: 'c'.repeat(64),
        overrideLibraryOrder: [profile.id],
        controlled: { dns: { enable: false }, sniffer: { enable: false }, ipv6: false }
      })
    const next = rulePatchDocument(base, profile.id, {
      delete: ['DOMAIN,a.invalid,DIRECT', 'DOMAIN,a.invalid,DIRECT']
    })
    expect(next.profileRulePatchSets?.[0].rulePatch.delete).toHaveLength(2)
    expect(next.profileRulePatchSets?.[1]).toEqual(base.profileRulePatchSets?.[1])
    expect({ ...next, profileRulePatchSets: base.profileRulePatchSets }).toEqual(base)
    expect(base.profileRulePatchSets?.[0].rulePatch).toEqual({ append: ['MATCH,REJECT'] })
    const global = rulePatchDocument(base, undefined, { append: ['0,MATCH,REJECT'] })
    expect({ ...global, rulePatch: base.rulePatch }).toEqual(base)
  })
  it('applies a rules reply only while the parent functional updater still observes the RPC owner', () => {
    const owner = { instanceId: profile.id, configurationRevision: 'a'.repeat(64) },
      current: LocalProxyState = {
        phase: 'running',
        pending: false,
        owned: true,
        hasRecord: true,
        uncertain: false,
        ...owner,
        traffic: 'listening',
        groups: [],
        systemProxyChanged: false,
        liveGuardEnabled: false,
        warnings: []
      },
      next = { ...current, warnings: ['confirmed rule table'] },
      replacement = {
        ...current,
        instanceId: '00000000-0000-4000-8000-000000000002',
        configurationRevision: 'b'.repeat(64)
      }
    expect(adoptRuleState(current, next, current)).toBe(next)
    expect(adoptRuleState(replacement, next, current)).toBe(replacement)
    const modeObservation: LocalProxyState = { ...current, mode: 'global' }
    expect(adoptRuleState(modeObservation, next, current)).toBe(modeObservation)
    const failed = { ...current, owned: false }
    expect(adoptRuleState(failed, next, failed)).toBe(failed)
  })
})

describe('rule copy and runtime statistics', () => {
  it('pins the draft before preparing and saves only the returned evidence, preserving native cancellation', async () => {
    let prepared!: (value: unknown) => void
    const gate = new Promise((resolve) => {
      prepared = resolve
    })
    const invoke = vi
      .fn<(channel: string, request: unknown) => Promise<unknown>>()
      .mockImplementationOnce(() => gate)
      .mockResolvedValueOnce({ status: 'cancelled' })
    const target = { id: profile.id, sha256: profile.sha256 }
    const rules = ['DOMAIN,a.invalid,DIRECT']
    const pending = saveRuleCopy(invoke, target, rules, vi.fn())
    rules[0] = 'MATCH,REJECT'
    target.sha256 = 'b'.repeat(64)
    expect(invoke.mock.calls).toEqual([
      [
        'relayProfileRulesPrepare',
        {
          profile: { id: profile.id, sha256: profile.sha256 },
          rules: ['DOMAIN,a.invalid,DIRECT']
        }
      ]
    ])
    prepared({ evidenceId: 'prepared-proof' })
    expect(await pending).toEqual({ status: 'cancelled' })
    expect(invoke.mock.calls[1]).toEqual(['relayProfileSave', { evidenceId: 'prepared-proof' }])
    expect(invoke).toHaveBeenCalledTimes(2)
  })
  it('does not save after a failed check or an invalidated page and never retries a failed save', async () => {
    const target = { id: profile.id, sha256: profile.sha256 }
    const prepareFailure = vi.fn().mockRejectedValueOnce(new Error('bad rule'))
    await expect(saveRuleCopy(prepareFailure, target, [], vi.fn())).rejects.toThrow('bad rule')
    expect(prepareFailure).toHaveBeenCalledTimes(1)
    const stale = vi.fn().mockResolvedValueOnce({ evidenceId: 'old-proof' })
    const check = vi
      .fn()
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('page changed')
      })
    await expect(saveRuleCopy(stale, target, [], check)).rejects.toThrow('page changed')
    expect(stale).toHaveBeenCalledTimes(1)
    const saveFailure = vi
      .fn()
      .mockResolvedValueOnce({ evidenceId: 'proof' })
      .mockRejectedValueOnce(new Error('unknown receipt'))
    await expect(saveRuleCopy(saveFailure, target, [], vi.fn())).rejects.toThrow('unknown receipt')
    expect(saveFailure).toHaveBeenCalledTimes(2)
  })
  it('shows returned counters alongside the Relay switch and omits unknown statistics', () => {
    const props = {
      index: 0,
      type: 'DomainSuffix',
      payload: 'example.invalid',
      proxy: 'PROXY',
      size: -1,
      runtimeToggle: { disabled: false, locked: true, onChange: vi.fn() }
    }
    const known = renderToStaticMarkup(
      createElement(RuleItem, {
        ...props,
        runtimeStatistics: { hitCount: 3, missCount: 9, hitAt: '2026-11-09T00:00:00.000Z' }
      })
    )
    expect(known).toContain('data-rule-statistics="true"')
    expect(known).toContain('3/12')
    expect(known).toContain('25.0%')
    expect(known).toContain('临时启用规则 1')
    const missing = renderToStaticMarkup(createElement(RuleItem, props))
    expect(missing).not.toContain('data-rule-statistics')
    expect(missing).not.toContain('0.0%')
  })
})
