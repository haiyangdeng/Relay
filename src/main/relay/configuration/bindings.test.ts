import { mkdtemp, realpath, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { ResourceStore } from '../resources/store'
import { ProfileStore } from '../profiles/store'
import { resourceDescriptor } from '../../../shared/relay/resources'
import { checkResourceWithCore } from '../resources/checker'
import { resourceHash } from '../resources/source'
import { bindRuntimeResources } from './bindings'
import { collectRuntimeDependencies } from './dependencies'
import { validateBoundConfiguration } from './checker'

async function fixture(
  run: (
    stores: { resources: ResourceStore; providers: ProfileStore },
    home: string
  ) => Promise<void>
): Promise<void> {
  const home = await realpath(await mkdtemp('/private/tmp/relay-runtime-bindings-'))
  const context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') }
  try {
    await run(
      {
        resources: new ResourceStore(context),
        providers: new ProfileStore(context, 'ProviderResources')
      },
      home
    )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
const selected = (value: { id: string; sha256: string }) => ({ id: value.id, sha256: value.sha256 })

describe('Complete configuration dependency binding to immutable private cache', () => {
  it.each([
    { label: 'rules', input: { rules: ['ip-asn,64512,REJECT,no-resolve'] } },
    {
      label: 'sub-rules',
      input: {
        rules: ['SUB-RULE,(NETWORK,tcp),nested', 'MATCH,REJECT'],
        'sub-rules': { nested: ['sRc-iP-aSn,64512,REJECT'] }
      }
    },
    {
      label: 'inline classical payload',
      input: {
        rules: ['RULE-SET,R,REJECT', 'MATCH,REJECT'],
        'rule-providers': {
          R: { type: 'inline', behavior: 'classical', payload: ['ip-asn,64512'] }
        }
      }
    }
  ])(
    'requires the original ASN slot for mixed-case $label without rewriting rules',
    async ({ input }) => {
      await fixture(async (stores) => {
        const source = JSON.stringify(input),
          collected = collectRuntimeDependencies(source),
          partial = await bindRuntimeResources(source, [], stores)
        expect(collected.configuration).toMatchObject(input)
        expect(collected.dependencies.map((item) => item.kind)).toEqual(['asn-mmdb'])
        expect(partial.configuration).toMatchObject(input)
        expect(partial.unresolved.map((item) => item.kind)).toEqual(['asn-mmdb'])
        expect(() =>
          validateBoundConfiguration(JSON.stringify(partial.configuration), partial.assets)
        ).toThrow('未解决')
        const unrelated = Buffer.from('wrong database slot')
        expect(() =>
          validateBoundConfiguration(JSON.stringify(partial.configuration), [
            { path: 'Country.mmdb', bytes: unrelated, sha256: resourceHash(unrelated) }
          ])
        ).toThrow('未解决')
        const database = await stores.resources.save(
            { name: 'ASN binding fixture', kind: 'asn-mmdb', behavior: null, selector: '64512' },
            Buffer.from('binding bytes, not a semantically validated database')
          ),
          complete = await bindRuntimeResources(
            source,
            [{ dependencyId: collected.dependencies[0].id, selection: selected(database) }],
            stores
          )
        expect(complete.unresolved).toEqual([])
        expect(complete.assets.map((asset) => asset.path)).toEqual(['ASN.mmdb'])
        expect(complete.configuration).toMatchObject(input)
        expect(() =>
          validateBoundConfiguration(JSON.stringify(complete.configuration), complete.assets)
        ).not.toThrow()
        await complete.recheck()
      })
    }
  )
  it.each([false, true])(
    'retains geography mode %s when only rule-type classification folds case',
    async (mode) => {
      const input = {
        'geodata-mode': mode,
        rules: ['and,((NETWORK,tcp),(gEoIp,CN)),REJECT', 'geosite,CN,REJECT']
      }
      const collected = collectRuntimeDependencies(JSON.stringify(input))
      expect(collected.configuration).toMatchObject(input)
      expect(collected.dependencies.map((item) => item.kind)).toEqual([
        mode ? 'geoip-dat' : 'country-mmdb',
        'geosite-dat'
      ])
    }
  )
  it('requires one pinned ASN asset for Smart preference, even without an IP-ASN rule', async () => {
    await fixture(async (stores) => {
      const group = {
        name: 'SmartASN',
        type: 'smart',
        proxies: ['REJECT'],
        url: 'http://127.0.0.1:1/health',
        'prefer-asn': true
      }
      const source = JSON.stringify({ 'proxy-groups': [group], rules: ['MATCH,SmartASN'] }),
        dependency = collectRuntimeDependencies(source).dependencies[0]
      expect(dependency.kind).toBe('asn-mmdb')
      expect(
        collectRuntimeDependencies(
          JSON.stringify({
            'proxy-groups': [group, { ...group, name: 'Second' }],
            rules: ['IP-ASN,64512,REJECT']
          })
        ).dependencies
      ).toHaveLength(1)
      for (const preference of [false, undefined])
        expect(
          collectRuntimeDependencies(
            JSON.stringify({ 'proxy-groups': [{ ...group, 'prefer-asn': preference }] })
          ).dependencies
        ).toEqual([])
      expect(
        collectRuntimeDependencies(
          JSON.stringify({
            'proxy-groups': [{ ...group, 'prefer-asn': false }],
            rules: ['ip-asn,64512,REJECT']
          })
        ).dependencies.map((item) => item.kind)
      ).toEqual(['asn-mmdb'])
      const partial = await bindRuntimeResources(source, [], stores)
      expect(partial.unresolved.map((item) => item.kind)).toEqual(['asn-mmdb'])
      expect(() =>
        validateBoundConfiguration(JSON.stringify(partial.configuration), partial.assets)
      ).toThrow('未解决')
      const wrong = await stores.resources.save(
        { name: 'Wrong purpose', kind: 'runtime-file', behavior: null, selector: '' },
        Buffer.from('fixture, not a database')
      )
      await expect(
        bindRuntimeResources(
          source,
          [{ dependencyId: dependency.id, selection: selected(wrong) }],
          stores
        )
      ).rejects.toThrow('用途')
      const database = await stores.resources.save(
        { name: 'ASN fixture', kind: 'asn-mmdb', behavior: null, selector: '64512' },
        Buffer.from('binding contract fixture, not a semantically validated database')
      )
      const complete = await bindRuntimeResources(
        source,
        [{ dependencyId: dependency.id, selection: selected(database) }],
        stores
      )
      expect(complete.unresolved).toEqual([])
      expect(complete.assets.map((asset) => asset.path)).toEqual(['ASN.mmdb'])
      expect(complete.pins).toMatchObject([{ id: database.id, sha256: database.sha256 }])
      expect(complete.configuration['proxy-groups']).toMatchObject([group])
      expect(() =>
        validateBoundConfiguration(JSON.stringify(complete.configuration), complete.assets)
      ).not.toThrow()
      await complete.recheck()
      complete.assets[0].bytes[0] ^= 1
      await expect(complete.recheck()).rejects.toThrow('正文已变化')
      expect(() =>
        validateBoundConfiguration(JSON.stringify(complete.configuration), complete.assets)
      ).toThrow('摘要')
    })
  })
  it('recognizes only actual references, including alias fields and deferred state/UI paths, without opening them', () => {
    const source = JSON.stringify({
      proxies: [
        { name: 'WG', type: 'wireguard', 'private-key': 'base64', server: '127.0.0.1', port: 1234 },
        { name: 'SSH', type: 'ssh', server: '127.0.0.1', port: 22, Private_Key: '/PRIVATE/key' },
        { name: 'ZT', type: 'zerotier', network: '0123456789abcdef', planet: '/PRIVATE/planet' }
      ],
      tls: { 'ech-key': '/PRIVATE/ech' },
      'external-ui': '/PRIVATE/ui',
      dns: { 'nameserver-policy': { 'geosite:cn': ['1.1.1.1'] } },
      rules: ['AND,((NETWORK,tcp),(GEOIP,CN)),REJECT', 'IP-ASN,64512,REJECT'],
      hosts: { 'GEOIP,CN': '127.0.0.1' }
    })
    const result = collectRuntimeDependencies(source)
    expect(result.dependencies.map((item) => item.kind).sort()).toEqual(
      [
        'runtime-file',
        'runtime-file',
        'runtime-file',
        'state-directory',
        'ui-directory',
        'geosite-dat',
        'country-mmdb',
        'asn-mmdb'
      ].sort()
    )
    expect(result.configuration.proxies).toMatchObject([
      { type: 'wireguard' },
      { 'private-key': '/PRIVATE/key' },
      { type: 'zerotier' }
    ])
    expect(result.dependencies.some((item) => item.reference === 'base64')).toBe(false)
  })
  it('keeps inline PEM, inline Reality keys, domain names and arbitrary header text outside file/geo dependency scanning', () => {
    const result = collectRuntimeDependencies(
      JSON.stringify({
        proxies: [
          {
            name: 'N',
            type: 'vless',
            server: '127.0.0.1',
            port: 1,
            uuid: 'x',
            certificate: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----',
            'reality-opts': { 'public-key': 'key', 'short-id': 'ab' },
            'ws-opts': { headers: { 'GEOIP,CN': 'GEOSITE,CN' } }
          }
        ],
        rules: ['MATCH,REJECT']
      })
    )
    expect(result.dependencies).toEqual([])
  })
  it('recognizes numeric file references and the fixed default geoip filter even when a fallback-filter map omits that switch', () => {
    expect(
      collectRuntimeDependencies(
        'tls: {certificate: 123}\ndns: {fallback: [1.1.1.1], fallback-filter: {ipcidr: []}}'
      ).dependencies.map((item) => item.kind)
    ).toEqual(['runtime-file', 'country-mmdb'])
    expect(
      collectRuntimeDependencies('dns: {fallback: [1.1.1.1], fallback-filter: {geoip: false}}')
        .dependencies
    ).toEqual([])
  })
  it('rebases file references by digest, preserves all ordinary settings, and detects snapshot or cache mutation', async () => {
    await fixture(async (stores) => {
      const original = JSON.stringify({
        proxies: [
          {
            name: 'N',
            type: 'ssh',
            server: '127.0.0.1',
            port: 22,
            'private-key': '/PRIVATE/original'
          }
        ],
        port: 18080,
        dns: { enable: false },
        rules: ['MATCH,REJECT']
      })
      const dependency = collectRuntimeDependencies(original).dependencies[0]
      const resource = await stores.resources.save(
        { name: 'Private key', kind: 'runtime-file', behavior: null, selector: '' },
        Buffer.from('PRIVATE-KEY-CONTENT')
      )
      const plan = await bindRuntimeResources(
        original,
        [{ dependencyId: dependency.id, selection: selected(resource) }],
        stores
      )
      expect(plan.unresolved).toEqual([])
      expect(plan.configuration).toMatchObject({
        port: 18080,
        proxies: [{ 'private-key': `relay-files/${resource.sha256}.bin` }]
      })
      expect(JSON.stringify(plan.configuration)).not.toContain('/PRIVATE/original')
      expect(plan.assets[0].bytes.toString()).toBe('PRIVATE-KEY-CONTENT')
      await plan.recheck()
      plan.configuration.port = 18081
      await expect(plan.recheck()).rejects.toThrow('已变化')
      plan.configuration.port = 18080
      plan.assets[0].bytes[0] ^= 1
      await expect(plan.recheck()).rejects.toThrow('正文已变化')
    })
  })
  it('discovers files introduced by the selected provider cache and retains override/filter/health boundaries', async () => {
    await fixture(async (stores) => {
      const source = JSON.stringify({
        'proxy-providers': {
          'P/name': {
            type: 'http',
            url: 'https://PRIVATE.invalid/sub',
            header: { Authorization: ['PRIVATE'] },
            'health-check': { enable: false },
            filter: 'N',
            override: { 'additional-prefix': 'Prefix' },
            interval: 3600
          }
        }
      })
      const first = collectRuntimeDependencies(source).dependencies[0]
      const provider = await stores.providers.save(
        'Cache',
        'proxies: [{name: N, type: ssh, server: 127.0.0.1, port: 22, private-key: /PRIVATE/key}]'
      )
      const stage = await bindRuntimeResources(
        source,
        [{ dependencyId: first.id, selection: selected(provider) }],
        stores
      )
      expect(stage.unresolved).toHaveLength(1)
      expect(stage.unresolved[0].kind).toBe('runtime-file')
      expect(stage.configuration['proxy-providers']).toMatchObject({
        'P/name': {
          type: 'inline',
          override: { 'additional-prefix': 'Prefix' },
          filter: 'N',
          'health-check': { enable: false }
        }
      })
      expect(JSON.stringify(stage.configuration)).not.toContain('Authorization')
      const key = await stores.resources.save(
        { name: 'Key', kind: 'runtime-file', behavior: null, selector: '' },
        Buffer.from('key')
      )
      const ready = await bindRuntimeResources(
        source,
        [
          { dependencyId: first.id, selection: selected(provider) },
          { dependencyId: stage.unresolved[0].id, selection: selected(key) }
        ],
        stores
      )
      expect(ready.unresolved).toEqual([])
      expect(ready.pins.map((item) => item.namespace).sort()).toEqual(['provider', 'resource'])
      await ready.recheck()
    })
  })
  it('finds additional geography in cached classical rules, requires each database, and pins metadata revisions', async () => {
    await fixture(async (stores) => {
      const source = JSON.stringify({
        'rule-providers': {
          R: { type: 'file', path: '/PRIVATE/rules', behavior: 'classical', format: 'text' }
        },
        rules: ['RULE-SET,R,REJECT', 'MATCH,REJECT']
      })
      const dependency = collectRuntimeDependencies(source).dependencies[0]
      const rules = await stores.resources.save(
        { name: 'Rules', kind: 'rule-text', behavior: 'classical', selector: '' },
        Buffer.from('DOMAIN,fixture.invalid\nGEOIP,CN\n')
      )
      const binding = { dependencyId: dependency.id, selection: selected(rules) }
      const partial = await bindRuntimeResources(source, [binding], stores)
      expect(partial.unresolved.map((item) => item.kind)).toEqual(['country-mmdb'])
      const database = await stores.resources.save(
        { name: 'Geo', kind: 'country-mmdb', behavior: null, selector: 'CN' },
        Buffer.from('fixture bytes, not a validated database')
      )
      const complete = await bindRuntimeResources(
        source,
        [binding, { dependencyId: partial.unresolved[0].id, selection: selected(database) }],
        stores
      )
      expect(complete.unresolved).toEqual([])
      expect(complete.assets.map((item) => item.path)).toContain('Country.mmdb')
      expect(complete.assets.find((item) => item.expectedRules)?.expectedRules).toBe(2)
      await complete.recheck()
      await writeFile(join(stores.resources.directory, database.id, 'resource.bin'), 'changed')
      await expect(complete.recheck()).rejects.toThrow()
    })
  })
  it('discovers mixed-case ASN in cached classical entries and preserves the original cached body', async () => {
    await fixture(async (stores) => {
      const source = JSON.stringify({
          'rule-providers': {
            R: { type: 'file', path: '/PRIVATE/rules', behavior: 'classical', format: 'text' }
          },
          rules: ['RULE-SET,R,REJECT', 'MATCH,REJECT']
        }),
        dependency = collectRuntimeDependencies(source).dependencies[0],
        body = Buffer.from('sRc-iP-aSn,64512\n'),
        rules = await stores.resources.save(
          {
            name: 'Case-preserving classical cache',
            kind: 'rule-text',
            behavior: 'classical',
            selector: ''
          },
          body
        ),
        binding = { dependencyId: dependency.id, selection: selected(rules) },
        partial = await bindRuntimeResources(source, [binding], stores)
      expect(partial.unresolved.map((item) => item.kind)).toEqual(['asn-mmdb'])
      const database = await stores.resources.save(
          { name: 'ASN binding fixture', kind: 'asn-mmdb', behavior: null, selector: '64512' },
          Buffer.from('binding bytes, not a semantically validated database')
        ),
        complete = await bindRuntimeResources(
          source,
          [binding, { dependencyId: partial.unresolved[0].id, selection: selected(database) }],
          stores
        )
      expect(complete.unresolved).toEqual([])
      expect(complete.assets.map((asset) => asset.path)).toContain('ASN.mmdb')
      expect(complete.assets.find((asset) => asset.expectedRules)?.bytes).toEqual(body)
      expect((await stores.resources.read(selected(rules))).bytes).toEqual(body)
      await complete.recheck()
    })
  })
  it('rejects wrong-purpose, duplicate, extra and stale reference bindings instead of adopting arbitrary paths', async () => {
    await fixture(async (stores) => {
      const source = 'tls: {certificate: /PRIVATE/cert}',
        dependency = collectRuntimeDependencies(source).dependencies[0]
      const resource = await stores.resources.save(
        { name: 'Rules', kind: 'rule-text', behavior: 'domain', selector: '' },
        Buffer.from('fixture.invalid')
      )
      const binding = { dependencyId: dependency.id, selection: selected(resource) }
      await expect(bindRuntimeResources(source, [binding], stores)).rejects.toThrow('用途')
      await expect(bindRuntimeResources(source, [binding, binding], stores)).rejects.toThrow('重复')
      await expect(bindRuntimeResources('{}', [binding], stores)).rejects.toThrow('不属于')
      await expect(
        bindRuntimeResources('tls: {certificate: /PRIVATE/new}', [binding], stores)
      ).rejects.toThrow('不属于')
    })
  })
  it('never interprets an opaque runtime file as ASN or reports it accepted by a standalone core check', async () => {
    const descriptor = resourceDescriptor({
        name: 'File',
        kind: 'runtime-file',
        behavior: null,
        selector: ''
      }),
      bytes = Buffer.from('not a database')
    const result = await checkResourceWithCore('/PRIVATE/not-opened', {
      descriptor,
      bytes,
      sha256: resourceHash(bytes)
    })
    expect(result.status).toBe('requiresResources')
    expect(result.coreVersion).toBeUndefined()
    expect(() => resourceDescriptor({ ...descriptor, selector: 'CN' })).toThrow()
  })
})
