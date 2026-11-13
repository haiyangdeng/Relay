import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter, type NavigateProps } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SIMPLE_MODULES } from '../../../../shared/simple-config'
import type { RelayStatus } from '../../../../shared/relay/protocol'
import { relayDefaultSidebarLayout } from '../../../../shared/relay/ui-preferences'
import {
  RELAY_PREVIEW_ONLY,
  RelayPreviewControls,
  RelayPreviewPage,
  RelayProxyRecoveryNotice
} from './preview-controls'

const fixture = vi.hoisted(() => ({
  appConfig: undefined as Partial<IAppConfig> | undefined,
  proxyStatus: undefined as RelayStatus['systemProxyStatus'],
  getAppConfig: vi.fn(),
  patchAppConfig: vi.fn(),
  mutateAppConfig: vi.fn()
}))
vi.mock('swr', () => ({ default: () => ({ data: { systemProxyStatus: fixture.proxyStatus } }) }))

vi.mock('@renderer/hooks/use-app-config', () => ({
  useAppConfig: () => ({ appConfig: fixture.appConfig, mutateAppConfig: fixture.mutateAppConfig })
}))
vi.mock('@renderer/hooks/use-profile-config', () => ({
  useProfileConfig: () => ({ profileConfig: { items: [], current: null } })
}))
vi.mock('@renderer/utils/sider', () => vi.importActual('../../utils/sider'))
vi.mock('@renderer/utils/ipc', () => ({
  getAppConfig: fixture.getAppConfig,
  patchAppConfig: fixture.patchAppConfig
}))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  // Navigate uses a client effect. Observe its props while still rendering the
  // real route guard, navigation controls and any child the guard permits.
  Navigate: ({ to, replace }: NavigateProps) =>
    createElement('span', { 'data-redirect': to, 'data-replace': replace })
}))

beforeEach(() => {
  vi.clearAllMocks()
  fixture.appConfig = { rememberSelectedSiderCard: false, lastSelectedSiderCard: 'proxy' }
  fixture.proxyStatus = undefined
})

describe('Preview sidebar boundary', () => {
  it('disables every legacy live control before safe workspace links are ready', () => {
    expect(RELAY_PREVIEW_ONLY).toBe(true)
    for (const props of [{}, { iconOnly: true }, { iconOnly: true, expanded: true }]) {
      const markup = renderToStaticMarkup(
        createElement(MemoryRouter, null, createElement(RelayPreviewControls, props))
      )
      const buttons = markup.match(/<button\b[^>]*>/g) ?? []
      expect(buttons).toHaveLength(11)
      expect(buttons.every((button) => /\bdisabled=""/.test(button))).toBe(true)
      for (const mode of ['Rule', 'Global', 'Direct'])
        expect(markup).toContain(`aria-label="${mode}（尚未接入）"`)
      expect(markup).not.toContain('aria-checked="true"')
    }
    expect(
      renderToStaticMarkup(createElement(MemoryRouter, null, createElement(RelayPreviewControls)))
    ).toContain('完整Clash后端尚未接入，以下侧栏功能暂不可操作。')
  })

  it('renders the real safe navigation and direct login/guard links in both layouts', () => {
    for (const iconOnly of [false, true]) {
      const markup = renderToStaticMarkup(
        createElement(
          MemoryRouter,
          null,
          createElement(RelayPreviewControls, { clashViewsReady: true, iconOnly })
        )
      )
      expect(markup.match(/aria-roledescription="sortable"/g)).toHaveLength(15)
      expect(markup).toContain('href="#/relay?panel=desktop-login"')
      expect(markup).toContain('href="#/relay?panel=guard"')
      expect(markup).not.toContain('开发中')
      expect(markup.match(/<button[^>]+disabled=""/g)).toHaveLength(3)
      expect(markup).not.toContain('aria-checked="true"')
    }
    expect(fixture.getAppConfig).not.toHaveBeenCalled()
    expect(fixture.patchAppConfig).not.toHaveBeenCalled()
    expect(fixture.mutateAppConfig).not.toHaveBeenCalled()
  })

  it('applies hidden and large card preferences without giving compact navigation a second column', () => {
    fixture.appConfig = {
      siderCardLayout: { ...relayDefaultSidebarLayout, dns: 'hidden', rule: 'col-span-2' }
    }
    for (const iconOnly of [false, true]) {
      const markup = renderToStaticMarkup(
        createElement(
          MemoryRouter,
          null,
          createElement(RelayPreviewControls, { clashViewsReady: true, iconOnly })
        )
      )
      expect(markup.match(/aria-roledescription="sortable"/g)).toHaveLength(14)
      expect(markup).not.toContain('aria-label="sider.cards.dns"')
      const rule = markup.match(/<button[^>]*aria-label="sider.cards.rules"[^>]*>/)?.[0]
      expect(rule).toBeDefined()
      expect(rule?.includes('col-span-2')).toBe(!iconOnly)
      expect(markup).toContain('href="#/relay?panel=guard"')
    }
    expect(fixture.patchAppConfig).not.toHaveBeenCalled()
  })
})

