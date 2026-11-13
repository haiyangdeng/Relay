import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  configurationEditDocument,
  defaultEditDocument
} from '../../../shared/relay/configuration-edit'
import { snifferDocument, snifferDraft } from '../hooks/use-relay-sniffer-config'
import { RelaySnifferManager } from './sniffer'

vi.mock('@renderer/components/base/base-page', () => ({ default: () => null }))
vi.mock('@renderer/components/base/base-setting-card', () =>
  vi.importActual('../components/base/base-setting-card')
)
vi.mock('@renderer/components/base/base-setting-item', () =>
  vi.importActual('../components/base/base-setting-item')
)
vi.mock('@renderer/components/sniffer/sniffer-settings-view', () =>
  vi.importActual('../components/sniffer/sniffer-settings-view')
)
vi.mock('@renderer/hooks/use-relay-sniffer-config', () =>
  vi.importActual('../hooks/use-relay-sniffer-config')
)
vi.mock('@renderer/hooks/use-controled-mihomo-config', () => ({
  useControledMihomoConfig: () => {
    throw new Error('Legacy settings hook must not mount')
  }
}))
vi.mock('@renderer/hooks/use-app-config', () => ({
  useAppConfig: () => {
    throw new Error('Legacy AppConfig hook must not mount')
  }
}))
vi.mock('@renderer/utils/ipc', () => ({ mihomoHotReloadConfig: vi.fn() }))
vi.mock('@renderer/utils/error-display', () => ({ showErrorSync: vi.fn() }))

const baseline = () =>
  configurationEditDocument({
    ...defaultEditDocument(),
    globalOverrides: [{ id: 'old-global', kind: 'yaml', content: 'rules: []' }],
    profileOverrideSets: [
      {
        profileId: '00000000-0000-4000-8000-000000000001',
        overrides: [{ id: 'history', kind: 'js', content: 'function main(c){return c}' }]
      }
    ],
    overrideLibraryOrder: ['00000000-0000-4000-8000-000000000002'],
    rulePatch: { prepend: ['DOMAIN,example.invalid,REJECT'] },
    controlDns: false,
    useNameserverPolicy: false,
    controlled: {
      dns: { enable: false, nameserver: ['1.1.1.1'] },
      hosts: { 'private.invalid': '127.0.0.1' },
      ipv6: false,
      sniffer: {
        enable: false,
        'parse-pure-ip': false,
        'force-dns-mapping': false,
        'override-destination': false,
        sniff: {
          HTTP: { ports: ['80', '8000-9000'], 'override-destination': false },
          TLS: { ports: ['443'], 'override-destination': true }
        },
        sniffing: ['http', 'tls'],
        'port-whitelist': ['80', '443'],
        'skip-domain': ['b.invalid', 'a.invalid']
      }
    }
  })

