import { describe, expect, it, vi } from 'vitest'
import { analyzeProfile, inspectProfile } from './inspect'
import { renameProfileOutbound } from './rename'

type Item = Record<string, unknown>
const node = (name: string, rest: Item = {}): Item => ({
  name,
  type: 'ss',
  server: '192.0.2.1',
  port: 8388,
  cipher: 'aes-128-gcm',
  password: 'A',
  ...rest
})
const base = (): Item => ({
  proxies: [node('A'), node('B')],
  'proxy-groups': [
    { name: 'G', type: 'select', proxies: ['A', 'DIRECT'], 'default-selected': 'A' }
  ],
  rules: ['MATCH,G']
})
const rename = (data: Item, after = '新名称'): Item =>
  renameProfileOutbound(data, 'nodes', 'A', after)

const aliasBase = `proxies:
  - &top {name: A, type: ss, server: 192.0.2.1, port: 8388, cipher: aes-128-gcm, password: fixture}
proxy-groups:
  - {name: G, type: select, proxies: [A]}
rules: ['MATCH,G']
`
const aliasCases = [
  `proxy-providers:\n  P: &provider {type: inline, proxy: A, payload: [{name: Local, type: ss}]}\nheaders: *provider\n`,
  `proxy-providers:\n  P: {type: inline, proxy: A, payload: [*top]}\n`,
  `headers:\n  first: &members [A, DIRECT]\n  second: *members\n`,
  `headers:\n  first: &opaque {proxy: A}\n  second: *opaque\n`
]