describe('System proxy recovery notice', () => {
  it('keeps the normal workspace clear and only flags unfinished proxy recovery', () => {
    const render = (): string => renderToStaticMarkup(createElement(RelayProxyRecoveryNotice))
    for (const status of [
      undefined,
      'unobserved',
      'inactive',
      'active',
      'applied',
      'restored',
      'rolledBack'
    ] as const) {
      fixture.proxyStatus = status
      expect(render()).toBe('')
    }
    for (const status of ['pending', 'conflict', 'uncertain'] as const) {
      fixture.proxyStatus = status
      expect(render()).toContain('系统代理恢复记录待核对')
      expect(render()).toContain('href="#/sysproxy"')
    }
  })
})

describe('Preview route boundary', () => {
  it.each(['/relay', '/proxies', '/sysproxy', '/traffic'])(
    'renders the child selected for %s',
    (path) => {
      const child = vi.fn(() => createElement('h1', null, 'Allowed workspace'))
      const markup = renderToStaticMarkup(
        createElement(RelayPreviewPage, { path }, createElement(child))
      )
      expect(child).toHaveBeenCalledOnce()
      expect(markup).toContain('<h1>Allowed workspace</h1>')
      expect(markup).not.toContain('data-redirect')
    }
  )

  const redirects = [
    ['/', '/relay?panel=profiles'],
    ['/profiles', '/relay?panel=profiles'],
    ['/resources', '/relay?panel=geodata'],
    ['/rules', '/relay?panel=rules'],
    ['/dns', '/relay?panel=dns'],
    ['/sniffer', '/relay?panel=sniffer'],
    ['/override', '/relay?panel=override-library'],
    ['/tun', '/relay?panel=tun'],
    ['/mihomo', '/relay?panel=core'],
    ['/connections', '/relay?panel=connections'],
    ['/logs', '/relay?panel=logs'],
    ['/network', '/relay?panel=network'],
    ['/settings', '/relay?panel=settings'],
    ['/substore', '/relay?panel=substore'],
    ['/simple', '/relay?panel=simple'],
    ...Object.keys(SIMPLE_MODULES).map((key) => [
      `/simple/${key}`,
      `/relay?panel=simple&amp;module=${key}`
    ])
  ]

  it.each(redirects)(
    'redirects %s to %s without rendering the legacy child',
    (path, destination) => {
      const legacy = vi.fn(() => {
        throw new Error('An unavailable upstream page was rendered')
      })
      const markup = renderToStaticMarkup(
        createElement(RelayPreviewPage, { path }, createElement(legacy))
      )
      expect(markup).toContain(`data-redirect="${destination}" data-replace="true"`)
      expect(legacy).not.toHaveBeenCalled()
      expect(fixture.patchAppConfig).not.toHaveBeenCalled()
    }
  )

  it('waits for preferences at startup before following the remembered card safely', () => {
    fixture.appConfig = undefined
    expect(renderToStaticMarkup(createElement(RelayPreviewPage, { path: '/' }))).toBe('')
    fixture.appConfig = { rememberSelectedSiderCard: true, lastSelectedSiderCard: 'rule' }
    expect(renderToStaticMarkup(createElement(RelayPreviewPage, { path: '/' }))).toContain(
      'data-redirect="/rules" data-replace="true"'
    )
    expect(renderToStaticMarkup(createElement(RelayPreviewPage, { path: '/rules' }))).toContain(
      'data-redirect="/relay?panel=rules" data-replace="true"'
    )
    expect(fixture.patchAppConfig).not.toHaveBeenCalled()
  })

  it.each(['/unsupported', '/simple/unknown', '/simple/constructor'])(
    'keeps unknown path %s inert',
    (path) => {
      const legacy = vi.fn(() => {
        throw new Error('An unrecognized page was rendered')
      })
      const markup = renderToStaticMarkup(
        createElement(RelayPreviewPage, { path }, createElement(legacy))
      )
      expect(markup).toContain('该功能尚未接入')
      expect(markup).toContain('href="#/relay"')
      expect(markup).not.toContain('data-redirect')
      expect(legacy).not.toHaveBeenCalled()
    }
  )
})
