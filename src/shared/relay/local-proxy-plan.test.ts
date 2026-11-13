import { describe, expect, it } from 'vitest'
import { localProxyPrepare } from './local-proxy'
import {
  defaultLocalProxyPlan,
  localProxyPlan,
  localProxyPlanRecord,
  localProxyPlanSaveRequest
} from './local-proxy-plan'

const profile = { id: '11111111-1111-4111-8111-111111111111', sha256: 'a'.repeat(64) }
const ports = { http: 0, socks: 18192, mixed: 18194, redir: 18195 }
const dedicated = { httpPort: 18193, socksPort: 18190, route: 'fixed-node' }
const plan = { httpPort: 18194, resolverMode: 'profile' as const, ports, dedicated }

describe('Saved listener plan and preparation compatibility', () => {
  it('keeps legacy wire shapes and ordinary defaults unchanged', () => {
    const document = defaultLocalProxyPlan()
    expect(localProxyPlan(document)).toEqual({ httpPort: 18191, resolverMode: 'profile' })
    expect(localProxyPrepare({ profile, httpPort: 18191 })).toEqual({
      profile,
      httpPort: 18191,
      resolverMode: 'off',
      lifetime: 'main',
      dedicated: undefined
    })
    expect(localProxyPrepare({ profile, ...document })).not.toHaveProperty('ports')
  })

  it('roundtrips a mixed-only HTTP entry with ordinary and AI ports through save, read and prepare', () => {
    const request = localProxyPlanSaveRequest({ document: plan, expectedRevision: '' })
    const record = localProxyPlanRecord({
      document: JSON.parse(JSON.stringify(request.document)),
      revision: 'b'.repeat(64),
      exists: true
    })
    expect(record.document).toEqual(plan)
    const prepared = localProxyPrepare({
      ...record.document,
      profile,
      lifetime: 'main',
      logLevel: 'info'
    })
    expect(prepared).toEqual({ ...plan, profile, lifetime: 'main', logLevel: 'info' })
    expect(
      localProxyPlan({
        httpPort: prepared.httpPort,
        resolverMode: prepared.resolverMode,
        ports: prepared.ports,
        dedicated: prepared.dedicated
      })
    ).toEqual(plan)
  })

  it('detaches normalized ordinary and AI plans from caller-owned objects', () => {
    const input = structuredClone(plan)
    const saved = localProxyPlan(input)
    const prepared = localProxyPrepare({ ...input, profile })
    input.ports.socks = 19000
    input.dedicated.httpPort = 19001
    expect(saved.ports?.socks).toBe(18192)
    expect(saved.dedicated?.httpPort).toBe(18193)
    expect(prepared.ports?.socks).toBe(18192)
    expect(prepared.dedicated?.httpPort).toBe(18193)
  })

  it.each([
    { httpPort: 18191 },
    { httpPort: 0 },
    { ports: null },
    { ports: { ...ports, socks: ports.mixed } },
    { ports: { ...ports, mixed: 0 } },
    { ports: { ...ports, redir: 80 } },
    { ports: { ...ports, udp: false } },
    { dedicated: { httpPort: ports.socks, route: 'fixed-node' } },
    { dedicated: { socksPort: ports.redir, route: 'fixed-node' } },
    { dedicated: { ...dedicated, socksPort: dedicated.httpPort } },
    { force: true },
    { 'mixed-port': ports.mixed },
    { tun: { enable: true } }
  ])('refuses invalid or ambiguous plan and prepare ports consistently: %j', (patch) => {
    const input = { ...plan, ...patch }
    expect(() => localProxyPlan(input)).toThrow()
    expect(() => localProxyPrepare({ ...input, profile })).toThrow()
  })

  it('does not permit runtime authority in persisted plans or bypass revision checks with new ports', () => {
    for (const patch of [{ profile }, { lifetime: 'persistent' }, { systemProxy: true }]) {
      expect(() => localProxyPlan({ ...plan, ...patch })).toThrow()
    }
    expect(() =>
      localProxyPlanSaveRequest({ document: plan, expectedRevision: '', ports })
    ).toThrow()
    expect(() => localProxyPlanRecord({ document: plan, revision: '', exists: true })).toThrow()
  })
})
