import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { ProfileStore } from '../profiles/store'
import { ResourceStore } from '../resources/store'
import { profileHash } from '../profiles/source'
import { createLocalProxyService } from '../core/local-proxy-service'
import { localProxyConfiguration } from '../core/local-proxy-runtime'
import { ownedCoreConfiguration } from '../core/owned-runtime'
import { isolatedProbeConfiguration } from '../network-info/probe-configuration'
import { createIsolatedProbes } from '../network-info/probes'
import type { GeoResourceKind } from '../../../shared/relay/geo-origins'
import { ConfigurationEditStore } from './edit-store'
import { createConfigurationEditService, MissingRuntimeGeoDataError } from './edit-service'
import { createCompleteConfigurationService } from './service'
import type { DefaultGeoResourceBinding } from './bindings'

const fixtureProfile = JSON.stringify({
  proxies: [{ name: 'NodeA', type: 'http', server: '127.0.0.1', port: 1 }],
  'proxy-groups': [{ name: 'G', type: 'select', proxies: ['NodeA'] }],
  rules: ['MATCH,G']
})

const isolatedDelayProfile = JSON.stringify({
  proxies: [{ name: 'NodeA', type: 'http', server: '93.184.216.34', port: 8080 }],
  'proxy-groups': [{ name: 'G', type: 'select', proxies: ['NodeA'] }],
  dns: { enable: true, nameserver: ['tls://1.1.1.1'], 'respect-rules': false },
  rules: ['MATCH,G']
})

describe('ConfigurationEditStore persistence', () => {
  it('round-trips a saved document and reports a revision', async () => {
    const home = await mkdtemp('/private/tmp/relay-edit-store-')
    const store = new ConfigurationEditStore({ stateRoot: home })
    const initial = await store.read()
    expect(initial.exists).toBe(false)
    const saved = await store.save({
      globalOverrides: [{ id: 'o', kind: 'yaml', content: 'sniffer:\n  enable: true\n' }],
      profileOverrides: [],
      controlled: { sniffer: { enable: true } },
      controlSniff: true
    })
    expect(saved.exists).toBe(true)
    expect(saved.revision).toHaveLength(64)
    const reread = await store.read()
    expect(reread.exists).toBe(true)
    expect(reread.document.globalOverrides[0].id).toBe('o')
    expect(reread.revision).toBe(saved.revision)
    await rm(home, { recursive: true, force: true })
  })
  it('rejects a malformed persisted document', async () => {
    const home = await mkdtemp('/private/tmp/relay-edit-store-bad-')
    const store = new ConfigurationEditStore({ stateRoot: home })
    await store.save({
      globalOverrides: [],
      profileOverrides: [],
      controlled: {}
    })
    // Tamper with the file to produce an invalid document.
    const { writeFile } = await import('fs/promises')
    await writeFile(join(home, 'Configuration', 'configuration-edit.json'), '{not json')
    await expect(store.read()).rejects.toThrow('读取失败')
    await rm(home, { recursive: true, force: true })
  })
})

describe('configuration edit service preview', () => {
  it('applies a global override and rule patch at the fixed merge priority', async () => {
    const home = await mkdtemp('/private/tmp/relay-edit-svc-')
    const context = { home, stateRoot: join(home, 'Library/Application Support/Relay') }
    const profiles = new ProfileStore(context)
    const saved = await profiles.save('Edit', fixtureProfile)
    const store = new ConfigurationEditStore(context)
    const service = createConfigurationEditService({ store, profiles })
    const preview = await service.preview({
      profile: { id: saved.id, sha256: saved.sha256 },
      globalOverrides: [{ id: 'sniff', kind: 'yaml', content: 'sniffer:\n  enable: true\n' }],
      profileOverrides: [],
      rulePatch: { prepend: ['DOMAIN,example.com,G'] },
      controlled: {},
      controlSniff: true
    })
    expect(preview.order.length).toBeGreaterThan(0)
    expect((preview.configuration as Record<string, unknown>).sniffer).toEqual({ enable: true })
    const rules = (preview.configuration as Record<string, unknown>).rules as string[]
    expect(rules[0]).toBe('DOMAIN,example.com,G')
    await rm(home, { recursive: true, force: true })
  })
  it('optionsFor produces the RuntimeMergeOptions sourced from the persisted document', async () => {
    const home = await mkdtemp('/private/tmp/relay-edit-opts-')
    const context = { home, stateRoot: join(home, 'Library/Application Support/Relay') }
    const profiles = new ProfileStore(context)
    const saved = await profiles.save('Edit', fixtureProfile)
    const store = new ConfigurationEditStore(context)
    const service = createConfigurationEditService({ store, profiles })
    await service.save({
      globalOverrides: [{ id: 'g', kind: 'yaml', content: 'a: 1' }],
      profileOverrides: [],
      controlled: {},
      controlDns: true
    })
    const opts = await service.optionsFor({ id: saved.id, sha256: saved.sha256 })
    expect(opts.options.globalOverrides[0].id).toBe('g')
    expect(opts.options.controlDns).toBe(true)
    await rm(home, { recursive: true, force: true })
  })
})

