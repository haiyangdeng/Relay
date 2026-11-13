import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { RelayLocalProxyPanel } from './local-proxy-panel'
describe('Actual group state presentation', () => {
  it.each([undefined, 'silent'] as const)(
    'keeps inherited logging distinct from explicit %s',
    (logLevel) => {
      const html = renderToStaticMarkup(
        createElement(RelayLocalProxyPanel, {
          profiles: [],
          ports: { http: 18191, socks: 0, mixed: 0, redir: 0 },
          resolverMode: 'profile',
          lifetime: 'main',
          busy: false,
          notice: '',
          logLevel,
          onPorts: () => {},
          onResolverMode: () => {},
          onLifetime: () => {},
          onLogLevel: () => {},
          onPrepare: () => {},
          onStart: () => {},
          onStop: () => {},
          onRefresh: () => {},
          onSelect: () => {}
        })
      )
      expect(html).toContain(`<option value="${logLevel ?? 'profile'}" selected="">`)
      expect(html).toContain('沿用配置')
    }
  )
  it.each(['url-test', 'fallback', 'smart'] as const)(
    'distinguishes load balancing, pinned %s, unknown health and empty fallback',
    (type) => {
      const html = renderToStaticMarkup(
        createElement(RelayLocalProxyPanel, {
          profiles: [],
          ports: { http: 18191, socks: 0, mixed: 0, redir: 0 },
          resolverMode: 'off',
          busy: false,
          notice: '',
          onPorts: () => {},
          onResolverMode: () => {},
          onPrepare: () => {},
          onStart: () => {},
          onStop: () => {},
          onRefresh: () => {},
          onSelect: () => {},
          onAutomatic: () => {},
          state: {
            phase: 'running',
            pending: false,
            owned: true,
            hasRecord: true,
            uncertain: false,
            traffic: 'listening',
            systemProxyChanged: false,
            liveGuardEnabled: false,
            warnings: [],
            groups: [
              {
                name: 'Balance',
                type: 'load-balance',
                members: ['A'],
                selectable: false,
                confirmed: true,
                health: [{ name: 'A' }]
              },
              {
                name: 'Auto',
                type,
                members: ['A'],
                now: 'A',
                fixed: 'A',
                confirmed: true
              },
              {
                name: 'Empty',
                type: 'select',
                members: ['COMPATIBLE'],
                now: 'COMPATIBLE',
                confirmed: true,
                emptyFallback: 'COMPATIBLE'
              },
              {
                name: 'SmartAuto',
                type: 'smart',
                members: ['A', 'B'],
                fixed: '',
                confirmed: true
              },
              {
                name: 'SmartUnknown',
                type: 'smart',
                members: ['A', 'B'],
                confirmed: false
              }
            ]
          }
        })
      )
      expect(html).toContain('按连接分配，无单一当前节点')
      expect(html).toContain('尚无测速记录')
      expect(html).toContain('已固定：')
      expect(html).toContain('恢复自动选择')
      expect(html).toContain('空成员回退：')
      expect(html).toContain('Claude禁止直连未启用')
      expect(html).toContain('当前：自动选择')
      expect(html).toContain('<option value="" selected="">自动选择</option>')
      expect(html).toContain('当前选择未确认，请刷新')
      expect(html).not.toContain('当前：undefined')
    }
  )
})