describe('Atomic outbound rename with explicit reference namespaces', () => {
  it.each(aliasCases)(
    'rejects a shared object/array identity accepted by the actual YAML parser: %s',
    (suffix) => {
      const parsed = analyzeProfile(aliasBase + suffix)
      expect(parsed.inspection.structure).toBe('passed')
      if (!parsed.data) throw new Error('missing actual parser data')
      const original = structuredClone(parsed.data)
      expect(() => renameProfileOutbound(parsed.data ?? {}, 'nodes', 'A', 'B')).toThrow()
      expect(parsed.data).toEqual(original)
    }
  )
  it('keeps equal but independent provider/opaque/node values in their separate namespaces', () => {
    const shared = analyzeProfile(
      aliasBase +
        'proxy-providers:\n  P: &provider {type: inline, proxy: A, payload: [*top]}\nheaders: *provider\n'
    )
    if (!shared.data) throw new Error('missing actual parser data')
    const parsed = analyzeProfile(JSON.stringify(shared.data))
    if (!parsed.data) throw new Error('missing JSON parser data')
    const data = parsed.data,
      original = structuredClone(data),
      next = renameProfileOutbound(data, 'nodes', 'A', 'B')
    expect(next.headers).toEqual(original.headers)
    expect(next['proxy-providers']).toMatchObject({ P: { proxy: 'B', payload: [{ name: 'A' }] } })
    expect(next.proxies).toMatchObject([{ name: 'B' }])
    expect(data).toEqual(original)
    expect(data.headers).not.toBe((data['proxy-providers'] as Item).P)
  })
  it('allows scalar YAML aliases because they have independent JSON value semantics', () => {
    const parsed = analyzeProfile(aliasBase + 'headers: {first: &scalar A, second: *scalar}\n')
    if (!parsed.data) throw new Error('missing parser data')
    expect(renameProfileOutbound(parsed.data, 'nodes', 'A', 'B').headers).toEqual({
      first: 'A',
      second: 'A'
    })
  })
  it.each([
    'cycle',
    'shared-map',
    'shared-array',
    'alias-dag',
    'depth',
    'nodes',
    'bytes',
    'sparse-array'
  ])('rejects unsupported identities/bounds before serializing the object: %s', (kind) => {
    const data = base(),
      repeated: Item = { proxy: 'A' }
    if (kind === 'cycle') {
      repeated.self = repeated
      data.headers = repeated
    }
    if (kind === 'shared-map') data.headers = { first: repeated, second: repeated }
    if (kind === 'shared-array') {
      const array = ['A']
      data.headers = { first: array, second: array }
    }
    if (kind === 'alias-dag') {
      let child: Item = { leaf: 'A' }
      for (let i = 0; i < 10; i++) child = { left: child, right: child }
      data.headers = child
    }
    if (kind === 'depth') {
      let child: Item = {}
      for (let i = 0; i < 42; i++) child = { child }
      data.headers = child
    }
    if (kind === 'nodes') data.headers = Array.from({ length: 50001 }, () => 1)
    if (kind === 'bytes') data.headers = 'x'.repeat(2 * 1024 * 1024)
    if (kind === 'sparse-array') {
      const array: unknown[] = []
      array.length = 1000
      data.headers = array
    }
    const stringify = vi.spyOn(JSON, 'stringify')
    let rejected = false
    try {
      rename(data)
    } catch {
      rejected = true
    }
    const calls = stringify.mock.calls.length
    stringify.mockRestore()
    expect(rejected).toBe(true)
    expect(calls).toBe(0)
  })
  it('rejects accessors without invoking them before serialization', () => {
    const data = base(),
      getter = vi.fn(() => 'A')
    Object.defineProperty(data, 'headers', { enumerable: true, get: getter })
    expect(() => rename(data)).toThrow()
    expect(getter).not.toHaveBeenCalled()
  })
  it.each([
    '1.1.1.1#en0',
    'tls://dns.invalid#en0',
    'https://dns.invalid/dns-query#h3=true&en0&ecs=192.0.2.0',
    'udp://127.0.0.1:53#other&en0',
    '1.1.1.1#%65n0',
    '1.1.1.1#other%26en0'
  ])('rejects capture of an existing effective DNS interface selector: %s', (server) => {
    const data = base()
    data.dns = { nameserver: [server] }
    const original = structuredClone(data)
    expect(() => rename(data, 'en0')).toThrow()
    expect(data).toEqual(original)
  })
  it.each([
    'fallback',
    'default-nameserver',
    'proxy-server-nameserver',
    'direct-nameserver',
    'nameserver-policy',
    'proxy-server-nameserver-policy'
  ])('rejects the same capture in the existing %s path', (slot) => {
    const data = base()
    data.dns = {
      [slot]: slot.endsWith('policy') ? { 'example.invalid': '1.1.1.1#en0' } : ['1.1.1.1#en0']
    }
    expect(() => rename(data, 'en0')).toThrow()
  })
  it('also refuses capture when renaming a group into the former interface namespace', () => {
    const data = base()
    data.dns = { nameserver: ['1.1.1.1#en0'] }
    expect(() => renameProfileOutbound(data, 'groups', 'G', 'en0')).toThrow()
  })
  it('does not ban a destination that only matches opaque fields, parameters or non-effective selectors', () => {
    const data = base()
    data.headers = { proxy: 'en0', 'dialer-proxy': 'en0' }
    data.dns = {
      nameserver: [
        '1.1.1.1#key=en0',
        '1.1.1.1#en0&en1',
        '1.1.1.1#en0&',
        'system://#en0',
        'dhcp://en0#en0',
        'rcode://success#en0'
      ]
    }
    const next = rename(data, 'en0')
    expect(next.headers).toEqual(data.headers)
    expect(next.dns).toEqual(data.dns)
  })
  it('keeps ordinary interface fallback when the chosen new name does not capture it', () => {
    const data = base()
    data.dns = { nameserver: ['1.1.1.1#en0'] }
    expect(rename(data, 'other-name').dns).toEqual(data.dns)
  })
  it('does not capture an active or inactive WireGuard DNS selector bound outside global lookup', () => {
    const data = base()
    data.proxies = [
      ...(data.proxies as Item[]),
      { name: 'WG', type: 'wireguard', 'remote-dns-resolve': true, dns: ['1.1.1.1#en0'] },
      { name: 'InactiveWG', type: 'wireguard', 'remote-dns-resolve': false, dns: ['1.1.1.1#en0'] }
    ]
    const next = rename(data, 'en0')
    expect((next.proxies as Item[]).slice(2)).toEqual((data.proxies as Item[]).slice(2))
  })
  it('retains RULES magic and a provider-owned overlay registry when neither binds the global destination', () => {
    const data = base()
    data.dns = { nameserver: ['1.1.1.1#RULES'] }
    expect(rename(data, 'RULES').dns).toEqual(data.dns)
    data['proxy-providers'] = {
      P: { type: 'inline', payload: [{ name: 'en0', type: 'tailscale' }] }
    }
    data.dns = { nameserver: ['ts://en0'] }
    expect(rename(data, 'en0').dns).toEqual(data.dns)
  })
  it('changes the declaration and confirmed references on a detached copy only', () => {
    const data = base(),
      before = structuredClone(data)
    const next = rename(data)
    expect((next.proxies as Item[])[0]).toMatchObject({ name: '新名称', password: 'A' })
    expect(next).toMatchObject({
      'proxy-groups': [{ proxies: ['新名称', 'DIRECT'], 'default-selected': '新名称' }]
    })
    expect(data).toEqual(before)
    expect(next.rules).toEqual(['MATCH,G'])
  })
  it('renames a group without changing same-spelled other namespaces or opaque fields', () => {
    const data = base()
    data['proxy-providers'] = {
      G: { type: 'inline', payload: [node('Provider')], header: { proxy: 'G' } }
    }
    data['rule-providers'] = { G: { type: 'inline', behavior: 'domain', payload: ['G'] } }
    data['sub-rules'] = { G: ['MATCH,G'] }
    data.listeners = [{ name: 'G', type: 'mixed', proxy: 'G', rule: 'G' }]
    data.headers = { proxy: 'G', 'dialer-proxy': 'G' }
    data.rules = ['SUB-RULE,(NETWORK,UDP),G', 'RULE-SET,G,G']
    const next = renameProfileOutbound(data, 'groups', 'G', 'Renamed')
    expect(next).toMatchObject({
      'proxy-groups': [{ name: 'Renamed' }],
      listeners: [{ name: 'G', proxy: 'Renamed', rule: 'G' }],
      headers: data.headers,
      'sub-rules': { G: ['MATCH,Renamed'] }
    })
    expect(next.rules).toEqual(['SUB-RULE,(NETWORK,UDP),G', 'RULE-SET,G,Renamed'])
    expect(next['proxy-providers']).toEqual(data['proxy-providers'])
    expect(next['rule-providers']).toEqual(data['rule-providers'])
  })
  it('keeps provider payload declarations while rewriting their global dialers, defaults and override', () => {
    const data = base()
    data['proxy-providers'] = {
      P: {
        type: 'inline',
        proxy: 'A',
        'dialer-proxy': 'A',
        override: { 'dialer-proxy': 'A', udp: false },
        payload: [node('A', { 'dialer-proxy': 'A' })],
        header: { proxy: 'A' }
      }
    }
    const next = rename(data)
    expect(next['proxy-providers']).toEqual({
      P: {
        type: 'inline',
        proxy: '新名称',
        'dialer-proxy': '新名称',
        override: { 'dialer-proxy': '新名称', udp: false },
        payload: [node('A', { 'dialer-proxy': '新名称' })],
        header: { proxy: 'A' }
      }
    })
  })
  it('preserves provider-owned selected names while rejecting manual/provider collisions', () => {
    const data = base()
    data['proxy-providers'] = { P: { type: 'inline', payload: [node('A')] } }
    data['proxy-groups'] = [{ name: 'G', type: 'select', use: ['P'], 'default-selected': 'A' }]
    expect(rename(data)).toMatchObject({ 'proxy-groups': [{ 'default-selected': 'A' }] })
    data['proxy-groups'] = [
      { name: 'G', type: 'select', use: ['P'], proxies: ['A'], 'default-selected': 'A' }
    ]
    expect(() => rename(data)).toThrow()
  })
  it('handles empty-fallback, listeners, ntp and tunnel fourth-token without touching endpoint text', () => {
    const data = base()
    ;(data['proxy-groups'] as Item[])[0]['empty-fallback'] = 'A'
    data.listeners = [{ name: 'A', proxy: 'A' }]
    data.ntp = { 'dialer-proxy': 'A', server: 'A' }
    data.tunnels = [
      'tcp/udp, 127.0.0.1:9000 , A:53 , A ',
      'tcp,127.0.0.1:9001,A:53',
      { network: ['tcp'], address: '127.0.0.1:9002', target: 'A:53', proxy: 'A' }
    ]
    expect(rename(data)).toMatchObject({
      'proxy-groups': [{ 'empty-fallback': '新名称' }],
      listeners: [{ name: 'A', proxy: '新名称' }],
      ntp: { 'dialer-proxy': '新名称', server: 'A' },
      tunnels: [
        'tcp/udp, 127.0.0.1:9000 , A:53 , 新名称 ',
        'tcp,127.0.0.1:9001,A:53',
        { proxy: '新名称' }
      ]
    })
  })
  it.each([
    ['MATCH, A ', 'MATCH, 新名称 '],
    ['DOMAIN,A,A,no-resolve', 'DOMAIN,A,新名称,no-resolve'],
    ['GEOIP,CN,A,src', 'GEOIP,CN,新名称,src'],
    ['DOMAIN-REGEX,^a,b$,A', 'DOMAIN-REGEX,^a,b$,新名称'],
    ['PROCESS-PATH-REGEX,a,(b|c),A', 'PROCESS-PATH-REGEX,a,(b|c),新名称'],
    ['AND,((DOMAIN,A),(NETWORK,UDP)),A', 'AND,((DOMAIN,A),(NETWORK,UDP)),新名称'],
    ['NOT,(DOMAIN,A),A', 'NOT,(DOMAIN,A),新名称']
  ])('uses fixed Core target positions: %s', (rule, expected) => {
    const data = base()
    data.rules = [rule]
    expect(rename(data).rules).toEqual([expected])
  })
  it('does not rename target-free classical provider payload or nested RULE-SET names', () => {
    const data = base()
    data['rule-providers'] = {
      A: {
        type: 'inline',
        behavior: 'classical',
        proxy: 'A',
        payload: ['DOMAIN,A', 'IP-CIDR,192.0.2.0/24,no-resolve', 'DOMAIN-REGEX,a,A']
      }
    }
    data.rules = ['AND,((RULE-SET,A),(DOMAIN,A)),A']
    expect(rename(data)).toMatchObject({
      rules: ['AND,((RULE-SET,A),(DOMAIN,A)),新名称'],
      'rule-providers': {
        A: {
          proxy: '新名称',
          payload: ['DOMAIN,A', 'IP-CIDR,192.0.2.0/24,no-resolve', 'DOMAIN-REGEX,a,A']
        }
      }
    })
  })
  it.each([
    '1.1.1.1#A',
    'https://dns.invalid/dns-query#h3=true&A&ecs=192.0.2.0',
    'tcp://127.0.0.1:53#interface&A',
    'tls://dns.invalid#%41'
  ])('rewrites only the effective ordinary DNS selector: %s', (server) => {
    const data = base()
    data.dns = { nameserver: [server] }
    const dns = rename(data).dns as Item
    const result = (dns.nameserver as string[])[0]
    expect(decodeURIComponent(result.split('#')[1]).split('&')).toContain('新名称')
    expect(result.split('#')[0]).toBe(server.split('#')[0])
  })
  it('preserves DNS non-effective/interface/RULES/parameter values and all policy keys', () => {
    const data = base()
    data.dns = {
      nameserver: [
        '1.1.1.1#A&en0',
        '1.1.1.1#key=A',
        '1.1.1.1#RULES',
        'system://#A',
        'dhcp://en0#A',
        'rcode://success#A'
      ],
      'nameserver-policy': { A: '1.1.1.1#A' },
      'proxy-server-nameserver-policy': { 'rule-set:A': ['1.1.1.1#A'] }
    }
    expect(rename(data).dns).toMatchObject({
      nameserver: (data.dns as Item).nameserver,
      'nameserver-policy': { A: '1.1.1.1#%E6%96%B0%E5%90%8D%E7%A7%B0' },
      'proxy-server-nameserver-policy': { 'rule-set:A': ['1.1.1.1#%E6%96%B0%E5%90%8D%E7%A7%B0'] }
    })
  })
  it('treats encoded separators with Go whole-fragment semantics and refuses ambiguous affected spans', () => {
    const data = base()
    data.dns = { nameserver: ['1.1.1.1#A%26en0'] }
    expect(rename(data).dns).toEqual(data.dns)
    data.dns = { nameserver: ['1.1.1.1#en0%26A'] }
    expect(() => rename(data)).toThrow()
    data.dns = { nameserver: ['1.1.1.1#A'] }
    for (const after of ['RULES', 'x&y', 'x=y']) expect(() => rename(data, after)).toThrow()
  })
  it('renames an overlay authority and reprojects only the renamed stateful private path', () => {
    const data = base()
    data.proxies = [{ name: 'A', type: 'tailscale', 'state-dir': '/not-read-or-moved' }, node('B')]
    data.dns = { nameserver: ['tailscale://A#A'] }
    const next = rename(data)
    expect(next.dns).toEqual({ nameserver: ['tailscale://新名称#A'] })
    expect((next.proxies as Item[])[0]['state-dir']).toMatch(/^relay-node-state\/[a-f0-9]{64}$/u)
    expect(data.proxies).toEqual([
      { name: 'A', type: 'tailscale', 'state-dir': '/not-read-or-moved' },
      node('B')
    ])
  })
  it('does not rename provider overlay authority when only an identically named global group changes', () => {
    const data = base()
    data['proxy-providers'] = { P: { type: 'inline', payload: [{ name: 'G', type: 'easytier' }] } }
    data.dns = { nameserver: ['et://G'] }
    expect(renameProfileOutbound(data, 'groups', 'G', 'Renamed').dns).toEqual(data.dns)
  })
  it('keeps WireGuard bound ordinary selectors but rewrites its overlay registry authority', () => {
    const data = base()
    data.proxies = [
      { name: 'A', type: 'easytier' },
      node('B'),
      { name: 'WG', type: 'wireguard', 'remote-dns-resolve': true, dns: ['1.1.1.1#A', 'et://A'] }
    ]
    expect((rename(data).proxies as Item[])[2].dns).toEqual(['1.1.1.1#A', 'et://新名称'])
  })
  it('handles actual node-schema alias keys without rewriting arbitrary headers', () => {
    const data = base()
    data.proxies = [node('A'), node('B', { Dialer_Proxy: 'A' })]
    expect((rename(data).proxies as Item[])[1].Dialer_Proxy).toBe('新名称')
  })
  it.each(['', ' A', 'A ', 'A', 'B', 'DIRECT', 'GLOBAL', 'PASS-RULE', 'x\n', 'x'.repeat(257)])(
    'refuses invalid/colliding/reserved destination %j without mutating the source',
    (after) => {
      const data = base(),
        before = structuredClone(data)
      expect(() => rename(data, after)).toThrow()
      expect(data).toEqual(before)
    }
  )
  it.each([
    { 'proxy-groups': [{ name: 'G', type: 'select', proxies: ['G'] }] },
    { proxies: [node('A', { 'dialer-proxy': 'B' }), node('B', { 'dialer-proxy': 'A' })] },
    { proxies: [node('A', { 'dialer-proxy': 'G' }), node('B')] },
    { rules: ['MATCH,Missing'] },
    { rules: ['FUTURE,A,A'] },
    { rules: ['DOMAIN,A,A,unknown-option'] },
    { rules: ['AND,((DOMAIN,A),(NETWORK,UDP),A'] },
    { 'sub-rules': { Loop: ['SUB-RULE,(NETWORK,UDP),Loop'] } },
    { 'proxy-groups': [{ name: 'G', type: 'select', proxies: ['A'], 'empty-fallback': 'G' }] },
    { 'proxy-groups': [{ name: 'G', type: 'select', proxies: ['A'], filter: 'A' }] },
    { 'proxy-groups': [{ name: 'G', type: 'select', proxies: ['A'], 'include-all': true }] },
    {
      'proxy-providers': { P: { type: 'http', url: 'https://not-fetched.invalid' } },
      'proxy-groups': [{ name: 'G', type: 'select', use: ['P'] }]
    },
    {
      'proxy-providers': {
        P: {
          type: 'inline',
          payload: [node('Other')],
          override: { 'override-expr': ['.dialer-proxy = "A"'] }
        }
      }
    },
    {
      'proxy-providers': {
        P: { type: 'inline', payload: [node('Other')], override: { 'additional-prefix': 'x' } }
      }
    },
    { listeners: [{ proxy: 'Missing' }] },
    { tunnels: ['sctp,127.0.0.1:1,localhost:2,A'] },
    { dns: { nameserver: ['future://host#A'] } }
  ])('rejects dangling/cyclic/dynamic/unknown reference semantics atomically: %j', (extra) => {
    const data = { ...base(), ...extra },
      before = structuredClone(data)
    expect(() => rename(data)).toThrow()
    expect(data).toEqual(before)
  })
  it('reserves PASS-RULE from the actual fixed Core built-in table', () => {
    expect(inspectProfile(JSON.stringify({ proxies: [node('PASS-RULE')] })).structure).toBe(
      'rejected'
    )
    expect(
      inspectProfile(
        JSON.stringify({ 'proxy-groups': [{ name: 'G', type: 'select', proxies: ['PASS-RULE'] }] })
      ).structure
    ).toBe('passed')
  })
  it('keeps legitimate src/no-resolve target names in the fixed third position', () => {
    for (const after of ['src', 'no-resolve']) {
      const data = base()
      data.rules = ['DOMAIN,A,A,no-resolve']
      expect(rename(data, after).rules).toEqual([`DOMAIN,A,${after},no-resolve`])
    }
  })
  it('enforces the existing whole-profile/item budgets and refuses invalid Unicode or unrepresentable rule targets', () => {
    const data = base()
    data.rules = Array.from({ length: 10000 }, () => 'DOMAIN,A,A')
    expect(() => rename(data, 'x'.repeat(256))).toThrow()
    expect(() => rename({ ...base(), opaque: 'x'.repeat(2 * 1024 * 1024) })).toThrow()
    expect(() => rename(base(), '\ud800')).toThrow()
    const withRule = base()
    withRule.rules = ['MATCH,A']
    expect(() => rename(withRule, 'with,comma')).toThrow()
  })
  it('hashes a renamed stateful display name instead of interpreting it as a filesystem path', () => {
    const data = base()
    data.proxies = [{ name: 'A', type: 'zerotier', 'state-dir': '/not-read-or-moved' }, node('B')]
    expect((rename(data, '../../arbitrary').proxies as Item[])[0]['state-dir']).toMatch(
      /^relay-node-state\/[a-f0-9]{64}$/u
    )
  })
})
