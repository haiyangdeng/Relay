import { createHash } from 'crypto'
import { describe, expect, it } from 'vitest'
import type { TunPlanIssue } from '../../../shared/relay/tun'
import coreManifest from '../core/manifest.json'
import geodataManifest from '../core/geodata-manifest.json'
import type { CoreExecutionReceiptV2 } from '../configuration/core-snapshot-prototype'
import { prepareTunPlan, tunPlanIsCurrent, tunPlanLifetime, type TunPlanEvidence } from './plan'
import { prepareTunCoreRuntime, prepareTunDescriptorRuntime, tunRuntimeIsCurrent } from './runtime'
import { compiledExecutionCoreV2 } from './execution-installation'
import { encodeCheckedTunExecutionV2 } from './checked-execution'

const textHash = (value: string): string => createHash('sha256').update(value).digest('hex')
const hash = (value: unknown): string => textHash(JSON.stringify(value))
it('preserves an explicit zero rule count in private asset metadata and its fingerprint', () => {
  const f = fixture(),
    bytes = Buffer.from('private metadata fixture; not an accepted empty MRS'),
    sha256 = textHash(bytes.toString()),
    asset = { path: `relay-files/${sha256}.bin`, sha256, bytes, expectedRules: 0 },
    metadata = [{ path: asset.path, sha256, expectedRules: 0 }],
    evidence = { ...f.evidence, assets: [asset] },
    request = {
      ...f.request,
      bundleSHA256: hash({
        configuration: f.configuration,
        assets: metadata,
        pins: [],
        unresolved: []
      })
    },
    plan = prepareTunPlan(request, evidence, 1000)
  expect(plan.assetsSHA256).toBe(hash(metadata))
  expect(tunPlanIsCurrent(plan, request, evidence, 1001)).toBe(true)
  expect(
    tunPlanIsCurrent(
      plan,
      request,
      { ...evidence, assets: [{ ...asset, expectedRules: undefined }] },
      1001
    )
  ).toBe(false)
})
function fixture(device = 'utun') {
  const configuration = {
      port: 18290,
      mode: 'rule',
      'allow-lan': false,
      'geo-auto-update': false,
      'geox-url': { geoip: '', geosite: '', mmdb: '', asn: '' },
      tun: {
        enable: true,
        device,
        stack: 'system',
        'auto-route': true,
        'auto-detect-interface': true,
        'dns-hijack': ['any:53'],
        mtu: 1500,
        'strict-route': true,
        'route-exclude-address': ['10.0.0.0/8'],
        'exclude-dst-port': [5353],
        'udp-timeout': 180
      },
      proxies: [],
      rules: ['MATCH,REJECT']
    },
    source = JSON.stringify(configuration),
    request = {
      configurationSHA256: textHash(source),
      bundleSHA256: hash({ configuration, assets: [], pins: [], unresolved: [] })
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
      observedAt: 990,
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
function executionFixture(profile: 'stable' | 'alpha' | 'local-geodata-v1' = 'alpha') {
  const f = fixture(),
    core = compiledExecutionCoreV2(profile, 'arm64'),
    receipt: CoreExecutionReceiptV2 = {
      version: 2,
      profile,
      architecture: 'arm64',
      core: { version: core.version, sha256: core.sha256, size: core.size },
      configurationSHA256: f.request.configurationSHA256,
      selectionSHA256: '4'.repeat(64),
      snapshotSHA256: '5'.repeat(64),
      expiresAt: 60000,
      assets: []
    },
    checkedExecution = encodeCheckedTunExecutionV2(receipt)
  return {
    ...f,
    receipt,
    evidence: {
      ...f.evidence,
      checkedExecution,
      expectedCoreSHA256: core.sha256,
      parser: { ...f.evidence.parser, coreVersion: core.version },
      helper: {
        ...f.evidence.helper,
        execution: 'core-managed' as const,
        coreSHA256: core.sha256,
        privilegedCoreVerified: true
      }
    }
  }
}

describe('Checked execution bytes bound before TUN preparation', () => {
  it('retires checked execution exactly at its receipt deadline', () => {
    const f = executionFixture(),
      plan = prepareTunPlan(f.request, f.evidence, 1000),
      runtime = prepareTunCoreRuntime(f.request, f.evidence, 1000),
      deadline = f.receipt.expiresAt
    expect(tunPlanIsCurrent(plan, f.request, f.evidence, deadline - 1)).toBe(true)
    expect(tunRuntimeIsCurrent(runtime, f.request, f.evidence, deadline - 1)).toBe(true)
    expect(tunPlanIsCurrent(plan, f.request, f.evidence, deadline)).toBe(false)
    expect(tunRuntimeIsCurrent(runtime, f.request, f.evidence, deadline)).toBe(false)
  })
  it.each(['stable', 'alpha', 'local-geodata-v1'] as const)(
    'preserves source receipt and raw bytes for %s',
    (profile) => {
      const f = executionFixture(profile),
        plan = prepareTunPlan(f.request, f.evidence, 1000),
        runtime = prepareTunCoreRuntime(f.request, f.evidence, 1000)
      expect(plan.readyForConfirmation).toBe(true)
      expect(runtime.checkedExecution).toEqual(f.evidence.checkedExecution)
      expect(runtime.checkedExecution?.receipt.configurationSHA256).toBe(
        f.request.configurationSHA256
      )
      expect(runtime.runtimeConfigurationSHA256).not.toBe(f.request.configurationSHA256)
      expect(tunRuntimeIsCurrent(runtime, f.request, f.evidence, 2000)).toBe(true)
      expect(() => prepareTunDescriptorRuntime(f.request, f.evidence, 1000)).toThrow('FD')
    }
  )
  it('binds the exact raw digest before deriving evidence and the automatic device', () => {
    const f = executionFixture(),
      first = prepareTunPlan(f.request, f.evidence, 1000),
      runtime = prepareTunCoreRuntime(f.request, f.evidence, 1000),
      raw = f.evidence.checkedExecution.raw + '\n',
      changed = {
        ...f.evidence,
        checkedExecution: { ...f.evidence.checkedExecution, raw, sha256: textHash(raw) }
      },
      next = prepareTunPlan(f.request, changed, 1000),
      updated = prepareTunCoreRuntime(f.request, changed, 1000)
    expect(next.evidenceSHA256).not.toBe(first.evidenceSHA256)
    expect(updated.device).toBe(
      `utun${10000 + (Number.parseInt(next.evidenceSHA256.slice(0, 8), 16) % 22768)}`
    )
    expect(updated.checkedExecution?.raw).toBe(raw)
    expect(tunRuntimeIsCurrent(runtime, f.request, changed, 2000)).toBe(false)
  })
  it('rejects a changed raw digest, source, tuple, receipt or expiry before a runtime exists', () => {
    const f = executionFixture(),
      execution = f.evidence.checkedExecution
    for (const checkedExecution of [
      { ...execution, raw: execution.raw + ' ' },
      { ...execution, receipt: { ...execution.receipt, selectionSHA256: '6'.repeat(64) } },
      encodeCheckedTunExecutionV2({ ...f.receipt, selectionSHA256: 'not-a-digest' }),
      encodeCheckedTunExecutionV2({ ...f.receipt, snapshotSHA256: 'not-a-digest' }),
      encodeCheckedTunExecutionV2({ ...f.receipt, expiresAt: 1000 }),
      encodeCheckedTunExecutionV2({ ...f.receipt, configurationSHA256: '7'.repeat(64) }),
      encodeCheckedTunExecutionV2({
        ...f.receipt,
        core: { ...f.receipt.core, size: f.receipt.core.size + 1 }
      })
    ])
      expect(() =>
        prepareTunCoreRuntime(f.request, { ...f.evidence, checkedExecution }, 1000)
      ).toThrow()
    expect(
      prepareTunPlan(
        f.request,
        {
          ...f.evidence,
          helper: { ...fixture().evidence.helper, coreSHA256: f.evidence.expectedCoreSHA256 }
        },
        1000
      ).readyForConfirmation
    ).toBe(false)
  })
})
describe('Pure TUN plan from a complete bound candidate and trusted observations', () => {
  it.each(
    [coreManifest, geodataManifest].flatMap((manifest) =>
      Object.entries(manifest.assets).map(([architecture, pin]) => ({
        architecture,
        coreSHA256: pin.sha256,
        version: manifest.version
      }))
    )
  )('accepts the compiled $architecture $version Core and matching parser', (profile) => {
    const f = fixture()
    f.evidence.expectedCoreSHA256 = profile.coreSHA256
    f.evidence.helper.coreSHA256 = profile.coreSHA256
    f.evidence.helper.execution = 'core-managed'
    f.evidence.helper.privilegedCoreVerified = true
    f.evidence.helper.runningAsRoot = false
    f.evidence.parser.coreVersion = profile.version
    const plan = prepareTunPlan(f.request, f.evidence, 1000)
    expect(plan.readyForConfirmation).toBe(true)
    expect(plan.issues).toEqual([])
    expect(plan.canApply).toBe(false)
    const runtime = prepareTunCoreRuntime(f.request, f.evidence, 1000)
    expect(runtime).toMatchObject({
      version: 2,
      execution: 'core-managed',
      preparation: { readyForConfirmation: true }
    })
    expect(tunRuntimeIsCurrent(runtime, f.request, f.evidence, 1000)).toBe(true)
  })
  it.each(
    [coreManifest, geodataManifest].flatMap((manifest) =>
      Object.entries(manifest.assets).flatMap(([architecture, pin]) =>
        [
          manifest.version === coreManifest.version
            ? geodataManifest.version
            : coreManifest.version,
          'untrusted-version'
        ].map((version) => ({ architecture, coreSHA256: pin.sha256, version }))
      )
    )
  )('refuses $version parser for a different compiled $architecture Core', (profile) => {
    const f = fixture()
    f.evidence.expectedCoreSHA256 = profile.coreSHA256
    f.evidence.helper.coreSHA256 = profile.coreSHA256
    f.evidence.helper.execution = 'core-managed'
    f.evidence.helper.privilegedCoreVerified = true
    f.evidence.helper.runningAsRoot = false
    f.evidence.parser.coreVersion = profile.version
    const plan = prepareTunPlan(f.request, f.evidence, 1000)
    expect(plan.readyForConfirmation).toBe(false)
    expect(plan.issues).toEqual(['parserNotPassed'])
    expect(plan.canApply).toBe(false)
    expect(() => prepareTunCoreRuntime(f.request, f.evidence, 1000)).toThrow('完整候选')
  })
  it('does not grant the new parser version for an unknown expected Core SHA', () => {
    const f = fixture()
    f.evidence.parser.coreVersion = geodataManifest.version
    expect(prepareTunPlan(f.request, f.evidence, 1000).issues).toEqual(['parserNotPassed'])
  })
  it('caps confirmation at the earlier complete candidate deadline', () => {
    const f = fixture()
    Object.assign(f.evidence, { configurationExpiresAt: 1200 })
    const plan = prepareTunPlan(f.request, f.evidence, 1000)
    expect(plan.expiresAt).toBe(1200)
    expect(tunPlanIsCurrent(plan, f.request, f.evidence, 1200)).toBe(true)
    expect(tunPlanIsCurrent(plan, f.request, f.evidence, 1201)).toBe(false)
  })
  it.each(['utun', 'utun0', 'utun100000', 'utun4294967294'])(
    'preserves valid auto or SDK-width device name %s',
    (device) => {
      const f = fixture(device),
        plan = prepareTunPlan(f.request, f.evidence, 1000)
      expect(plan.readyForConfirmation).toBe(true)
      expect(plan.effects.device).toBe(device)
      expect(plan.canApply).toBe(false)
    }
  )
  it.each([
    'utun4294967295',
    'utun01',
    'utun000000000001',
    'utun123456789012',
    'utun0\n',
    'utun+1',
    'utun一'
  ])('rejects noncanonical or out-of-width device name %s', (device) => {
    const f = fixture(device)
    expect(() => prepareTunPlan(f.request, f.evidence, 1000)).toThrow('macOS设备')
  })
  it('binds all TUN fields and never grants execution or protection from a parser result', () => {
    const f = fixture(),
      before = structuredClone(f.evidence),
      plan = prepareTunPlan(f.request, f.evidence, 1000)
    expect(plan).toMatchObject({
      readyForConfirmation: true,
      canApply: false,
      active: false,
      runtimeVerified: false,
      protectionVerified: false,
      createdAt: 1000,
      expiresAt: 990 + tunPlanLifetime,
      effects: { device: 'utun', autoRoute: true, dnsHijack: true },
      issues: []
    })
    expect(plan.tunSHA256).toBe(hash(f.configuration.tun))
    expect(f.evidence).toEqual(before)
    expect(JSON.stringify(plan)).not.toContain('MATCH,REJECT')
  })
  it('retains unknown readiness and lists every missing safety prerequisite', () => {
    const f = fixture()
    f.evidence.helper = {
      ...f.evidence.helper,
      state: 'missing',
      identity: 'unconfirmed',
      authorization: 'unconfirmed',
      rootOwned: false,
      runningAsRoot: false,
      helperSHA256: undefined,
      coreSHA256: undefined
    }
    delete f.evidence.helper.helperSHA256
    delete f.evidence.helper.coreSHA256
    f.evidence.network = {
      ...f.evidence.network,
      state: 'unavailable',
      existingTunnel: 'unconfirmed',
      recovery: 'unconfirmed'
    }
    const plan = prepareTunPlan(f.request, f.evidence, 1000)
    expect(plan.readyForConfirmation).toBe(false)
    expect(plan.issues).toEqual([
      'helperNotReady',
      'helperIdentityUnconfirmed',
      'helperAuthorizationUnconfirmed',
      'helperResourceMismatch',
      'helperPrivilegeUnconfirmed',
      'networkUnconfirmed',
      'existingTunnelUnresolved',
      'recoveryUnavailable'
    ])
  })
  it.each<{
    change: (e: TunPlanEvidence) => void
    issue: TunPlanIssue
  }>([
    { change: (e) => (e.parser.status = 'unavailable'), issue: 'parserNotPassed' },
    { change: (e) => (e.parser.coreVersion = 'v1.19.34'), issue: 'parserNotPassed' },
    {
      change: (e) => (e.parser.configurationSHA256 = '9'.repeat(64)),
      issue: 'parserDigestMismatch'
    },
    { change: (e) => (e.helper.identity = 'mismatch'), issue: 'helperIdentityUnconfirmed' },
    {
      change: (e) => (e.helper.authorization = 'notApproved'),
      issue: 'helperAuthorizationUnconfirmed'
    },
    { change: (e) => (e.helper.helperSHA256 = '9'.repeat(64)), issue: 'helperResourceMismatch' },
    { change: (e) => (e.helper.coreSHA256 = '9'.repeat(64)), issue: 'helperResourceMismatch' },
    { change: (e) => (e.helper.rootOwned = false), issue: 'helperPrivilegeUnconfirmed' },
    { change: (e) => (e.helper.runningAsRoot = false), issue: 'helperPrivilegeUnconfirmed' },
    { change: (e) => (e.helper.clientUID = 502), issue: 'helperClientMismatch' },
    { change: (e) => (e.network.state = 'conflict'), issue: 'networkUnconfirmed' },
    { change: (e) => (e.network.existingTunnel = 'present'), issue: 'existingTunnelUnresolved' },
    { change: (e) => (e.network.recovery = 'conflict'), issue: 'recoveryUnavailable' },
    { change: (e) => (e.helper.observedAt = 1001), issue: 'observationExpired' },
    { change: (e) => (e.network.observedAt = 1001), issue: 'observationExpired' }
  ])('blocks $issue when a required observation fails', ({ change, issue }) => {
    const f = fixture()
    change(f.evidence)
    const plan = prepareTunPlan(f.request, f.evidence, 1000)
    expect(plan.readyForConfirmation).toBe(false)
    expect(plan.canApply).toBe(false)
    expect(plan.issues).toContain(issue)
  })
  it('expires stale observations and changes its fingerprint for network, resource or source revisions', () => {
    const f = fixture(),
      plan = prepareTunPlan(f.request, f.evidence, 1000)
    expect(
      prepareTunPlan(
        f.request,
        { ...f.evidence, configurationExpiresAt: 1001 + 2 * tunPlanLifetime },
        1001 + tunPlanLifetime
      ).issues
    ).toContain('observationExpired')
    for (const field of [
      'revision',
      'routesSHA256',
      'dnsSHA256',
      'interfacesSHA256',
      'proxySHA256',
      'protectionSHA256'
    ] as const) {
      const e = structuredClone(f.evidence)
      e.network[field] = '8'.repeat(64)
      expect(prepareTunPlan(f.request, e, 1000).evidenceSHA256).not.toBe(plan.evidenceSHA256)
    }
    f.evidence.helper.revision = '8'.repeat(64)
    expect(prepareTunPlan(f.request, f.evidence, 1000).evidenceSHA256).not.toBe(plan.evidenceSHA256)
  })
  it('rechecks all plan evidence without extending its deadline or granting execution', () => {
    const f = fixture(),
      plan = prepareTunPlan(f.request, f.evidence, 1000)
    expect(tunPlanIsCurrent(plan, f.request, f.evidence, plan.expiresAt)).toBe(true)
    for (const time of [999, plan.expiresAt + 1, NaN])
      expect(tunPlanIsCurrent(plan, f.request, f.evidence, time)).toBe(false)
    const altered = { ...plan }
    Object.defineProperty(altered, 'canApply', { value: true })
    expect(tunPlanIsCurrent(altered, f.request, f.evidence, 1000)).toBe(false)
    expect(
      tunPlanIsCurrent({ ...plan, expiresAt: plan.expiresAt + 1 }, f.request, f.evidence, 1000)
    ).toBe(false)
    f.evidence.network.protectionSHA256 = '8'.repeat(64)
    expect(tunPlanIsCurrent(plan, f.request, f.evidence, 1000)).toBe(false)
    expect(tunPlanIsCurrent(plan, { ...f.request, pid: 1 }, f.evidence, 1000)).toBe(false)
  })
  it('rejects changed bodies, bundle manifests, malformed pins and unbound resource references', () => {
    const f = fixture()
    expect(() =>
      prepareTunPlan({ ...f.request, configurationSHA256: '9'.repeat(64) }, f.evidence, 1000)
    ).toThrow('正文')
    expect(() =>
      prepareTunPlan({ ...f.request, bundleSHA256: '9'.repeat(64) }, f.evidence, 1000)
    ).toThrow('资源包摘要')
    const badPin = structuredClone(f.evidence)
    badPin.pins = [
      {
        id: '00000000-0000-0000-0000-000000000001',
        namespace: 'resource',
        sha256: 'a'.repeat(64),
        revision: 'bad'
      }
    ]
    expect(() => prepareTunPlan(f.request, badPin, 1000)).toThrow('来源')
    const bytes = Buffer.from('asset'),
      sha256 = textHash('asset')
    const asset = { path: `relay-files/${sha256}.bin`, sha256, bytes }
    const withAsset = { ...f.evidence, assets: [asset] }
    expect(() => prepareTunPlan(f.request, withAsset, 1000)).toThrow('资源包摘要')
    asset.bytes[0] = 0
    expect(() => prepareTunPlan(f.request, withAsset, 1000)).toThrow('资源摘要')
    const configuration = {
        ...f.configuration,
        proxies: [
          { name: 'ssh', type: 'ssh', server: '127.0.0.1', port: 22, 'private-key': '/outside/key' }
        ]
      },
      source = JSON.stringify(configuration)
    expect(() =>
      prepareTunPlan(
        { ...f.request, configurationSHA256: textHash(source) },
        { ...f.evidence, configuration: source },
        1000
      )
    ).toThrow('未绑定文件')
  })
  it.each([
    { enable: false },
    { device: 'en0' },
    { device: 'utun01' },
    { stack: 'mips' },
    { 'file-descriptor': 3 },
    { 'auto-route': undefined },
    { unexpected: true }
  ])('rejects unsafe or ambiguous TUN candidates %j', (patch) => {
    const f = fixture(),
      configuration = { ...f.configuration, tun: { ...f.configuration.tun, ...patch } },
      source = JSON.stringify(configuration),
      configurationSHA256 = textHash(source)
    expect(() =>
      prepareTunPlan(
        {
          configurationSHA256,
          bundleSHA256: hash({ configuration, assets: [], pins: [], unresolved: [] })
        },
        {
          ...f.evidence,
          configuration: source,
          parser: { ...f.evidence.parser, configurationSHA256 }
        },
        1000
      )
    ).toThrow()
  })
})
