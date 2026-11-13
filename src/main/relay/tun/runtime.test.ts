import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import type { TunPlanEvidence } from './plan'
import {
  prepareTunCoreRuntime,
  prepareTunDescriptorRuntime,
  tunDescriptorRuntimeIsCurrent,
  tunRuntimeIsCurrent
} from './runtime'

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
function fixture(descriptor?: number, extra: Record<string, unknown> = {}) {
  const configuration = {
      port: 18290,
      mode: 'rule',
      'allow-lan': false,
      'geo-auto-update': false,
      'geox-url': { geoip: '', geosite: '', mmdb: '', asn: '' },
      tun: {
        enable: true,
        device: 'utun',
        stack: 'mixed',
        'auto-route': true,
        'auto-detect-interface': true,
        'dns-hijack': ['any:53'],
        'route-exclude-address': ['10.0.0.0/8'],
        'exclude-dst-port': [5353],
        mtu: 1500,
        ...(descriptor !== undefined ? { 'file-descriptor': descriptor } : {})
      },
      dns: { enable: true, nameserver: ['https://cloudflare-dns.com/dns-query'] },
      proxies: [],
      rules: ['IP-CIDR,10.0.0.0/8,DIRECT', 'MATCH,REJECT'],
      ...extra
    },
    source = JSON.stringify(configuration),
    request = {
      configurationSHA256: hash(source),
      bundleSHA256: hash(JSON.stringify({ configuration, assets: [], pins: [], unresolved: [] }))
    }
  const evidence: TunPlanEvidence = {
    configurationExpiresAt: 61000,
    configuration: source,
    assets: [],
    pins: [],
    parser: {
      status: 'passed',
      scope: 'complete-parser',
      configurationSHA256: request.configurationSHA256,
      coreVersion: 'v1.19.33',
      active: false,
      runtimeAccepted: false,
      warnings: []
    },
    helper: {
      version: 1,
      source: 'native',
      observedAt: 1000,
      revision: 'a'.repeat(64),
      state: 'ready',
      identity: 'authenticated',
      authorization: 'approved',
      rootOwned: true,
      runningAsRoot: true,
      clientUID: 501,
      helperSHA256: 'b'.repeat(64),
      coreSHA256: 'c'.repeat(64)
    },
    network: {
      version: 1,
      source: 'native',
      observedAt: 1000,
      state: 'observed',
      revision: 'd'.repeat(64),
      routesSHA256: 'e'.repeat(64),
      dnsSHA256: 'f'.repeat(64),
      interfacesSHA256: '1'.repeat(64),
      proxySHA256: '2'.repeat(64),
      protectionSHA256: '3'.repeat(64),
      existingTunnel: 'none',
      recovery: 'available'
    },
    expectedHelperSHA256: 'b'.repeat(64),
    expectedCoreSHA256: 'c'.repeat(64),
    currentUID: 501
  }
  return { configuration, request, evidence }
}

