import { describe, expect, it } from 'vitest'
import { profileRuntimeSource } from '../__fixtures__/profile-runtime'
import { isolatedCoreConfiguration } from './configuration'
import { localProxyConfiguration } from './local-proxy-runtime'
import { ownedCoreConfiguration } from './owned-runtime'

const ports = { http: 18191, socks: 18192, mixed: 18194, redir: 18195 }
const compile = (plan = ports) =>
  localProxyConfiguration(
    profileRuntimeSource,
    plan.http || plan.mixed,
    'off',
    undefined,
    undefined,
    [],
    plan
  )

describe('ordinary local proxy listener boundary', () => {
  it('preserves legacy HTTP-only defaults despite source mixed-port', () => {
    const built = localProxyConfiguration(profileRuntimeSource, 18191)
    expect(built.ports).toEqual({ http: 18191, socks: 0, mixed: 0, redir: 0 })
    expect(ownedCoreConfiguration(built.configuration, 'localProxy').ports).toEqual(built.ports)
  })
  it.each([ports, { ...ports, http: 0 }])(
    'compiles and admits every selected listener: %j',
    (plan) => {
      const built = compile(plan)
      const admitted = ownedCoreConfiguration(built.configuration, 'localProxy')
      expect(admitted.ports).toEqual(plan)
      expect(admitted.port).toBe(plan.http || plan.mixed)
      expect(admitted.parsed).toMatchObject({
        port: plan.http,
        'socks-port': plan.socks,
        'mixed-port': plan.mixed,
        'redir-port': plan.redir,
        'tproxy-port': 0,
        'bind-address': '127.0.0.1',
        'allow-lan': false,
        tun: { enable: false }
      })
    }
  )
  it.each(['socks', 'mixed', 'redir'] as const)(
    'rejects dedicated collisions with ordinary %s',
    (key) => {
      expect(() =>
        localProxyConfiguration(
          profileRuntimeSource,
          ports.http,
          'off',
          { httpPort: ports[key], route: 'Node' },
          undefined,
          [],
          ports
        )
      ).toThrow('端口')
      const built = localProxyConfiguration(
        profileRuntimeSource,
        ports.http,
        'off',
        { socksPort: 18200, route: 'Node' },
        undefined,
        [],
        ports
      )
      const raw = JSON.parse(built.configuration)
      raw.listeners[0].port = ports[key]
      expect(() => ownedCoreConfiguration(JSON.stringify(raw), 'localProxy')).toThrow('端口')
    }
  )
  it('rejects top-level port drift and keeps TPROXY closed', () => {
    const raw = JSON.parse(compile().configuration)
    raw['mixed-port'] = raw.port
    expect(() => ownedCoreConfiguration(JSON.stringify(raw), 'localProxy')).toThrow('重复')
    raw['mixed-port'] = ports.mixed
    raw['tproxy-port'] = 18200
    expect(() => ownedCoreConfiguration(JSON.stringify(raw), 'localProxy')).toThrow('边界')
  })
  it.each(['socks-port', 'mixed-port', 'redir-port'])(
    'does not open %s for inert validation',
    (key) => {
      const raw = isolatedCoreConfiguration()
      raw[key] = 18200
      expect(() => ownedCoreConfiguration(JSON.stringify(raw), 'inert')).toThrow('边界')
    }
  )
  it.each(['socks-port', 'mixed-port', 'redir-port'])(
    'does not open %s for isolated probes',
    (key) => {
      const raw = isolatedCoreConfiguration()
      Object.assign(raw, {
        port: 18191,
        proxies: [{ name: 'A', type: 'http', server: '1.1.1.1', port: 443 }],
        'proxy-groups': [{ name: '__RELAY_ISOLATED_PROBE__', type: 'select', proxies: ['A'] }],
        rules: ['MATCH,__RELAY_ISOLATED_PROBE__']
      })
      expect(() =>
        ownedCoreConfiguration(JSON.stringify(raw), 'localProxy', undefined, {})
      ).not.toThrow()
      raw[key] = 18200
      expect(() =>
        ownedCoreConfiguration(JSON.stringify(raw), 'localProxy', undefined, {})
      ).toThrow('边界')
    }
  )
})
