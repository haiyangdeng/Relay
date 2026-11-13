import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { RelayProfilePreparation } from '../../../../shared/relay/profiles'
import { RuleProviderDefinitionList } from '../resources/rule-provider-definition-list'
import { RelayProfilesPanel } from './profiles-panel'
import { RelayProfileRuleEditor } from './profile-rule-editor'

vi.mock('./rules-panel', () => ({ RelayProfileRulesManager: () => null }))
vi.mock('@renderer/utils/ipc', () => ({ saveSimpleRuleProvider: vi.fn() }))

describe('Inactive profile presentation and import gate', () => {
  it('keeps structured provider drafts unread and unsavable until explicit source read', () => {
    const html = renderToStaticMarkup(
      createElement(RelayProfileRuleEditor, {
        profile: {
          id: '00000000-0000-4000-8000-000000000001',
          sha256: 'a'.repeat(64),
          name: 'Source',
          createdAt: '2026-11-02',
          summary: { proxies: 0, groups: 0, rules: 0, proxyProviders: 0, ruleProviders: 0 }
        },
        providers: true,
        busy: false,
        onBusy: vi.fn()
      })
    )
    expect(html).toContain('读取规则提供者草稿')
    expect(html).not.toContain('新增规则提供者草稿')
    expect(html).toContain('不访问所填URL或路径')
    expect(html).not.toContain('>保存规则提供者到配置副本</button>')
    expect(html).not.toContain('单独确认另存')
  })
  it('renders the passive definition list without inventing active provider counts or exposing source secrets', () => {
    const html = renderToStaticMarkup(
      createElement(RuleProviderDefinitionList, {
        definitions: {
          Saved: {
            type: 'http',
            behavior: 'domain',
            format: 'mrs',
            url: 'https://PRIVATE/SECRET',
            header: { Secret: ['TOKEN'] }
          }
        },
        filter: '',
        locked: true,
        onFilter: vi.fn(),
        onEdit: vi.fn(),
        onRemove: async () => {}
      })
    )
    expect(html).toContain('Saved')
    expect(html).toContain('不是活动数量')
    expect(html).not.toContain('PRIVATE')
    expect(html).not.toContain('TOKEN')
  })
  it('does not offer save before checks and never claims core compatibility or activation', () => {
    const html = renderToStaticMarkup(
      createElement(RelayProfilesPanel, {
        busy: false,
        notice: '',
        onPrepare: () => {},
        onSave: () => {},
        onList: () => {}
      })
    )
    expect(html).toContain('导入本地配置…')
    expect(html).not.toContain('确认并保存副本')
    expect(html).toContain('不下载订阅或提供者')
    expect(html).not.toContain('已启用')
  })
  it('separates structure success from engine acceptance and preserves unknown-record warnings', () => {
    const preparation: RelayProfilePreparation = {
      evidenceId: 'sample',
      name: 'Local.yaml',
      sha256: 'a'.repeat(64),
      bytes: 42,
      inspection: {
        structure: 'passed',
        active: false,
        coreCompatibility: 'notVerified',
        issues: [],
        summary: { proxies: 1, groups: 1, rules: 1, proxyProviders: 0, ruleProviders: 0 }
      }
    }
    const html = renderToStaticMarkup(
      createElement(RelayProfilesPanel, {
        preparation,
        busy: true,
        notice: '',
        inventory: {
          profiles: [],
          activeId: null,
          incomplete: 1,
          warnings: ['Unknown record preserved']
        },
        onPrepare: () => {},
        onSave: () => {},
        onList: () => {}
      })
    )
    expect(html).toContain('结构检查通过')
    expect(html).toContain('核心兼容性未验证')
    expect(html).toContain('当前没有已确认的运行配置')
    expect(html).toContain('Unknown record preserved')
    expect(
      (html.match(/<button[^>]*>/gu) ?? []).every((button) => button.includes('disabled=""'))
    ).toBe(true)
  })
})