async function runtimeFixture(
  run: (context: {
    profiles: ProfileStore
    store: ConfigurationEditStore
    selection: { id: string; sha256: string }
    home: string
  }) => Promise<void>
): Promise<void> {
  const home = await mkdtemp('/private/tmp/relay-edit-runtime-')
  try {
    const context = { home, stateRoot: join(home, 'Library/Application Support/Relay') }
    const profiles = new ProfileStore(context)
    const profile = await profiles.save('Runtime', fixtureProfile)
    await run({
      home,
      profiles,
      store: new ConfigurationEditStore(context),
      selection: { id: profile.id, sha256: profile.sha256 }
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

describe('Persisted edits used by isolated delay preparation', () => {
  it('exposes only fixed missing-database labels in the actionable HTTP error', async () => {
    const privateReference = 'https://private.invalid/database?token=secret'
    const error = new MissingRuntimeGeoDataError([
      'country-mmdb',
      privateReference,
      'geosite-dat',
      'country-mmdb'
    ])
    expect(error.message).toBe(
      'HTTP 地理规则的本地数据库尚未齐全（Country.mmdb、GeoSite.dat）；请在“外部资源”中同步或导入对应地理数据库；不会自动下载。'
    )
    expect(JSON.stringify(error)).not.toContain(privateReference)
    await runtimeFixture(async ({ profiles, store }) => {
      const saved = await profiles.save(
        'Requires local database',
        JSON.stringify({
          ...JSON.parse(isolatedDelayProfile),
          rules: ['GEOIP,CN,DIRECT', 'MATCH,G']
        })
      )
      const editor = createConfigurationEditService({ profiles, store })
      await expect(
        editor.readRuntimeProfile({ id: saved.id, sha256: saved.sha256 }, 'profile')
      ).rejects.toThrow(MissingRuntimeGeoDataError)
    })
  })
  it.each(['nodeDelay', 'groupDelay'] as const)(
    'prepares %s without databases used only by the saved rules and DNS',
    async (kind) => {
      await runtimeFixture(async ({ home, profiles, store }) => {
        const source = JSON.stringify({
          ...JSON.parse(isolatedDelayProfile),
          rules: ['GEOSITE,cn,DIRECT', 'GEOIP,CN,DIRECT', 'MATCH,G'],
          dns: {
            enable: true,
            nameserver: ['tls://1.1.1.1'],
            'nameserver-policy': { 'geosite:cn': ['tls://1.1.1.1'] }
          }
        })
        const saved = await profiles.save('Saved geography', source)
        const selection = { id: saved.id, sha256: saved.sha256 }
        const original = await profiles.read(selection)
        const context = { home, stateRoot: join(home, 'Library/Application Support/Relay') }
        const defaultGeoResource = vi.fn(async () => undefined)
        const editor = createConfigurationEditService({
          profiles,
          store,
          runtimeResources: new ResourceStore(context),
          defaultGeoResource
        })
        const resourceRoot = vi.fn(async () => '/unused-fixture-core')
        const independentNetwork = vi.fn(async () => 'unused-fixture-network')
        const confirm = vi.fn(async () => true)
        const probes = createIsolatedProbes({
          context,
          readProfile: (selected) => editor.readIsolatedProbeProfile(selected),
          resourceRoot,
          independentNetwork,
          confirm
        })
        const request = {
          profile: selection,
          target: kind === 'nodeDelay' ? 'NodeA' : 'G',
          kind,
          provider: 'ip.sb'
        }
        for (const edited of [false, true]) {
          if (edited)
            await editor.save({
              globalOverrides: [{ id: 'delay', kind: 'yaml', content: 'unified-delay: true\n' }],
              profileOverrides: [],
              controlled: {}
            })
          await expect(probes.prepare(request, () => {})).resolves.toMatchObject({
            kind,
            nodes: ['NodeA'],
            sourceSHA256: selection.sha256
          })
          const effective = await editor.readIsolatedProbeProfile(selection)
          const projected = JSON.parse(
            isolatedProbeConfiguration(effective.text, request, 49152).configuration
          )
          expect(projected.rules).toEqual(['MATCH,__RELAY_ISOLATED_PROBE__'])
          expect(projected.dns).toEqual({ enable: false })
          expect(projected['unified-delay']).toBe(edited)
          expect(JSON.parse(effective.text).rules).toEqual(JSON.parse(source).rules)
          expect(defaultGeoResource).not.toHaveBeenCalled()
        }
        // The HTTP runtime must still require its routing databases, including
        // when the shared composed-source cache was first populated by a probe.
        await expect(editor.readRuntimeProfile(selection, 'profile')).rejects.toThrow(
          MissingRuntimeGeoDataError
        )
        expect(resourceRoot).not.toHaveBeenCalled()
        expect(independentNetwork).not.toHaveBeenCalled()
        expect(confirm).not.toHaveBeenCalled()
        expect(await profiles.read(selection)).toEqual(original)
      })
    }
  )
  it('uses effective unified-delay true and false without changing the raw subscription', async () => {
    await runtimeFixture(async ({ profiles, store }) => {
      const saved = await profiles.save('Isolated delay', isolatedDelayProfile)
      const selection = { id: saved.id, sha256: saved.sha256 }
      const original = await profiles.read(selection)
      expect(JSON.parse(original.text)['unified-delay']).toBeUndefined()
      const editor = createConfigurationEditService({ profiles, store })
      let previousRevision = original.revision
      for (const enabled of [true, false]) {
        await editor.save({
          globalOverrides: [{ id: 'delay', kind: 'yaml', content: `unified-delay: ${enabled}\n` }],
          profileOverrides: [],
          controlled: {}
        })
        const effective = await editor.readIsolatedProbeProfile(selection)
        const built = isolatedProbeConfiguration(
          effective.text,
          { kind: 'nodeDelay', target: 'NodeA' },
          49152
        )
        expect(JSON.parse(built.configuration)['unified-delay']).toBe(enabled)
        expect(
          JSON.parse(localProxyConfiguration(effective.text, 18191, 'profile').configuration)[
            'unified-delay'
          ]
        ).toBe(enabled)
        expect(effective.profile.id).toBe(selection.id)
        expect(effective.profile.sha256).toBe(selection.sha256)
        expect(effective.revision).not.toBe(previousRevision)
        expect(await profiles.read(selection)).toEqual(original)
        previousRevision = effective.revision
      }
    })
  })
  it('rejects prepared delay evidence after an override revision changes before any runtime starts', async () => {
    await runtimeFixture(async ({ home, profiles, store }) => {
      const saved = await profiles.save('Isolated delay', isolatedDelayProfile)
      const selection = { id: saved.id, sha256: saved.sha256 }
      const editor = createConfigurationEditService({ profiles, store })
      const saveDelay = (enabled: boolean) =>
        editor.save({
          globalOverrides: [{ id: 'delay', kind: 'yaml', content: `unified-delay: ${enabled}\n` }],
          profileOverrides: [],
          controlled: {}
        })
      await saveDelay(true)
      const original = await profiles.read(selection)
      const resourceRoot = vi.fn(async (): Promise<string> => {
        throw Error('Fixture forbids runtime startup')
      })
      const probes = createIsolatedProbes({
        context: { home, stateRoot: join(home, 'Library/Application Support/Relay') },
        readProfile: (selected) => editor.readIsolatedProbeProfile(selected),
        resourceRoot,
        confirm: async () => true,
        independentNetwork: async () => 'synthetic-network-snapshot'
      })
      const plan = await probes.prepare(
        { profile: selection, target: 'NodeA', kind: 'nodeDelay', provider: 'ip.sb' },
        () => {}
      )
      expect(plan.sourceSHA256).toBe(selection.sha256)
      await saveDelay(false)
      await expect(probes.run({ evidenceId: plan.evidenceId }, () => {})).rejects.toThrow(
        '保存的配置在确认期间变化'
      )
      expect(resourceRoot).not.toHaveBeenCalled()
      expect(await profiles.read(selection)).toEqual(original)
      expect(probes.state()).toMatchObject({
        pending: false,
        uncertain: false,
        preparedId: undefined
      })
    })
  })
})

describe('Persisted edits used by owned HTTP preparation', () => {
  it('selects only the bound source rule patch in preview, runtime reads and complete preparation', async () => {
    await runtimeFixture(async ({ profiles, store, selection }) => {
      const second = await profiles.save('Unchanged', fixtureProfile),
        prepare = vi.fn(async (_request: unknown) => {
          throw new Error('fixture complete boundary')
        }),
        service = createConfigurationEditService({ profiles, store, prepare }),
        saved = await service.save({
          globalOverrides: [],
          profileOverrides: [],
          controlled: {},
          rulePatch: { prepend: ['DOMAIN,shared.test,G'] },
          profileRulePatchSets: [
            { profileId: selection.id, rulePatch: { prepend: ['DOMAIN,migrated.test,G'] } }
          ]
        })
      expect(JSON.parse((await service.readRuntimeProfile(selection)).text).rules).toEqual([
        'DOMAIN,migrated.test,G',
        'DOMAIN,shared.test,G',
        'MATCH,G'
      ])
      expect(
        JSON.parse(
          (await service.readRuntimeProfile({ id: second.id, sha256: second.sha256 })).text
        ).rules
      ).toEqual(['DOMAIN,shared.test,G', 'MATCH,G'])
      const preview = await service.preview({ ...saved.document, profile: selection })
      expect(preview.configuration.rules).toEqual([
        'DOMAIN,migrated.test,G',
        'DOMAIN,shared.test,G',
        'MATCH,G'
      ])
      await expect(
        service.prepare({ profile: selection, bindings: [], revision: saved.revision })
      ).rejects.toThrow('fixture complete boundary')
      expect(prepare).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            profileRulePatch: { prepend: ['DOMAIN,migrated.test,G'] }
          })
        }),
        expect.any(Function)
      )
    })
  })
  it('persists independent source libraries and uses only the selected list in preview and runtime reads', async () => {
    await runtimeFixture(async ({ profiles, store, selection, home }) => {
      const second = await profiles.save('Second', fixtureProfile)
      const third = await profiles.save('Unbound', fixtureProfile)
      const service = createConfigurationEditService({ profiles, store })
      const saved = await service.save({
        globalOverrides: [{ id: 'global', kind: 'yaml', content: 'sniffer:\n  enable: false' }],
        profileOverrides: [],
        profileOverrideSets: [
          {
            profileId: selection.id,
            overrides: [
              {
                id: 'same-local-id',
                kind: 'yaml',
                content: 'sniffer:\n  enable: true\n  skip-domain: [first.example]'
              }
            ]
          },
          {
            profileId: second.id,
            overrides: [
              {
                id: 'same-local-id',
                kind: 'yaml',
                content: 'sniffer:\n  enable: false\n  skip-domain: [second.example]'
              }
            ]
          }
        ],
        controlled: {}
      })
      const reread = await new ConfigurationEditStore({
        stateRoot: join(home, 'Library/Application Support/Relay')
      }).read()
      expect(reread).toEqual(saved)
      for (const [profile, expected] of [
        [selection, ['first.example']],
        [{ id: second.id, sha256: second.sha256 }, ['second.example']],
        [{ id: third.id, sha256: third.sha256 }, undefined]
      ] as const) {
        const preview = await service.preview({ profile, ...reread.document })
        expect((preview.configuration.sniffer as Record<string, unknown>)['skip-domain']).toEqual(
          expected
        )
        const runtime = await service.readRuntimeProfile(profile)
        expect(JSON.parse(runtime.text)).toEqual(preview.configuration)
        expect(runtime.profile.id).toBe(profile.id)
        expect(runtime.profile.sha256).toBe(profile.sha256)
        expect((await service.optionsFor(profile)).options.profileOverrides).toHaveLength(
          expected ? 1 : 0
        )
      }
    })
  })
  it('preserves the original source contract while carrying edited rules and sniffer into a bound runtime revision', async () => {
    await runtimeFixture(async ({ profiles, store, selection }) => {
      const service = createConfigurationEditService({ profiles, store })
      const original = await profiles.read(selection)
      expect(await service.readRuntimeProfile(selection)).toEqual(original)
      await service.save({
        globalOverrides: [],
        profileOverrides: [],
        rulePatch: { prepend: ['DOMAIN,example.com,G'] },
        controlled: { sniffer: { enable: true, sniff: { TLS: { ports: ['443'] } } } },
        controlSniff: true
      })
      const edited = await service.readRuntimeProfile(selection)
      expect(edited.profile).toEqual(original.profile)
      expect(edited.revision).not.toBe(original.revision)
      expect(JSON.parse(edited.text).rules[0]).toBe('DOMAIN,example.com,G')
      expect(JSON.parse(edited.text).sniffer.enable).toBe(true)
      expect(await profiles.read(selection)).toEqual(original)
      await service.clear()
      expect((await service.readRuntimeProfile(selection)).revision).toBe(original.revision)
    })
  })
  it('keeps TUN settings separate while refusing unknown edits and DNS changes without resolver mode', async () => {
    await runtimeFixture(async ({ profiles, store, selection }) => {
      const service = createConfigurationEditService({ profiles, store })
      await service.save({
        globalOverrides: [{ id: 'tun', kind: 'yaml', content: 'tun:\n  enable: true' }],
        profileOverrides: [],
        controlled: {}
      })
      const tunSource = await service.readRuntimeProfile(selection)
      expect(JSON.parse(tunSource.text).tun.enable).toBe(true)
      expect(JSON.parse(localProxyConfiguration(tunSource.text, 18191).configuration).tun).toEqual({
        enable: false
      })
      await service.save({
        globalOverrides: [{ id: 'unknown', kind: 'yaml', content: 'not-supported: true' }],
        profileOverrides: [],
        controlled: {}
      })
      await expect(service.readRuntimeProfile(selection)).rejects.toThrow('未支持的字段')
      await service.save({
        globalOverrides: [],
        profileOverrides: [],
        controlled: { hosts: { 'example.com': '192.0.2.1' } },
        controlDns: true
      })
      await expect(service.readRuntimeProfile(selection)).rejects.toThrow('DNS／hosts模式')
      expect(
        JSON.parse((await service.readRuntimeProfile(selection, 'profile')).text).hosts
      ).toEqual({ 'example.com': '192.0.2.1' })
    })
  })
  it('only applies profile overrides to their bound source', async () => {
    await runtimeFixture(async ({ profiles, store, selection }) => {
      const second = await profiles.save('Other', fixtureProfile)
      const service = createConfigurationEditService({ profiles, store })
      await service.save({
        globalOverrides: [],
        profileOverrides: [{ id: 'local', kind: 'yaml', content: 'sniffer:\n  enable: true' }],
        profileId: selection.id,
        controlled: {}
      })
      expect(JSON.parse((await service.readRuntimeProfile(selection)).text).sniffer.enable).toBe(
        true
      )
      expect(
        JSON.parse(
          (await service.readRuntimeProfile({ id: second.id, sha256: second.sha256 })).text
        ).sniffer
      ).toBeUndefined()
    })
  })
  it('does not rerun prepared JS output between preparation and start while revisions remain identical', async () => {
    await runtimeFixture(async ({ profiles, store, selection }) => {
      let runs = 0
      const service = createConfigurationEditService({
        profiles,
        store,
        script: async (_script, configuration) => {
          runs++
          return { configuration: { ...configuration, sniffer: { enable: runs === 1 } }, logs: [] }
        }
      })
      await service.save({
        globalOverrides: [{ id: 'js', kind: 'js', content: 'main' }],
        profileOverrides: [],
        controlled: {}
      })
      const first = await service.readRuntimeProfile(selection)
      expect(await service.readRuntimeProfile(selection)).toEqual(first)
      expect(runs).toBe(1)
    })
  })
  it('shares one script result across concurrent runtime reads of the same revision', async () => {
    await runtimeFixture(async ({ profiles, store, selection }) => {
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let runs = 0
      const service = createConfigurationEditService({
        profiles,
        store,
        script: async (_script, configuration) => {
          const run = ++runs
          started.resolve()
          await release.promise
          return { configuration: { ...configuration, sniffer: { enable: run === 1 } }, logs: [] }
        }
      })
      await service.save({
        globalOverrides: [{ id: 'js', kind: 'js', content: 'main' }],
        profileOverrides: [],
        controlled: {}
      })
      const first = service.readRuntimeProfile(selection)
      const second = service.readRuntimeProfile(selection)
      await started.promise
      release.resolve()
      const results = await Promise.all([first, second])
      expect(results[0]).toEqual(results[1])
      expect(await service.readRuntimeProfile(selection)).toEqual(results[0])
      expect(runs).toBe(1)
    })
  })
  it('rejects an invalidated in-flight script result instead of caching it again', async () => {
    await runtimeFixture(async ({ profiles, store, selection }) => {
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let runs = 0
      const service = createConfigurationEditService({
        profiles,
        store,
        script: async (_script, configuration) => {
          const run = ++runs
          started.resolve()
          await release.promise
          return { configuration: { ...configuration, sniffer: { enable: run === 1 } }, logs: [] }
        }
      })
      await service.save({
        globalOverrides: [{ id: 'js', kind: 'js', content: 'main' }],
        profileOverrides: [],
        controlled: {}
      })
      const stale = service.readRuntimeProfile(selection)
      const rejected = expect(stale).rejects.toThrow('已失效')
      await started.promise
      service.invalidateRuntimeCache()
      release.resolve()
      await rejected
      const fresh = await service.readRuntimeProfile(selection)
      expect(JSON.parse(fresh.text).sniffer.enable).toBe(false)
      expect(await service.readRuntimeProfile(selection)).toEqual(fresh)
      expect(runs).toBe(2)
    })
  })
  it('allows the same revision to retry after script generation fails', async () => {
    await runtimeFixture(async ({ profiles, store, selection }) => {
      const script = vi
        .fn()
        .mockRejectedValueOnce(new Error('worker failed'))
        .mockImplementation(async (_script, configuration) => ({ configuration, logs: [] }))
      const service = createConfigurationEditService({ profiles, store, script })
      await service.save({
        globalOverrides: [{ id: 'js', kind: 'js', content: 'main' }],
        profileOverrides: [],
        controlled: {}
      })
      await expect(service.readRuntimeProfile(selection)).rejects.toThrow('worker failed')
      const retried = await service.readRuntimeProfile(selection)
      expect(await service.readRuntimeProfile(selection)).toEqual(retried)
      expect(script).toHaveBeenCalledTimes(2)
    })
  })
})

