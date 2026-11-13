import { describe, expect, it } from 'vitest'
import { controlledListeners, injectDedicatedListeners } from './dedicated-listeners'
import { localProxyConfiguration } from './local-proxy-runtime'
import { ownedCoreConfiguration } from './owned-runtime'

const source = JSON.stringify({
  proxies: [{ name: '香港 节点 🇭🇰', type: 'http', server: '127.0.0.1', port: 1234 }],
  rules: ['MATCH,REJECT']
})

describe('dedicated listener runtime boundary', () => {
  it.each([
    { httpPort: 17891, route: '香港 节点 🇭🇰' },
    { socksPort: 17890, route: '香港 节点 🇭🇰' },
    { httpPort: 17891, socksPort: 17890, route: '香港 节点 🇭🇰' }
  ])('round-trips the generated listener set without losing Unicode names: %j', (plan) => {
    const config = JSON.parse(localProxyConfiguration(source, 18191, 'off', plan).configuration)
    expect(controlledListeners(config.listeners)).toMatchObject(plan)
  })
  it('rejects duplicates, reversed order, foreign listeners and equal ports', () => {
    const config = JSON.parse(
      localProxyConfiguration(source, 18191, 'off', {
        httpPort: 17891,
        socksPort: 17890,
        route: '香港 节点 🇭🇰'
      }).configuration
    )
    const [http, socks] = config.listeners
    for (const entries of [
      [http, http],
      [socks, socks],
      [socks, http],
      [{ ...socks, name: 'foreign' }],
      [http, { ...socks, port: http.port }]
    ])
      expect(() => controlledListeners(entries)).toThrow()
  })
  it('rejects a group or unknown node before generating the listeners', () => {
    expect(() =>
      injectDedicatedListeners({ listeners: [], proxies: [] }, { httpPort: 17891, route: 'group' })
    ).toThrow('具体代理节点')
  })
  it.each(['direct', 'dns', 'reject', 'rematch'])('rejects a named %s adapter', (type) => {
    const raw = JSON.stringify({ proxies: [{ name: '节点', type }], rules: ['MATCH,REJECT'] })
    expect(() =>
      localProxyConfiguration(raw, 18191, 'off', { httpPort: 17891, route: '节点' })
    ).toThrow('具体代理节点')
    expect(() => localProxyConfiguration(raw, 18191)).not.toThrow()
  })
  it('refuses dialer routes even when the input uses an alternate field spelling', () => {
    const plan = { httpPort: 17891, route: '香港 节点 🇭🇰' }
    const prepared = localProxyConfiguration(source, 18191, 'off', plan).configuration
    const raw = JSON.parse(source)
    raw.proxies[0].dialer_proxy = 'DIRECT'
    expect(() => localProxyConfiguration(JSON.stringify(raw), 18191, 'off', plan)).toThrow(
      '前置代理'
    )
    const runtime = JSON.parse(prepared)
    runtime.proxies = raw.proxies
    expect(() => ownedCoreConfiguration(JSON.stringify(runtime), 'localProxy')).toThrow('前置代理')
    runtime.proxies = [{ name: plan.route, type: 'direct' }]
    expect(() => ownedCoreConfiguration(JSON.stringify(runtime), 'localProxy')).toThrow(
      '具体代理节点'
    )
  })
})
