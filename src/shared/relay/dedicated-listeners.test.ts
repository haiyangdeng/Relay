import { describe, expect, it } from 'vitest'
import {
  dedicatedListenerSummary,
  dedicatedListeners,
  dedicatedListenersCompatible,
  type DedicatedListenerPlan
} from './dedicated-listeners'

describe('dedicated listener plan validation', () => {
  it('accepts a dual HTTP/SOCKS plan with a fixed node route', () => {
    const plan = dedicatedListeners({ httpPort: 17891, socksPort: 17890, route: 'NodeA' })
    expect(plan).toEqual({ httpPort: 17891, socksPort: 17890, route: 'NodeA' })
  })
  it('accepts a single HTTP-only plan', () => {
    expect(dedicatedListeners({ httpPort: 17891, route: 'NodeA' })).toEqual({
      httpPort: 17891,
      route: 'NodeA'
    })
  })
  it('accepts a single SOCKS-only plan', () => {
    expect(dedicatedListeners({ socksPort: 17890, route: 'NodeA' })).toEqual({
      socksPort: 17890,
      route: 'NodeA'
    })
  })
  it('rejects a plan with no listener at all', () => {
    expect(() => dedicatedListeners({ route: 'NodeA' })).toThrow('至少需要')
  })
  it('rejects equal HTTP and SOCKS ports', () => {
    expect(() =>
      dedicatedListeners({ httpPort: 17890, socksPort: 17890, route: 'NodeA' })
    ).toThrow()
  })
  it('rejects DIRECT, REJECT and other reserved route targets', () => {
    for (const route of ['DIRECT', 'REJECT', 'PASS', 'COMPATIBLE', 'GLOBAL'])
      expect(() => dedicatedListeners({ httpPort: 17891, route })).toThrow()
  })
  it('rejects route names that look like paths or selectors', () => {
    for (const route of ['a/b', '.hidden', 'with space\ttab'])
      expect(() => dedicatedListeners({ httpPort: 17891, route })).toThrow()
  })
  it('rejects ports outside the privileged-ephemeral range', () => {
    expect(() => dedicatedListeners({ httpPort: 80, route: 'NodeA' })).toThrow()
    expect(() => dedicatedListeners({ httpPort: 70000, route: 'NodeA' })).toThrow()
    expect(() => dedicatedListeners({ httpPort: 1.5, route: 'NodeA' })).toThrow()
  })
  it('rejects unknown keys', () => {
    expect(() => dedicatedListeners({ httpPort: 17891, route: 'NodeA', extra: 1 })).toThrow()
  })
  it('rejects non-object input', () => {
    expect(() => dedicatedListeners(null)).toThrow()
    expect(() => dedicatedListeners('x')).toThrow()
    expect(() => dedicatedListeners([{ httpPort: 17891, route: 'NodeA' }])).toThrow()
  })
})

describe('dedicated listener compatibility for hot reload', () => {
  const plan = (httpPort?: number, socksPort?: number, route = 'NodeA'): DedicatedListenerPlan =>
    httpPort && socksPort
      ? { httpPort, socksPort, route }
      : httpPort
        ? { httpPort, route }
        : socksPort
          ? { socksPort, route }
          : { route }
  it('treats undefined plans as compatible', () => {
    expect(dedicatedListenersCompatible(undefined, undefined)).toBe(true)
  })
  it('treats equal port/route plans as compatible', () => {
    expect(dedicatedListenersCompatible(plan(17891, 17890), plan(17891, 17890))).toBe(true)
  })
  it('rejects a port change', () => {
    expect(dedicatedListenersCompatible(plan(17891, 17890), plan(17892, 17890))).toBe(false)
  })
  it('rejects a route change', () => {
    expect(
      dedicatedListenersCompatible(plan(17891, 17890, 'NodeA'), plan(17891, 17890, 'NodeB'))
    ).toBe(false)
  })
  it('rejects adding or removing a dedicated entry', () => {
    expect(dedicatedListenersCompatible(undefined, plan(17891, 17890))).toBe(false)
    expect(dedicatedListenersCompatible(plan(17891, 17890), plan(17891))).toBe(false)
  })
})

describe('dedicated listener summary', () => {
  it('returns undefined for no plan', () => {
    expect(dedicatedListenerSummary(undefined)).toBeUndefined()
  })
  it('annotates the plan with the fixed Relay listener names', () => {
    expect(dedicatedListenerSummary({ httpPort: 17891, route: 'NodeA' })).toEqual({
      httpPort: 17891,
      route: 'NodeA',
      httpName: 'relay-ai-http',
      socksName: 'relay-ai-socks'
    })
  })
})