describe('Saved edit proof through preparation, checks and activation', () => {
  it('uses the selected source list in complete preparation and revokes the document proof after another source edit', async () => {
    await runtimeFixture(async ({ home, profiles, store, selection }) => {
      const other = await profiles.save('Other', fixtureProfile)
      const check = vi.fn(async (source: string) => ({
        status: 'passed' as const,
        scope: 'complete-parser' as const,
        configurationSHA256: profileHash(source),
        coreVersion: 'v1.19.33',
        active: false as const,
        runtimeAccepted: false as const,
        warnings: []
      }))
      const complete = createCompleteConfigurationService({
        profiles,
        providers: profiles,
        resources: new ResourceStore({
          home,
          stateRoot: join(home, 'Library/Application Support/Relay')
        }),
        script: vi.fn(),
        check
      })
      const editor = createConfigurationEditService({
        profiles,
        store,
        prepare: (request, recheck) => complete.prepare(request, recheck)
      })
      const document = {
        globalOverrides: [],
        profileOverrides: [],
        controlled: {},
        profileOverrideSets: [
          {
            profileId: selection.id,
            overrides: [{ id: 'source', kind: 'yaml', content: 'sniffer:\n  enable: true' }]
          },
          {
            profileId: other.id,
            overrides: [{ id: 'source', kind: 'yaml', content: 'sniffer:\n  enable: false' }]
          }
        ]
      }
      const saved = await editor.save(document)
      const first = await editor.prepare({
        profile: selection,
        revision: saved.revision,
        bindings: []
      })
      expect((await complete.check({ evidenceId: first.evidenceId })).status).toBe('passed')
      expect(JSON.parse(check.mock.calls[0][0]).sniffer.enable).toBe(true)
      const next = await editor.prepare({
        profile: { id: other.id, sha256: other.sha256 },
        revision: saved.revision,
        bindings: []
      })
      expect((await complete.check({ evidenceId: next.evidenceId })).status).toBe('passed')
      expect(JSON.parse(check.mock.calls[1][0]).sniffer.enable).toBe(false)
      const checked = await complete.takeChecked({ evidenceId: next.evidenceId })
      await editor.save({ ...document, profileOverrideSets: [document.profileOverrideSets[0]] })
      await expect(checked.recheck()).rejects.toThrow('版本已变化')
    })
  })
  it('rejects start when saved edits change while native confirmation is open', async () => {
    await runtimeFixture(async ({ profiles, store, selection }) => {
      const editor = createConfigurationEditService({ profiles, store })
      const document = {
        globalOverrides: [],
        profileOverrides: [],
        controlled: { sniffer: { enable: true } }
      }
      await editor.save(document)
      const start = vi.fn(async () => {
        throw new Error('must not start')
      })
      const acquire = vi.fn(async () => {
        throw new Error('must not acquire')
      })
      const local = createLocalProxyService({
        read: (selected, mode) => editor.readRuntimeProfile(selected, mode),
        inspect: async () => ({ mode: 'rule', revision: 'a'.repeat(64), lease: 'missing' }),
        resources: async () => ({
          executable: '/fixture/mihomo',
          version: 'v1.19.33',
          architecture: 'arm64',
          sha256: 'b'.repeat(64)
        }),
        portAvailable: async () => true,
        acquire,
        start,
        confirmStart: async () => {
          await editor.save({ ...document, controlled: { sniffer: { enable: false } } })
          return true
        },
        confirmStop: async () => false
      })
      const plan = await local.prepare({ profile: selection, httpPort: 18191 })
      expect(plan.canStart).toBe(true)
      expect((await local.action({ action: 'start', evidenceId: plan.evidenceId })).status).toBe(
        'failed'
      )
      expect(start).not.toHaveBeenCalled()
      expect(acquire).not.toHaveBeenCalled()
    })
  })
  it('binds saved edits to the real complete candidate and invalidates checks after a later save', async () => {
    await runtimeFixture(async ({ home, profiles, store, selection }) => {
      const check = vi.fn(async (source: string) => ({
        status: 'passed' as const,
        scope: 'complete-parser' as const,
        configurationSHA256: profileHash(source),
        coreVersion: 'v1.19.33',
        active: false as const,
        runtimeAccepted: false as const,
        warnings: []
      }))
      const complete = createCompleteConfigurationService({
        profiles,
        providers: profiles,
        resources: new ResourceStore({
          home,
          stateRoot: join(home, 'Library/Application Support/Relay')
        }),
        script: vi.fn(),
        check
      })
      const editor = createConfigurationEditService({
        profiles,
        store,
        prepare: (request, recheck) => complete.prepare(request, recheck)
      })
      const saved = await editor.save({
        globalOverrides: [],
        profileOverrides: [],
        controlled: { sniffer: { enable: true } }
      })
      const plan = await editor.prepare({
        profile: selection,
        revision: saved.revision,
        bindings: []
      })
      expect((await complete.check({ evidenceId: plan.evidenceId })).status).toBe('passed')
      expect(JSON.parse(check.mock.calls[0][0]).sniffer.enable).toBe(true)
      const handoff = await complete.takeChecked({ evidenceId: plan.evidenceId })
      await editor.clear()
      await expect(handoff.recheck()).rejects.toThrow('版本已变化')
      await expect(
        editor.prepare({ profile: selection, revision: saved.revision, bindings: [] })
      ).rejects.toThrow('版本已变化')
      const next = await editor.save({ globalOverrides: [], profileOverrides: [], controlled: {} })
      const pending = await editor.prepare({
        profile: selection,
        revision: next.revision,
        bindings: []
      })
      await editor.clear()
      expect((await complete.check({ evidenceId: pending.evidenceId })).status).toBe('unavailable')
      expect(check).toHaveBeenCalledTimes(1)
    })
  })
})

