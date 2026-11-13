import { describe, expect, it } from 'vitest'
import {
  enabledLocalProxyPorts,
  localProxyHTTPPort,
  localProxyPorts,
  localProxyPortsCompatible,
  localProxyPortsFor,
  localProxyPortsMatch,
  validateDedicatedPortConflicts
} from './local-proxy-ports'

const allPorts = { http: 18191, socks: 18192, mixed: 18194, redir: 18195 }

describe('Ordinary listener port contract', () => {
  it('normalizes a legacy HTTP-only request without enabling additional listeners', () => {
    expect(localProxyPorts(undefined)).toEqual({ http: 18191, socks: 0, mixed: 0, redir: 0 })
    expect(localProxyPortsFor(19000)).toEqual({ http: 19000, socks: 0, mixed: 0, redir: 0 })
    expect(() => localProxyPorts(undefined, 0)).toThrow()
  })

  it('uses mixed as the HTTP-capable entry only when the separate HTTP listener is off', () => {
    const mixedOnly = { http: 0, socks: 0, mixed: 19000, redir: 0 }
    expect(localProxyPortsFor(19000, mixedOnly)).toEqual(mixedOnly)
    expect(localProxyHTTPPort(mixedOnly)).toBe(19000)
    expect(localProxyHTTPPort(allPorts)).toBe(allPorts.http)
    expect(() => localProxyPortsFor(allPorts.mixed, allPorts)).toThrow('不一致')
    expect(() => localProxyPortsFor(18191, mixedOnly)).toThrow('不一致')
  })

  it('accepts boundary ports and independent disabled listeners, without retaining input references', () => {
    const input = { http: 1024, socks: 65535, mixed: 0, redir: 0 }
    const parsed = localProxyPorts(input)
    expect(parsed).toEqual(input)
    input.socks = 19000
    expect(parsed.socks).toBe(65535)
    expect(enabledLocalProxyPorts(parsed)).toEqual([1024, 65535])
  })

  it.each([-1, 1, 1023, 65536, 18191.5, NaN, Infinity, '18191', null, true, undefined])(
    'rejects an invalid enabled port without numeric coercion: %s',
    (value) => {
      for (const key of ['http', 'socks', 'mixed', 'redir']) {
        expect(() => localProxyPorts({ ...allPorts, [key]: value })).toThrow()
      }
    }
  )

  it.each([
    null,
    [],
    18191,
    {},
    { http: 18191 },
    { ...allPorts, udp: true },
    { ...allPorts, 'tproxy-port': 18196 },
    { ...allPorts, tun: { enable: true } }
  ])('refuses incomplete shapes and unrelated network controls: %j', (value) => {
    expect(() => localProxyPorts(value)).toThrow()
  })

  it('requires an HTTP-capable entry and rejects duplicates across every enabled protocol', () => {
    expect(() => localProxyPorts({ http: 0, socks: 18192, mixed: 0, redir: 18195 })).toThrow()
    const keys = ['http', 'socks', 'mixed', 'redir'] as const
    for (const [index, key] of keys.entries()) {
      for (const other of keys.slice(index + 1)) {
        expect(() => localProxyPorts({ ...allPorts, [other]: allPorts[key] })).toThrow('重复')
      }
    }
  })

  it('rejects both AI listener protocols colliding with any ordinary listener', () => {
    expect(() => validateDedicatedPortConflicts(allPorts, undefined)).not.toThrow()
    expect(() =>
      validateDedicatedPortConflicts(allPorts, {
        httpPort: 18193,
        socksPort: 18190,
        route: 'fixed-node'
      })
    ).not.toThrow()
    for (const value of enabledLocalProxyPorts(allPorts)) {
      for (const key of ['httpPort', 'socksPort']) {
        expect(() =>
          validateDedicatedPortConflicts(allPorts, { [key]: value, route: 'fixed-node' })
        ).toThrow('AI 专用')
      }
    }
  })

  it('requires exact runtime readback and restart compatibility for every ordinary protocol', () => {
    const observed = {
      port: allPorts.http,
      'socks-port': allPorts.socks,
      'mixed-port': allPorts.mixed,
      'redir-port': allPorts.redir
    }
    expect(localProxyPortsMatch(observed, allPorts)).toBe(true)
    expect(localProxyPortsCompatible({ ...allPorts }, allPorts)).toBe(true)
    for (const [key, value] of Object.entries(observed)) {
      expect(localProxyPortsMatch({ ...observed, [key]: 0 }, allPorts)).toBe(false)
      expect(localProxyPortsMatch({ ...observed, [key]: String(value) }, allPorts)).toBe(false)
    }
    for (const key of ['http', 'socks', 'mixed', 'redir']) {
      expect(localProxyPortsCompatible({ ...allPorts, [key]: 0 }, allPorts)).toBe(false)
    }
  })
})