describe('TUN fixed-descriptor runtime preparation', () => {
  it.each([undefined, 0])('maps source descriptor %s to FD3 without mutating the source', (fd) => {
    const f = fixture(fd),
      original = structuredClone(f.evidence),
      runtime = prepareTunDescriptorRuntime(f.request, f.evidence, 1000)
    expect(JSON.parse(runtime.configuration)).toEqual({
      ...f.configuration,
      tun: { ...f.configuration.tun, 'file-descriptor': 3 }
    })
    expect(f.evidence).toEqual(original)
    expect(runtime.sourceConfigurationSHA256).toBe(f.request.configurationSHA256)
    expect(runtime.runtimeConfigurationSHA256).toBe(hash(runtime.configuration))
    expect(runtime.runtimeConfigurationSHA256).not.toBe(runtime.sourceConfigurationSHA256)
    expect(runtime.active || runtime.runtimeVerified || runtime.protectionVerified).toBe(false)
    expect(tunDescriptorRuntimeIsCurrent(runtime, f.request, f.evidence, 2000)).toBe(true)
  })

  it.each([-1, 3, 4, 2147483647])('rejects caller-supplied descriptor %s', (fd) => {
    const f = fixture(fd)
    expect(() => prepareTunDescriptorRuntime(f.request, f.evidence, 1000)).toThrow()
  })

  it.each(['rejected', 'unavailable', 'cancelled', 'uncertain'] as const)(
    'rejects original parser status %s rather than treating generated JSON as parser proof',
    (status) => {
      const f = fixture()
      f.evidence.parser.status = status
      expect(() => prepareTunDescriptorRuntime(f.request, f.evidence, 1000)).toThrow()
    }
  )

  it('rejects wrong parser digest and source/resource bindings', () => {
    const f = fixture()
    f.evidence.parser.configurationSHA256 = 'a'.repeat(64)
    expect(() => prepareTunDescriptorRuntime(f.request, f.evidence, 1000)).toThrow()
    expect(() =>
      prepareTunDescriptorRuntime({ ...f.request, bundleSHA256: 'f'.repeat(64) }, f.evidence, 1000)
    ).toThrow()
    expect(() =>
      prepareTunDescriptorRuntime({ ...f.request, descriptor: 3 }, f.evidence, 1000)
    ).toThrow()
  })

  it('keeps an unavailable helper unconfirmed even though bytes can be generated', () => {
    const f = fixture()
    f.evidence.helper.state = 'missing'
    const runtime = prepareTunDescriptorRuntime(f.request, f.evidence, 1000)
    expect(runtime.preparation.readyForConfirmation).toBe(false)
    expect(runtime.preparation.canApply).toBe(false)
    expect(tunDescriptorRuntimeIsCurrent(runtime, f.request, f.evidence, 1000)).toBe(false)
  })

  it('does not extend consent after expiry or silently accept refreshed observations', () => {
    const f = fixture(),
      runtime = prepareTunDescriptorRuntime(f.request, f.evidence, 1000)
    expect(tunDescriptorRuntimeIsCurrent(runtime, f.request, f.evidence, 61001)).toBe(false)
    f.evidence.network.observedAt = 1100
    expect(tunDescriptorRuntimeIsCurrent(runtime, f.request, f.evidence, 1100)).toBe(false)
  })

  it('rejects swapped runtime bytes, their recomputed digest, and promoted status', () => {
    const f = fixture(),
      runtime = prepareTunDescriptorRuntime(f.request, f.evidence, 1000),
      configuration = runtime.configuration.replace('MATCH,REJECT', 'MATCH,DIRECT')
    expect(
      tunDescriptorRuntimeIsCurrent(
        { ...runtime, configuration, runtimeConfigurationSHA256: hash(configuration) },
        f.request,
        f.evidence,
        1000
      )
    ).toBe(false)
    Reflect.set(runtime, 'descriptor', 4)
    expect(tunDescriptorRuntimeIsCurrent(runtime, f.request, f.evidence, 1000)).toBe(false)
    Reflect.set(runtime, 'descriptor', 3)
    Reflect.set(runtime, 'active', true)
    expect(tunDescriptorRuntimeIsCurrent(runtime, f.request, f.evidence, 1000)).toBe(false)
  })
})