describe('Configuration editor operation ownership', () => {
  it('keeps save busy through persistence and releases idle waiters after a failure', async () => {
    await runtimeFixture(async ({ profiles, store }) => {
      let reject!: (error: Error) => void
      vi.spyOn(store, 'save').mockImplementationOnce(
        () =>
          new Promise((_resolve, fail) => {
            reject = fail
          })
      )
      const editor = createConfigurationEditService({ profiles, store })
      const saving = editor.save({ globalOverrides: [], profileOverrides: [], controlled: {} })
      const failed = expect(saving).rejects.toThrow('persistence failed')
      expect(editor.isBusy()).toBe(true)
      let idle = false
      const waiting = editor.whenIdle().then(() => {
        idle = true
      })
      await expect(editor.clear()).rejects.toThrow('请等待')
      await expect(editor.preview({})).rejects.toThrow('请等待')
      await expect(editor.prepare({})).rejects.toThrow('请等待')
      expect(idle).toBe(false)
      reject(new Error('persistence failed'))
      await failed
      await waiting
      expect(editor.isBusy()).toBe(false)
      expect(idle).toBe(true)
      expect((await editor.read()).exists).toBe(false)
    })
  })
  it('owns the whole native script preview and rejects writes until the worker completes', async () => {
    await runtimeFixture(async ({ profiles, store, selection }) => {
      let release!: () => void
      const started = Promise.withResolvers<void>()
      const editor = createConfigurationEditService({
        profiles,
        store,
        script: async (_script, configuration) => {
          started.resolve()
          await new Promise<void>((resolve) => {
            release = resolve
          })
          return { configuration, logs: [] }
        }
      })
      const preview = editor.preview({
        profile: selection,
        globalOverrides: [{ id: 'js', kind: 'js', content: 'main' }],
        profileOverrides: [],
        controlled: {}
      })
      await started.promise
      const idle = vi.fn()
      const waiting = editor.whenIdle().then(idle)
      await expect(editor.clear()).rejects.toThrow('请等待')
      expect(idle).not.toHaveBeenCalled()
      release()
      await preview
      await waiting
      expect(editor.isBusy()).toBe(false)
    })
  })
  it('owns document read through complete preparation while allowing internal source reads and rechecks', async () => {
    await runtimeFixture(async ({ profiles, store, selection }) => {
      let release!: () => void
      const started = Promise.withResolvers<void>()
      const editor = createConfigurationEditService({
        profiles,
        store,
        prepare: async (_request, recheck) => {
          started.resolve()
          await new Promise<void>((resolve) => {
            release = resolve
          })
          await recheck()
          throw new Error('isolated preparation completed')
        }
      })
      const saved = await editor.save({ globalOverrides: [], profileOverrides: [], controlled: {} })
      const preparing = editor.prepare({
        profile: selection,
        revision: saved.revision,
        bindings: []
      })
      const failed = expect(preparing).rejects.toThrow('isolated preparation completed')
      await started.promise
      const idle = vi.fn()
      const waiting = editor.whenIdle().then(idle)
      await expect(editor.save(saved.document)).rejects.toThrow('请等待')
      expect((await editor.optionsFor(selection)).profileId).toBe(selection.id)
      expect((await editor.readRuntimeProfile(selection)).profile.id).toBe(selection.id)
      expect(idle).not.toHaveBeenCalled()
      release()
      await failed
      await waiting
      expect(editor.isBusy()).toBe(false)
    })
  })
})

