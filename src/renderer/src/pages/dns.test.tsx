import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { DnsSettingsView } from '../components/dns/dns-settings-view'
import { relayDnsDraft } from '../utils/relay-dns-config'
import { defaultEditDocument } from '../../../shared/relay/configuration-edit'
import { RelayDnsManager } from './dns'

vi.mock('@renderer/components/base/base-page', () => ({ default: () => null }))
vi.mock('@renderer/components/base/base-setting-card', () =>
  vi.importActual('../components/base/base-setting-card')
)
vi.mock('@renderer/components/base/base-setting-item', () =>
  vi.importActual('../components/base/base-setting-item')
)
vi.mock('@renderer/components/dns/dns-settings-view', () =>
  vi.importActual('../components/dns/dns-settings-view')
)
vi.mock('@renderer/hooks/use-relay-dns-config', () =>
  vi.importActual('../hooks/use-relay-dns-config')
)
vi.mock('@renderer/hooks/use-controled-mihomo-config', () => ({
  useControledMihomoConfig: () => {
    throw new Error('Legacy controlled hook must remain unmounted')
  }
}))
vi.mock('@renderer/hooks/use-app-config', () => ({
  useAppConfig: () => {
    throw new Error('Legacy AppConfig hook must remain unmounted')
  }
}))
vi.mock('@renderer/utils/ipc', () => ({ mihomoHotReloadConfig: vi.fn() }))
vi.mock('@renderer/utils/error-display', () => ({ showErrorSync: vi.fn() }))

describe('Relay structured DNS manager', () => {
  it('keeps the screenshot settings and list editors visible while reserving the global guard for advanced settings', () => {
    const values = relayDnsDraft(defaultEditDocument())
    const html = renderToStaticMarkup(
      createElement(DnsSettingsView, {
        values,
        onChange: vi.fn(),
        showGuard: false
      })
    )
    for (const label of [
      'DNS启用',
      'DNS增强模式',
      'Fake-IP范围',
      'Fake-IP过滤模式',
      'DNS IPv6',
      'DNS遵循规则'
    ])
      expect(html).toContain(`aria-label="${label}"`)
    for (const setting of [
      'default-nameserver',
      'proxy-server-nameserver',
      'nameserver',
      'direct-nameserver'
    ])
      expect(html).toContain(setting)
    expect(html).not.toContain('禁用来源DNS保护（全局）')
    const upstream = renderToStaticMarkup(
      createElement(DnsSettingsView, { values, onChange: vi.fn() })
    )
    expect(upstream).toContain('禁用来源DNS保护（全局）')
  })
  it('keeps saving disabled before active-page loading without mounting legacy hooks', () => {
    const onBusy = vi.fn(),
      onChanged = vi.fn(),
      html = renderToStaticMarkup(
        createElement(RelayDnsManager, { busy: false, onBusy, onChanged })
      )
    expect(onBusy).not.toHaveBeenCalled()
    expect(onChanged).not.toHaveBeenCalled()
    expect(html).toContain('刷新')
    expect(html).toContain('正在读取保存的 DNS 设置')
    expect(html).toContain('保存后用于下次应用配置，当前连接不变')
    expect(html).not.toContain('确认覆盖此来源DNS并保存草稿')
    expect(html).not.toContain('DNS保护预览来源')
  })
})