describe('Relay structured sniffer editor', () => {
  it('is inert before explicit read and cannot mount the legacy runtime/settings hooks', () => {
    const onBusy = vi.fn(),
      onChanged = vi.fn(),
      html = renderToStaticMarkup(
        createElement(RelaySnifferManager, { busy: false, onBusy, onChanged })
      )
    expect(onBusy).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
    expect(html).toContain('刷新')
    expect(html).toContain('正在读取嗅探设置')
    expect(html).toContain('来源配置自身的嗅探设置仍保留')
    expect(html).toContain('保存后用于下次应用配置，当前连接不变')
    expect(html).not.toContain('skip-domain')
  })

  it('changes only the control flag without materializing an absent sniffer body or defaults', () => {
    const base = defaultEditDocument(),
      next = snifferDocument(base, snifferDraft(base), false, false, true)
    expect(next).toEqual({ ...base, controlSniff: false })
    expect(next.controlled).not.toHaveProperty('sniffer')
    const existing = baseline(),
      result = snifferDocument(existing, snifferDraft(existing), false, false, true)
    expect(result.controlled.sniffer).toEqual(existing.controlled.sniffer)
    expect(result).toEqual({ ...existing, controlSniff: false })
  })

  it('keeps false, unrendered accepted options and every unrelated scope/order/setting', () => {
    const base = baseline(),
      before = structuredClone(base),
      draft = snifferDraft(base)
    expect(draft.values.enable).toBe(false)
    expect(draft.values.parsePureIP).toBe(false)
    draft.ports.HTTP = '81, 9000-9100'
    draft.editedPorts.push('HTTP')
    const next = snifferDocument(base, draft, true, true, false),
      sniffer = next.controlled.sniffer as Record<string, unknown>
    expect(base).toEqual(before)
    expect({ ...next, controlled: base.controlled }).toEqual(base)
    expect({ ...next.controlled, sniffer: base.controlled.sniffer }).toEqual(base.controlled)
    expect(sniffer).toMatchObject({
      enable: false,
      'parse-pure-ip': false,
      sniffing: ['http', 'tls'],
      'port-whitelist': ['80', '443'],
      'skip-domain': ['b.invalid', 'a.invalid'],
      sniff: {
        HTTP: { ports: ['81', '9000-9100'], 'override-destination': false },
        TLS: { ports: ['443'], 'override-destination': true }
      }
    })
    expect(sniffer).not.toHaveProperty('force-domain')
    expect(sniffer).not.toHaveProperty('skip-src-address')
    expect(sniffer.sniff).not.toHaveProperty('QUIC')
  })

  it('projects numeric template defaults to persisted strings and distinguishes empty list from empty tokens', () => {
    const base = defaultEditDocument(),
      draft = snifferDraft(base)
    expect(draft.ports.HTTP).toBe('80,443')
    expect(draft.ports.TLS).toBe('443')
    draft.ports.HTTP = ''
    const next = snifferDocument(base, draft, true, true, false)
    expect(next.controlled.sniffer).toMatchObject({
      sniff: { HTTP: { ports: [] }, TLS: { ports: ['443'] } }
    })
    draft.ports.HTTP = '80,,443'
    expect(() => snifferDocument(base, draft, true, true, false)).toThrow('空项')
    expect(() =>
      configurationEditDocument({
        ...base,
        controlled: { sniffer: { sniff: { HTTP: { ports: [80] } } } }
      })
    ).toThrow()
  })

  it('preserves explicitly stored optional empty fields without inventing absent ones', () => {
    const base = configurationEditDocument({
        ...defaultEditDocument(),
        controlled: {
          sniffer: {
            sniff: { QUIC: { ports: [], 'override-destination': false } },
            'force-domain': [],
            'skip-src-address': []
          }
        }
      }),
      next = snifferDocument(base, snifferDraft(base), true, true, false)
    expect(next.controlled.sniffer).toMatchObject({
      sniff: { QUIC: { ports: [], 'override-destination': false } },
      'force-domain': [],
      'skip-src-address': []
    })
  })
  it('does not materialize missing protocol ports when editing another field', () => {
    const base = configurationEditDocument({
        ...defaultEditDocument(),
        controlled: { sniffer: { sniff: { TLS: { 'override-destination': false } } } }
      }),
      draft = snifferDraft(base)
    draft.values.enable = false
    expect(snifferDocument(base, draft, true, true, false).controlled.sniffer).toMatchObject({
      sniff: { TLS: { 'override-destination': false } }
    })
    const beforeEdit = snifferDocument(base, draft, true, true, false).controlled.sniffer as {
      sniff: { TLS: Record<string, unknown> }
    }
    expect(beforeEdit.sniff.TLS).not.toHaveProperty('ports')
    draft.editedPorts.push('TLS')
    const afterEdit = snifferDocument(base, draft, true, true, false).controlled.sniffer as {
      sniff: { TLS: Record<string, unknown> }
    }
    expect(afterEdit.sniff.TLS).toEqual({ 'override-destination': false, ports: [] })
  })
})