describe('Smart collector-only saved profile edits', () => {
  it('allows collector changes for HTTP projection while retaining source identity', async () => {
    await runtimeFixture(async ({ profiles, store, selection }) => {
      const service = createConfigurationEditService({ profiles, store }),
        before = await profiles.read(selection)
      await service.save({
        globalOverrides: [
          { id: 'collector', kind: 'yaml', content: 'profile: {smart-collector-size: 256}' }
        ],
        profileOverrides: [],
        controlled: {}
      })
      const read = await service.readRuntimeProfile(selection)
      expect(JSON.parse(read.text).profile).toEqual({ 'smart-collector-size': 256 })
      expect(read.profile).toEqual(before.profile)
      expect((await profiles.read(selection)).text).toBe(before.text)
    })
  })
  it('validates profile fields while retaining cache preferences for the complete configuration', async () => {
    await runtimeFixture(async ({ profiles, store, selection }) => {
      const service = createConfigurationEditService({ profiles, store })
      for (const content of [
        'profile: {smart-collector-size: 256, unknown: true}',
        'profile: {store-selected: invalid}',
        'profile: {smart-collector-size: 1.5}'
      ]) {
        await service.save({
          globalOverrides: [{ id: 'collector', kind: 'yaml', content }],
          profileOverrides: [],
          controlled: {}
        })
        await expect(service.readRuntimeProfile(selection)).rejects.toThrow()
      }
      await service.save({
        globalOverrides: [
          {
            id: 'cache',
            kind: 'yaml',
            content: 'profile: {store-selected: true, store-fake-ip: true}'
          }
        ],
        profileOverrides: [],
        controlled: {}
      })
      const read = await service.readRuntimeProfile(selection)
      expect(JSON.parse(read.text).profile).toEqual({
        'store-selected': true,
        'store-fake-ip': true
      })
      expect(JSON.parse(localProxyConfiguration(read.text, 18191).configuration).profile).toEqual({
        'store-selected': false,
        'store-fake-ip': false
      })
    })
  })
})

