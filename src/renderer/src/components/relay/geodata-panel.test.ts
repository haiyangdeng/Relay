import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { NavigateProps } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { GeoDataView } from '../resources/geo-data-view'
import { RelayGeoDataPanel } from './geodata-panel'
import { RelayPreviewPage } from './preview-controls'
vi.mock('@renderer/components/base/base-setting-card', () =>
  vi.importActual('../base/base-setting-card')
)
vi.mock('@renderer/components/base/base-setting-item', () =>
  vi.importActual('../base/base-setting-item')
)
vi.mock('@renderer/hooks/use-app-config', () => ({ useAppConfig: () => ({ appConfig: {} }) }))
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  Navigate: ({ to, replace }: NavigateProps) =>
    createElement('span', { 'data-redirect': to, 'data-replace': replace })
}))
describe('GeoData original controls and Relay explicit authority', () => {
  it('mounts with no writable/private draft, source IO or invented active capability', () => {
    const onBusy = vi.fn(),
      html = renderToStaticMarkup(
        createElement(RelayGeoDataPanel, {
          busy: false,
          onBusy,
          tunSessionId: '11111111-1111-4111-8111-111111111111'
        })
      )
    expect(onBusy).not.toHaveBeenCalled()
    expect(html).toContain('刷新')
    expect(html).toContain('刷新来源')
    expect(html).toContain('高级：请求参数、缓存和自动更新授权')
    expect(html).not.toContain('Geo私有请求头')
    expect(html).not.toContain('github.com')
    expect(html).toMatch(/<button disabled="">保存来源/)
    expect(html).toContain('旧能力仅做缓存工作')
  })
  it('keeps the original four URL controls and explicit DB/DAT false projection', () => {
    const html = renderToStaticMarkup(
      createElement(GeoDataView, {
        urls: { geoip: 'one', geosite: 'two', mmdb: 'three', asn: 'four' },
        onURLChange: vi.fn(),
        mode: 'db',
        onModeChange: vi.fn(),
        autoUpdate: false,
        onAutoChange: vi.fn(),
        intervalHours: '24',
        onHoursChange: vi.fn()
      })
    )
    for (const key of ['geoip', 'geosite', 'mmdb', 'asn'])
      expect(html).toContain(`aria-label="${key} URL"`)
    expect(html).toContain('GeoData DB/DAT模式')
    expect(html).not.toContain('GeoData小时周期')
  })
  it('routes the original resources entry to the connected Geo view without mounting the legacy updater', () => {
    const html = renderToStaticMarkup(
      createElement(
        RelayPreviewPage,
        { path: '/resources' },
        createElement('span', null, 'MUST-NOT-MOUNT')
      )
    )
    expect(html).toContain('data-redirect="/relay?panel=geodata" data-replace="true"')
    expect(html).not.toContain('MUST-NOT-MOUNT')
  })
})
