import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  checkedRuleProvidersSnapshot,
  replaceQueuedRuleProviders
} from '../../hooks/use-relay-active-rule-providers'
import type { ResourceInfo } from '../../../../shared/relay/resources'
import { RelayActiveRuleProvidersPanel } from './active-rule-providers-panel'

const owner = '11111111-1111-4111-8111-111111111111'
const fixture = () => ({
  status: 'snapshot',
  sessionId: owner,
  snapshot: {
    sessionId: owner,
    configurationRevision: 'a'.repeat(64),
    generationSHA256: 'b'.repeat(64),
    providers: ['First', 'Alias'].map((name) => ({
      name,
      kind: 'rule-yaml',
      behavior: 'domain',
      fileSHA256: 'c'.repeat(64),
      bytes: 20,
      ruleCount: 2
    })),
    groups: [['First', 'Alias']]
  }
})
describe('Explicit active rule-provider file receipts', () => {
  it('renders actual passive controls without an initial RPC, first selection or Native authority', () => {
    const busy = vi.fn(),
      html = renderToStaticMarkup(
        createElement(RelayActiveRuleProvidersPanel, {
          busy: false,
          onBusy: busy,
          tunSessionId: owner
        })
      )
    expect(busy).not.toHaveBeenCalled()
    expect(html).toContain('读取当前提供者回执')
    expect(html).toContain('读取规则缓存摘要')
    expect(html).toContain('未默认选中首项')
    expect(html).toContain('可能改变新连接的规则匹配')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('127.0.0.1')
  })
  it('leaves an absent or foreign-busy owner read-only', () => {
    for (const props of [
      { busy: true, tunSessionId: owner },
      { busy: false, tunSessionId: undefined }
    ]) {
      const html = renderToStaticMarkup(
        createElement(RelayActiveRuleProvidersPanel, { ...props, onBusy: vi.fn() })
      )
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>读取当前提供者回执/)
    }
  })
  it('accepts compact groups and copies the observed snapshot independently', () => {
    const input = fixture(),
      result = checkedRuleProvidersSnapshot(input, owner)
    input.snapshot.groups[0][0] = 'changed'
    input.snapshot.providers[0].fileSHA256 = 'd'.repeat(64)
    expect(result.groups).toEqual([['First', 'Alias']])
    expect(result.providers[0].fileSHA256).toBe('c'.repeat(64))
  })
  it.each(['duplicate', 'missing', 'unknown', 'empty'] as const)(
    'rejects %s name partitions without manufacturing an alias group',
    (kind) => {
      const input = fixture()
      input.snapshot.groups =
        kind === 'duplicate'
          ? [['First', 'Alias'], ['First']]
          : kind === 'missing'
            ? [['First']]
            : kind === 'unknown'
              ? [['First', 'Alias', 'Other']]
              : [[]]
      expect(() => checkedRuleProvidersSnapshot(input, owner)).toThrow()
    }
  )
  it('rejects mismatched owner and malformed fields before an ACK can become usable', () => {
    for (const change of [
      (input: ReturnType<typeof fixture>) => {
        input.sessionId = owner.replace('1111', '2222')
      },
      (input: ReturnType<typeof fixture>) => {
        input.snapshot.configurationRevision = 'PRIVATE'
      },
      (input: ReturnType<typeof fixture>) => {
        input.snapshot.providers[0].bytes = -1
      },
      (input: ReturnType<typeof fixture>) => {
        input.snapshot.providers[0].ruleCount = NaN
      },
      (input: ReturnType<typeof fixture>) => {
        input.snapshot.providers[0].name = 'bad,name'
      },
      (input: ReturnType<typeof fixture>) => {
        input.snapshot.providers.push(input.snapshot.providers[0])
      }
    ]) {
      const input = fixture()
      change(input)
      expect(() => checkedRuleProvidersSnapshot(input, owner)).toThrow()
    }
  })

  it('rejects an alias twice before sending any active replacement', async () => {
    const snapshot = checkedRuleProvidersSnapshot(fixture(), owner),
      replace = vi.fn()
    await expect(
      replaceQueuedRuleProviders(
        ['First', 'Alias'].map((provider) => ({ provider, resource: cache(provider) })),
        snapshot,
        replace,
        () => true
      )
    ).rejects.toThrow('不同的当前运行文件')
    expect(replace).not.toHaveBeenCalled()
  })

  it('uses the last verified generation and stops subsequent writes after cancellation', async () => {
    const input = fixture()
    for (const name of ['Second', 'Third']) {
      input.snapshot.providers.push({ ...input.snapshot.providers[0], name })
      input.snapshot.groups.push([name])
    }
    const snapshot = checkedRuleProvidersSnapshot(input, owner),
      after = { ...snapshot, generationSHA256: 'd'.repeat(64) },
      replace = vi
        .fn()
        .mockResolvedValueOnce({ status: 'updated', sessionId: owner, snapshot: after })
        .mockResolvedValueOnce({ status: 'cancelled', sessionId: owner }),
      resource = cache('local rule cache')
    const result = await replaceQueuedRuleProviders(
      ['First', 'Second', 'Third'].map((provider) => ({ provider, resource })),
      snapshot,
      replace,
      () => true
    )
    expect(replace).toHaveBeenCalledTimes(2)
    expect(replace).toHaveBeenLastCalledWith(
      'Second',
      { id: resource.id, sha256: resource.sha256 },
      after
    )
    expect(result).toEqual({
      completed: ['First'],
      stopped: { provider: 'Second', status: 'cancelled' }
    })
  })

  it('stops before the next confirmation when navigation revokes the pending queue', async () => {
    const input = fixture()
    input.snapshot.providers.push({ ...input.snapshot.providers[0], name: 'Second' })
    input.snapshot.groups.push(['Second'])
    const snapshot = checkedRuleProvidersSnapshot(input, owner)
    let activeScope = true
    const replace = vi.fn(async () => {
      activeScope = false
      return { status: 'updated' as const, sessionId: owner, snapshot }
    })
    const result = await replaceQueuedRuleProviders(
      ['First', 'Second'].map((provider) => ({ provider, resource: cache(provider) })),
      snapshot,
      replace,
      () => activeScope
    )
    expect(replace).toHaveBeenCalledOnce()
    expect(result.stopped).toEqual({ provider: 'Second', status: 'cancelled' })
  })
})

function cache(name: string): ResourceInfo {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    sha256: 'e'.repeat(64),
    name,
    kind: 'rule-yaml',
    behavior: 'domain',
    selector: '',
    size: 22,
    createdAt: '2026-11-09T00:00:00Z',
    integrity: 'notChecked'
  }
}