describe('Imported Clash settings through the owned HTTP runtime', () => {
  it('binds stored Geo databases on every read without changing source text or caching mutable bytes', async () => {
    await runtimeFixture(async ({ profiles, store, home }) => {
      const resources = new ResourceStore({
        home,
        stateRoot: join(home, 'Library/Application Support/Relay')
      })
      const source = JSON.stringify({
        ...JSON.parse(fixtureProfile),
        'geodata-mode': true,
        rules: ['GEOSITE,CN,G', 'GEOIP,cn,DIRECT,no-resolve', 'MATCH,G']
      })
      const profile = await profiles.save('Geo source', source)
      const heads = new Map<GeoResourceKind, Awaited<ReturnType<ResourceStore['read']>>>()
      const saveResource = async (kind: 'geoip-dat' | 'geosite-dat', content: string) => {
        const info = await resources.save(
          { name: kind, kind, behavior: null, selector: 'CN' },
          Buffer.from(content)
        )
        heads.set(kind, await resources.read({ id: info.id, sha256: info.sha256 }))
      }
      await saveResource('geoip-dat', 'synthetic IP database')
      await saveResource('geosite-dat', 'synthetic site database')
      let rejectRecheck = false
      const defaultGeoResource = async (
        kind: GeoResourceKind
      ): Promise<DefaultGeoResourceBinding | undefined> => {
        const head = heads.get(kind)
        if (!head) return undefined
        return {
          selection: { id: head.info.id, sha256: head.info.sha256 },
          revision: head.revision,
          recheck: async () => {
            if (rejectRecheck || heads.get(kind) !== head) throw Error('Geo head changed')
          }
        }
      }
      const service = createConfigurationEditService({
        profiles,
        store,
        runtimeResources: resources,
        defaultGeoResource
      })
      const selection = { id: profile.id, sha256: profile.sha256 }
      const first = await service.readRuntimeProfile(selection)
      expect(first.text).toBe(source)
      expect(first.runtimeAssets?.map((asset) => asset.path).sort()).toEqual([
        'GeoIP.dat',
        'GeoSite.dat'
      ])
      const expected = first.runtimeAssets?.[0].bytes.toString()
      first.runtimeAssets?.[0].bytes.fill(0)
      const second = await service.readRuntimeProfile(selection)
      expect(second.revision).toBe(first.revision)
      expect(second.runtimeAssets?.[0].bytes.toString()).toBe(expected)
      await service.save({ globalOverrides: [], profileOverrides: [], controlled: {} })
      const edited = await service.readRuntimeProfile(selection)
      await saveResource('geoip-dat', 'updated synthetic IP database')
      const changed = await service.readRuntimeProfile(selection)
      expect(changed.revision).not.toBe(edited.revision)
      expect(JSON.parse(changed.text).rules).toEqual(JSON.parse(source).rules)
      rejectRecheck = true
      await expect(service.readRuntimeProfile(selection)).rejects.toThrow('Geo head changed')
      rejectRecheck = false
      heads.delete('geosite-dat')
      await expect(service.readRuntimeProfile(selection)).rejects.toThrow('本地数据库尚未齐全')
      expect((await profiles.read(selection)).text).toBe(source)
    })
  })
  it('inherits routing and resolver behavior while keeping Relay listener, TUN and cache ownership', async () => {
    await runtimeFixture(async ({ profiles, store, selection }) => {
      const service = createConfigurationEditService({ profiles, store })
      const original = await profiles.read(selection)
      const settings = {
        mode: 'rule',
        'log-level': 'info',
        'mixed-port': 7890,
        'socks-port': 7891,
        port: 7892,
        'redir-port': 0,
        'tproxy-port': 0,
        'external-controller': '',
        'allow-lan': false,
        'bind-address': '*',
        'lan-allowed-ips': ['0.0.0.0/0', '::/0'],
        'lan-disallowed-ips': [],
        authentication: [],
        'skip-auth-prefixes': ['127.0.0.1/32', '::1/128'],
        'unified-delay': true,
        'find-process-mode': 'strict',
        profile: { 'store-selected': true, 'store-fake-ip': true },
        tun: { enable: false, stack: 'mixed', mtu: 1500, 'auto-route': true },
        'geo-auto-update': false,
        'geo-update-interval': 24,
        'geox-url': { geoip: 'https://example.invalid/geoip.dat' }
      }
      await service.save({
        globalOverrides: [
          { id: 'clash-settings', kind: 'yaml', content: JSON.stringify(settings) }
        ],
        profileOverrides: [],
        controlled: {
          dns: { enable: true, nameserver: ['tls://1.1.1.1'], 'respect-rules': false },
          sniffer: { enable: true, sniff: { TLS: { ports: ['443'] } } },
          ipv6: true,
          'tcp-concurrent': true,
          'geodata-mode': true
        },
        controlDns: true,
        controlSniff: true
      })
      const edited = await service.readRuntimeProfile(selection, 'profile')
      const built = localProxyConfiguration(edited.text, 18191, 'profile')
      const admitted = ownedCoreConfiguration(built.configuration, 'localProxy').parsed
      expect(admitted).toMatchObject({
        mode: 'rule',
        port: 18191,
        'mixed-port': 0,
        'socks-port': 0,
        'bind-address': '127.0.0.1',
        'external-controller': '',
        'unified-delay': true,
        'tcp-concurrent': true,
        'geodata-mode': true,
        'find-process-mode': 'strict',
        'log-level': 'info',
        ipv6: true,
        dns: { enable: true, nameserver: ['tls://1.1.1.1'], 'respect-rules': false },
        sniffer: { enable: true, sniff: { TLS: { ports: ['443'] } } },
        tun: { enable: false },
        profile: { 'store-selected': false, 'store-fake-ip': false }
      })
      expect(admitted.rules).toEqual(JSON.parse(fixtureProfile).rules)
      expect(JSON.parse(edited.text).tun).toEqual(settings.tun)
      expect(JSON.parse(edited.text).profile).toEqual(settings.profile)
      expect((await profiles.read(selection)).text).toBe(original.text)
      expect(() => ownedCoreConfiguration(built.configuration, 'inert')).toThrow()
      for (const patch of [
        { 'tcp-concurrent': 'true' },
        { 'find-process-mode': 'unrecognized' },
        { 'unified-delay': 1 },
        { 'geodata-mode': 'false' },
        { tun: { enable: true } },
        { authentication: ['user:secret'] }
      ])
        expect(() =>
          ownedCoreConfiguration(JSON.stringify({ ...admitted, ...patch }), 'localProxy')
        ).toThrow()
    })
  })
  it.each([false, true])(
    'accepts source allow-lan=%s while keeping the owned runtime on loopback',
    async (allowLan) => {
      await runtimeFixture(async ({ profiles, store }) => {
        const source = JSON.stringify({
          ...JSON.parse(fixtureProfile),
          'allow-lan': allowLan,
          'bind-address': '*'
        })
        const saved = await profiles.save('LAN subscription', source)
        const selection = { id: saved.id, sha256: saved.sha256 }
        const service = createConfigurationEditService({ profiles, store })
        for (const edited of [false, true]) {
          if (edited)
            await service.save({ globalOverrides: [], profileOverrides: [], controlled: {} })
          const effective = await service.readRuntimeProfile(selection)
          expect(JSON.parse(effective.text)['allow-lan']).toBe(allowLan)
          const built = localProxyConfiguration(effective.text, 18191)
          const admitted = ownedCoreConfiguration(built.configuration, 'localProxy').parsed
          expect(admitted).toMatchObject({
            'allow-lan': false,
            'bind-address': '127.0.0.1',
            port: 18191
          })
          expect(() =>
            ownedCoreConfiguration(JSON.stringify({ ...admitted, 'allow-lan': true }), 'localProxy')
          ).toThrow()
        }
        expect((await profiles.read(selection)).text).toBe(source)
      })
    }
  )
  it('rejects invalid LAN types, active authentication, LAN restrictions and automatic downloads', async () => {
    await runtimeFixture(async ({ profiles, store, selection }) => {
      const service = createConfigurationEditService({ profiles, store })
      for (const settings of [
        { authentication: ['user:secret'] },
        { 'allow-lan': 'true' },
        { 'allow-lan': 'false' },
        { 'allow-lan': 1 },
        { 'allow-lan': null },
        { 'allow-lan': [] },
        { 'allow-lan': {} },
        { 'lan-allowed-ips': ['192.168.0.0/16'] },
        { 'lan-disallowed-ips': ['127.0.0.1/32'] },
        { 'skip-auth-prefixes': ['not-cidr'] },
        { 'geo-auto-update': true },
        { 'geo-update-interval': -1 },
        { 'geox-url': { geoip: 'file:///private/source' } }
      ]) {
        await service.save({
          globalOverrides: [{ id: 'clash', kind: 'yaml', content: JSON.stringify(settings) }],
          profileOverrides: [],
          controlled: {}
        })
        await expect(service.readRuntimeProfile(selection)).rejects.toThrow('HTTP 运行暂不支持')
        expect(() =>
          localProxyConfiguration(
            JSON.stringify({ ...JSON.parse(fixtureProfile), ...settings }),
            18191
          )
        ).toThrow('HTTP 运行暂不支持')
      }
    })
  })
})