describe('Mihomo-owned TUN runtime', () => {
  function managed(descriptor?: number, extra: Record<string, unknown> = {}) {
    const f = fixture(descriptor, extra)
    Object.assign(f.evidence.helper, {
      execution: 'core-managed',
      runningAsRoot: false,
      privilegedCoreVerified: true
    })
    return f
  }
  it('binds an automatic device inside the fixed upstream Darwin signed-16-bit range', () => {
    const f = managed(),
      runtime = prepareTunCoreRuntime(f.request, f.evidence, 1000),
      originalIndex =
        10000 + (Number.parseInt(runtime.preparation.evidenceSHA256.slice(0, 8), 16) % 1000000)
    // Reproduces the old allocator's incompatible result without starting TUN.
    expect(originalIndex).toBeGreaterThan(32767)
    expect(Number(runtime.device.slice(4))).toBeGreaterThanOrEqual(10000)
    expect(Number(runtime.device.slice(4))).toBeLessThanOrEqual(32767)
  })
  it.each(['utun0', 'utun32767'])('preserves supported explicit device %s', (device) => {
    const f = managed(undefined, { tun: { ...fixture().configuration.tun, device } }),
      runtime = prepareTunCoreRuntime(f.request, f.evidence, 1000)
    expect(runtime.device).toBe(device)
    expect(JSON.parse(runtime.configuration).tun.device).toBe(device)
  })
  it.each(['utun32768', 'utun652683', 'utun4294967294'])(
    'rejects device %s before the upstream can silently rename it',
    (device) => {
      const f = managed(undefined, { tun: { ...fixture().configuration.tun, device } })
      expect(() => prepareTunCoreRuntime(f.request, f.evidence, 1000)).toThrow('32767')
    }
  )
  it.each([undefined, 0])(
    'removes external FD %s and preserves every checked core option',
    (fd) => {
      const f = managed(fd),
        before = structuredClone(f.evidence),
        runtime = prepareTunCoreRuntime(f.request, f.evidence, 1000),
        expected = structuredClone(f.configuration)
      delete expected.tun['file-descriptor']
      expected.tun.device = runtime.device
      expect(JSON.parse(runtime.configuration)).toEqual(expected)
      expect(runtime.device).toMatch(/^utun[0-9]+$/)
      expect(runtime).not.toHaveProperty('descriptor')
      expect(runtime.preparation.readyForConfirmation).toBe(true)
      expect(f.evidence).toEqual(before)
      expect(tunRuntimeIsCurrent(runtime, f.request, f.evidence, 2000)).toBe(true)
      expect(tunRuntimeIsCurrent(runtime, f.request, f.evidence, 61001)).toBe(false)
    }
  )
  it.each([
    'external-controller',
    'external-controller-tls',
    'external-controller-unix',
    'external-controller-pipe'
  ])(
    'rejects privileged %s outside the private controller without silently stripping it',
    (key) => {
      const f = managed(undefined, { [key]: '0.0.0.0:9090', secret: '' }),
        before = structuredClone(f.evidence)
      expect(() => prepareTunCoreRuntime(f.request, f.evidence, 1000)).toThrow(
        'external-controller'
      )
      expect(f.evidence).toEqual(before)
    }
  )
  it.each([true, null])(
    'rejects system-clock write request %s before spawning a privileged core',
    (write) => {
      const f = managed(undefined, { ntp: { enable: true, 'write-to-system': write } })
      expect(() => prepareTunCoreRuntime(f.request, f.evidence, 1000)).toThrow(
        'ntp.write-to-system'
      )
    }
  )
  it('preserves explicitly disabled controllers and process-local NTP without broader system permission', () => {
    const extra = {
        'external-controller': '',
        'external-controller-tls': '',
        'external-controller-unix': '',
        'external-controller-pipe': '',
        ntp: { enable: true, 'write-to-system': false }
      },
      f = managed(undefined, extra)
    expect(
      JSON.parse(prepareTunCoreRuntime(f.request, f.evidence, 1000).configuration)
    ).toMatchObject(extra)
  })
  it('rejects an old FD installation and never promotes unverified privileged resources', () => {
    const old = fixture()
    expect(() => prepareTunCoreRuntime(old.request, old.evidence, 1000)).toThrow()
    const f = managed()
    f.evidence.helper.privilegedCoreVerified = false
    const runtime = prepareTunCoreRuntime(f.request, f.evidence, 1000)
    expect(runtime.preparation.issues).toContain('helperPrivilegeUnconfirmed')
    expect(tunRuntimeIsCurrent(runtime, f.request, f.evidence, 1000)).toBe(false)
  })
  it('rejects supplied descriptors, changed device bindings and refreshed installation evidence', () => {
    const bad = managed(3)
    expect(() => prepareTunCoreRuntime(bad.request, bad.evidence, 1000)).toThrow()
    const f = managed(),
      runtime = prepareTunCoreRuntime(f.request, f.evidence, 1000)
    expect(tunRuntimeIsCurrent({ ...runtime, device: 'utun1' }, f.request, f.evidence, 1000)).toBe(
      false
    )
    f.evidence.helper.revision = '9'.repeat(64)
    expect(tunRuntimeIsCurrent(runtime, f.request, f.evidence, 1000)).toBe(false)
  })
})
