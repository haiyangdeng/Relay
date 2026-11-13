import { mkdtemp, open, readFile, realpath, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { gunzipSync } from 'zlib'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProfileStore } from '../profiles/store'
import { ResourceStore } from '../resources/store'
import { resourceHash } from '../resources/source'
import geodataManifest from '../core/geodata-manifest.json'
import type { CompleteConfigurationResult } from '../../../shared/relay/configuration'
import { VariantStore } from '../core/variant-store'
import variants from '../core/variants-manifest.json'
import { verifyCoreResource } from '../core/resources'
import { createVariantService } from '../core/variant-service'
import { verifyCapturedSmartRuntimeModel } from '../core/smart-runtime'
import { createCompleteConfigurationService, configurationRequest } from './service'
import { captureSelectedCoreSnapshot, type CoreSnapshotScope } from './core-snapshot-prototype'
import { validateBoundConfiguration, validateCapturedCore } from './checker'
import type { RuntimeAsset } from './bindings'
async function fixture(
  run: (context: {
    profiles: ProfileStore
    resources: ResourceStore
    providers: ProfileStore
    request: Record<string, unknown>
    home: string
  }) => Promise<void>
): Promise<void> {
  const home = await realpath(await mkdtemp('/private/tmp/relay-complete-service-')),
    context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') }
  try {
    const profiles = new ProfileStore(context),
      profile = await profiles.save(
        'Private fixture',
        'proxies: [{name: N, type: direct}]\nrules: ["MATCH,REJECT"]'
      )
    await run({
      profiles,
      resources: new ResourceStore(context),
      providers: new ProfileStore(context, 'ProviderResources'),
      request: {
        profile: { id: profile.id, sha256: profile.sha256 },
        options: { globalOverrides: [], profileOverrides: [], controlled: {} },
        bindings: []
      },
      home
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
const passed = (source: string): CompleteConfigurationResult => ({
  status: 'passed',
  scope: 'complete-parser',
  configurationSHA256: resourceHash(Buffer.from(source)),
  active: false,
  runtimeAccepted: false,
  warnings: []
})
describe('Complete candidate lifecycle and snapshot-bound checks', () => {
  it('admits the selected source rule patch into the actual prepared bundle without accepting arbitrary scope libraries', async () => {
    await fixture(async (stores) => {
      const request = {
          ...stores.request,
          options: {
            globalOverrides: [],
            profileOverrides: [],
            controlled: {},
            profileRulePatch: { prepend: ['DOMAIN,legacy.test,REJECT'] }
          }
        },
        check = vi.fn(async (source: string) => passed(source)),
        service = createCompleteConfigurationService({ ...stores, script: vi.fn(), check }),
        plan = await service.prepare(request)
      await service.check({ evidenceId: plan.evidenceId })
      expect(JSON.parse(check.mock.calls[0][0]).rules[0]).toBe('DOMAIN,legacy.test,REJECT')
      expect(() =>
        configurationRequest({
          ...request,
          options: { ...request.options, profileRulePatchSets: [] }
        })
      ).toThrow('选项')
    })
  })
  it('preserves the original candidate deadline after a delayed parser check', async () => {
    await fixture(async (stores) => {
      let now = 1000
      const service = createCompleteConfigurationService({
          ...stores,
          script: vi.fn(),
          check: async (source) => ({ ...passed(source), coreVersion: 'v1.19.33' }),
          now: () => now
        }),
        plan = await service.prepare(stores.request)
      now = 50000
      await service.check({ evidenceId: plan.evidenceId })
      const snapshot = await service.takeChecked({ evidenceId: plan.evidenceId })
      expect(snapshot.profileId).toBe(configurationRequest(stores.request).selection.id)
      expect(snapshot.expiresAt).toBe(61000)
      now = 61000
      await snapshot.recheck()
      now = 61001
      await expect(snapshot.recheck()).rejects.toMatchObject({ code: 'checked-expired' })
    })
  })
  it.each(['v1.19.33', geodataManifest.version])(
    'hands the exact %s checked bundle to one private session and revokes it on clear',
    async (coreVersion) => {
      await fixture(async (stores) => {
        const check = vi.fn(async (source: string) => ({
            ...passed(source),
            coreVersion
          })),
          service = createCompleteConfigurationService({ ...stores, script: vi.fn(), check }),
          plan = await service.prepare(stores.request),
          request = { evidenceId: plan.evidenceId }
        await expect(service.takeChecked(request)).rejects.toThrow('先完成')
        const result = await service.check(request)
        const [first, second] = await Promise.allSettled([
          service.takeChecked(request),
          service.takeChecked(request)
        ])
        expect(first.status).toBe('fulfilled')
        expect(second.status).toBe('rejected')
        if (first.status !== 'fulfilled') throw new Error('No private candidate')
        const snapshot = first.value
        expect(snapshot.configuration).toBe(check.mock.calls[0][0])
        expect(snapshot.configurationSHA256).toBe(plan.configurationSHA256)
        expect(snapshot.bundleSHA256).toBe(plan.bundleSHA256)
        expect(snapshot.parser).toEqual(result)
        expect(Object.isFrozen(snapshot)).toBe(true)
        expect(JSON.stringify(result)).not.toContain('configuration"')
        await snapshot.recheck()
        service.clear()
        await expect(snapshot.recheck()).rejects.toThrow('失效')
      })
    }
  )
  it('rejects a checked session handoff when sources change and cannot reuse the consumed proof', async () => {
    await fixture(async (stores) => {
      const service = createCompleteConfigurationService({
          ...stores,
          script: vi.fn(),
          check: async (source) => ({ ...passed(source), coreVersion: 'v1.19.33' })
        }),
        plan = await service.prepare(stores.request),
        request = { evidenceId: plan.evidenceId },
        selection = stores.request.profile as { id: string }
      await service.check(request)
      await writeFile(join(stores.profiles.directory, selection.id, 'profile.yaml'), 'changed')
      await expect(service.takeChecked(request)).rejects.toThrow()
      await expect(service.takeChecked(request)).rejects.toThrow('先完成')
    })
  })
  it.each(['relay-geodata-v1-unknown', 'relay-geodata-v1-3f27-extra'])(
    'does not admit an unpinned Geo parser version %s',
    async (coreVersion) => {
      await fixture(async (stores) => {
        const service = createCompleteConfigurationService({
            ...stores,
            script: vi.fn(),
            check: async (source) => ({ ...passed(source), coreVersion })
          }),
          plan = await service.prepare(stores.request),
          request = { evidenceId: plan.evidenceId }
        expect((await service.check(request)).status).toBe('passed')
        await expect(service.takeChecked(request)).rejects.toThrow('先完成')
      })
    }
  )
  it('does not grant private runtime capability for an unpinned parser or after candidate expiry', async () => {
    await fixture(async (stores) => {
      let now = 1000,
        version = 'v1.19.32'
      const service = createCompleteConfigurationService({
        ...stores,
        script: vi.fn(),
        check: async (source) => ({ ...passed(source), coreVersion: version }),
        now: () => now
      })
      let plan = await service.prepare(stores.request)
      await service.check({ evidenceId: plan.evidenceId })
      await expect(service.takeChecked({ evidenceId: plan.evidenceId })).rejects.toThrow('先完成')
      version = 'v1.19.33'
      plan = await service.prepare(stores.request)
      await service.check({ evidenceId: plan.evidenceId })
      const snapshot = await service.takeChecked({ evidenceId: plan.evidenceId })
      now += 60001
      await expect(snapshot.recheck()).rejects.toMatchObject({ code: 'checked-expired' })
    })
  })
  it('checks the exact prepared bytes without rerunning nondeterministic scripts and returns no private data', async () => {
    await fixture(async (stores) => {
      let calls = 0
      const script = vi.fn(async (_script: string, configuration: Record<string, unknown>) => ({
          configuration: { ...configuration, 'global-ua': 'PRIVATE-' + ++calls },
          logs: ['PRIVATE log']
        })),
        check = vi.fn(async (source: string) => passed(source))
      const service = createCompleteConfigurationService({ ...stores, script, check })
      const request = {
        ...stores.request,
        options: {
          globalOverrides: [{ id: 'J', kind: 'js', content: 'PRIVATE script' }],
          profileOverrides: [],
          controlled: {}
        }
      }
      const plan = await service.prepare(request)
      expect(plan.readyForParserCheck).toBe(true)
      expect(plan.scriptLogLines).toBe(1)
      expect(JSON.stringify(plan)).not.toContain('PRIVATE')
      const result = await service.check({ evidenceId: plan.evidenceId })
      expect(result.status).toBe('passed')
      expect(script).toHaveBeenCalledOnce()
      expect(check).toHaveBeenCalledOnce()
      expect(check.mock.calls[0][0]).toContain('PRIVATE-1')
      await expect(service.check({ evidenceId: plan.evidenceId })).rejects.toThrow('重新准备')
    })
  })
  it('blocks incomplete and stale profile candidates before invoking a parser worker', async () => {
    await fixture(async (stores) => {
      const script = vi.fn(),
        check = vi.fn(async (source: string) => passed(source)),
        service = createCompleteConfigurationService({ ...stores, script, check })
      const partial = await service.prepare({
        ...stores.request,
        options: {
          globalOverrides: [
            { id: 'file', kind: 'yaml', content: 'tls: {certificate: /PRIVATE/missing}' }
          ],
          profileOverrides: [],
          controlled: {}
        }
      })
      expect(partial.readyForParserCheck).toBe(false)
      expect(JSON.stringify(partial)).not.toContain('/PRIVATE')
      await expect(service.check({ evidenceId: partial.evidenceId })).rejects.toThrow()
      const plan = await service.prepare(stores.request)
      const selection = stores.request.profile as { id: string }
      await writeFile(join(stores.profiles.directory, selection.id, 'profile.yaml'), 'changed')
      const result = await service.check({ evidenceId: plan.evidenceId })
      expect(result.status).toBe('unavailable')
      expect(check).not.toHaveBeenCalled()
    })
  })
  it('invalidates expired proof and clears it when a new preparation fails', async () => {
    await fixture(async (stores) => {
      let now = 1
      const check = vi.fn(async (source: string) => passed(source)),
        service = createCompleteConfigurationService({
          ...stores,
          script: vi.fn(),
          check,
          now: () => now
        })
      const old = await service.prepare(stores.request)
      now = 60002
      await expect(service.check({ evidenceId: old.evidenceId })).rejects.toThrow()
      const newer = await service.prepare(stores.request)
      await expect(
        service.prepare({
          ...stores.request,
          options: {
            globalOverrides: [{ id: 'bad', kind: 'yaml', content: 'unknown-root: true' }],
            profileOverrides: [],
            controlled: {}
          }
        })
      ).rejects.toThrow('生成未完成')
      await expect(service.check({ evidenceId: newer.evidenceId })).rejects.toThrow()
      expect(check).not.toHaveBeenCalled()
    })
  })
  it('aborts the owned script on close, waits for termination and permits reuse if App quit is cancelled', async () => {
    await fixture(async (stores) => {
      let started = false,
        ended = false
      const script = vi.fn(
        (_script: string, _configuration: Record<string, unknown>, signal: AbortSignal) =>
          new Promise<{ configuration: Record<string, unknown>; logs: string[] }>(
            (_resolve, reject) => {
              started = true
              signal.addEventListener(
                'abort',
                () => {
                  ended = true
                  reject(new Error('cancel'))
                },
                { once: true }
              )
            }
          )
      )
      const service = createCompleteConfigurationService({ ...stores, script, check: vi.fn() })
      const pending = service.prepare({
        ...stores.request,
        options: {
          globalOverrides: [{ id: 'J', kind: 'js', content: 'while' }],
          profileOverrides: [],
          controlled: {}
        }
      })
      const rejection = expect(pending).rejects.toThrow('已取消')
      await vi.waitFor(() => expect(started).toBe(true))
      expect(service.isBusy()).toBe(true)
      await service.requestClose()
      await rejection
      expect(ended).toBe(true)
      expect(service.isBusy()).toBe(false)
      expect((await service.prepare(stores.request)).readyForParserCheck).toBe(true)
    })
  })
  it('never masks an uncertain cleanup result with cancellation or a later resource check failure', async () => {
    await fixture(async (stores) => {
      const service = createCompleteConfigurationService({
        ...stores,
        script: vi.fn(),
        check: async (source) => {
          service.cancel()
          return { ...passed(source), status: 'uncertain' }
        }
      })
      const plan = await service.prepare(stores.request)
      expect((await service.check({ evidenceId: plan.evidenceId })).status).toBe('uncertain')
    })
  })
  it('rejects extra paths and foreign profile identity at the public boundary', () => {
    for (const value of [
      { path: '/PRIVATE' },
      {
        profile: { id: '/PRIVATE', sha256: 'a'.repeat(64) },
        options: { globalOverrides: [], profileOverrides: [], controlled: {} },
        bindings: []
      }
    ])
      expect(() => configurationRequest(value)).toThrow()
  })
})

// Private P34 integration. Actual fixed cached Core/model/ASN bytes are read;
// parser results are injected, and no executable/Core/Native/network is run.

const smartPin = (() => {
  const pin = variants.cores.find((pin) => pin.family === 'smart')
  if (!pin) throw new Error('Missing fixed Smart core')
  return pin
})()
const hostArchitecture = process.arch === 'arm64' ? 'arm64' : 'x64'
let capsuleHome: string,
  variantRoot: string,
  variantStore: VariantStore,
  coreId: string,
  modelId: string,
  alternateModelId: string
let modelBytes: Buffer, modelReceipt: Buffer, recordsBytes: Buffer, asnBytes: Buffer
let executionScope: CoreSnapshotScope
beforeAll(async () => {
  capsuleHome = await realpath(await mkdtemp('/private/tmp/relay-p34-private-execution-'))
  variantStore = new VariantStore({ stateRoot: join(capsuleHome, 'state') })
  const pin = smartPin.assets[hostArchitecture]
  const archive = await readFile(join('.relay-build/variant-reference', `smart-${pin.asset}`))
  expect(resourceHash(archive)).toBe(pin.archiveSHA256)
  const body = gunzipSync(archive, { maxOutputLength: pin.size }),
    sourcePath = join(capsuleHome, 'core-input')
  expect(resourceHash(body)).toBe(pin.sha256)
  await writeFile(sourcePath, body, { mode: 0o700 })
  const core = await variantStore.acquire({
    kind: 'core',
    architecture: hostArchitecture,
    version: smartPin.version,
    sha256: pin.sha256,
    size: pin.size,
    sourcePath
  })
  coreId = core.id
  for (const [index, pin] of variants.models.slice(0, 2).entries()) {
    const bytes = await readFile(join('.relay-build/variant-reference', `model-${pin.asset}`)),
      sourcePath = join(capsuleHome, `model-input-${index}`)
    expect(resourceHash(bytes)).toBe(pin.sha256)
    await writeFile(sourcePath, bytes, { mode: 0o600 })
    const model = await variantStore.acquire({
      kind: 'smart',
      version: pin.version,
      sha256: pin.sha256,
      size: pin.size,
      sourcePath
    })
    if (index === 0) {
      modelId = model.id
      modelBytes = bytes
    } else alternateModelId = model.id
  }
  await variantStore.select({ id: modelId })
  await variantStore.select({ id: coreId })
  variantRoot = await variantStore.resolveCoreRoot('/not-used')
  modelReceipt = await readFile(join(variantRoot, 'relay-model.json'))
  recordsBytes = await readFile(join(capsuleHome, 'state/Variants/variants.json'))
  asnBytes = await readFile('scripts/relay/fixtures/assets/GeoLite2-ASN-Test.mmdb')
}, 30000)
beforeEach(async () => {
  executionScope = { generation: 1, assertLive: vi.fn() }
  await writeFile(join(capsuleHome, 'state/Variants/variants.json'), recordsBytes)
  await writeFile(join(variantRoot, 'Model.bin'), modelBytes)
  await writeFile(join(variantRoot, 'relay-model.json'), modelReceipt)
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => {
  if (capsuleHome) await rm(capsuleHome, { recursive: true, force: true })
})
type Parser = Parameters<typeof createCompleteConfigurationService>[0]['check']
async function capsuleFixture(
  run: (value: {
    service: ReturnType<typeof createCompleteConfigurationService>
    ready(): Promise<{ evidenceId: string; bundleSHA256: string }>
    parser: ReturnType<typeof vi.fn<Parser>>
    store: VariantStore
    scope: CoreSnapshotScope
    change: ReturnType<typeof createVariantService>
    parserAssets(): readonly RuntimeAsset[]
  }) => Promise<void>,
  override?: Parser,
  plain = false
) {
  const home = await realpath(await mkdtemp('/private/tmp/relay-p34-private-service-'))
  const context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') },
    profiles = new ProfileStore(context),
    resources = new ResourceStore(context)
  let lastAssets: readonly RuntimeAsset[] = []
  try {
    const profile = await profiles.save(
      'Smart candidate',
      plain
        ? JSON.stringify({ proxies: [], rules: ['IP-ASN,64512,REJECT', 'MATCH,REJECT'] })
        : JSON.stringify({
            proxies: [],
            'proxy-groups': [
              {
                name: 'Smart',
                type: 'smart',
                proxies: ['REJECT'],
                uselightgbm: true,
                collectdata: false,
                'prefer-asn': true,
                url: 'http://127.0.0.1:1/private'
              }
            ],
            rules: ['MATCH,REJECT']
          })
    )
    const asn = await resources.save(
      { name: 'Private ASN', kind: 'asn-mmdb', behavior: null, selector: '64512' },
      asnBytes
    )
    const parser = vi.fn<Parser>(async (source, assets, signal, execution) => {
      if (!execution) {
        if (process.env.RELAY_P34_BASELINE_SERVICE === '1')
          return { ...passed(source), coreVersion: smartPin.version }
        throw new Error('Missing captured execution')
      }
      lastAssets = assets
      const core = await verifyCoreResource(await execution.parserRoot())
      validateCapturedCore(core, execution.receipt)
      validateBoundConfiguration(source, assets, execution.receipt)
      const directory = await realpath(await mkdtemp('/private/tmp/relay-p34-private-parser-copy-'))
      try {
        for (const asset of assets)
          await writeFile(join(directory, asset.path), asset.bytes, { flag: 'wx', mode: 0o600 })
        await verifyCapturedSmartRuntimeModel(directory, core, source, execution.receipt)
      } finally {
        await rm(directory, { recursive: true, force: true })
      }
      return override
        ? override(source, assets, signal, execution)
        : { ...passed(source), coreVersion: smartPin.version }
    })
    const service = createCompleteConfigurationService({
      profiles,
      providers: new ProfileStore(context, 'ProviderResources'),
      resources,
      script: vi.fn(),
      captureExecution: (configuration, assets, signal, expiresAt) =>
        captureSelectedCoreSnapshot({
          store: variantStore,
          defaultRoot: '/not-used',
          configuration,
          resources: assets,
          scope: executionScope,
          signal,
          expiresAt
        }),
      check: parser
    })
    const change = createVariantService({
      store: variantStore,
      selectionChanged: () => {
        ++executionScope.generation
        service.clear()
      }
    })
    const request = {
      profile: { id: profile.id, sha256: profile.sha256 },
      options: { globalOverrides: [], profileOverrides: [], controlled: {} },
      bindings: []
    }
    await run({
      service,
      parser,
      store: variantStore,
      scope: executionScope,
      change,
      parserAssets: () => lastAssets,
      ready: async () => {
        const first = await service.prepare(request),
          dependency = first.dependencies.find((d) => d.kind === 'asn-mmdb')
        if (!dependency) throw new Error('Missing actual ASN dependency')
        return service.prepare({
          ...request,
          bindings: [{ dependencyId: dependency.id, selection: { id: asn.id, sha256: asn.sha256 } }]
        })
      }
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}
describe('Private P34 same captured Core/model/ASN checked handoff', () => {
  it('hands one parser-checked complete tuple with model-inclusive fingerprint and no executable path', async () => {
    await capsuleFixture(async ({ service, ready, parser, store }) => {
      const resolve = vi.spyOn(store, 'resolveCoreRoot'),
        plan = await ready()
      expect((await service.check({ evidenceId: plan.evidenceId })).status).toBe('passed')
      const snapshot = await service.takeChecked({ evidenceId: plan.evidenceId })
      expect(snapshot.execution?.core.version).toBe(smartPin.version)
      expect(snapshot.execution?.model?.sha256).toBe(variants.models[0].sha256)
      expect(snapshot.assets.map((a) => a.path)).toEqual(['ASN.mmdb', 'Model.bin'])
      expect(resourceHash(snapshot.assets[0].bytes)).toBe(resourceHash(asnBytes))
      expect(resourceHash(snapshot.assets[1].bytes)).toBe(variants.models[0].sha256)
      expect(snapshot.bundleSHA256).not.toBe(plan.bundleSHA256)
      expect(snapshot.bundleSHA256).toBe(
        resourceHash(
          Buffer.from(
            JSON.stringify({
              configuration: JSON.parse(snapshot.configuration),
              assets: snapshot.assets.map(({ path, sha256, expectedRules }) => ({
                path,
                sha256,
                ...(expectedRules !== undefined ? { expectedRules } : {})
              })),
              pins: snapshot.pins,
              unresolved: []
            })
          )
        )
      )
      expect(JSON.stringify(snapshot.execution)).not.toContain(capsuleHome)
      expect(Object.isFrozen(snapshot.execution?.model)).toBe(true)
      expect(parser).toHaveBeenCalledTimes(1)
      expect(resolve).toHaveBeenCalledTimes(1)
      await snapshot.recheck()
      await snapshot.recheck()
      expect(resolve).toHaveBeenCalledTimes(1)
      await expect(service.takeChecked({ evidenceId: plan.evidenceId })).rejects.toThrow('先完成')
      resolve.mockRestore()
    })
  }, 30000)
  it('successful model selection before take revokes proof and never repairs the old captured model', async () => {
    await capsuleFixture(async ({ service, ready, change, store }) => {
      const plan = await ready()
      await service.check({ evidenceId: plan.evidenceId })
      const resolve = vi.spyOn(store, 'resolveCoreRoot')
      await change.select({ id: alternateModelId })
      await expect(service.takeChecked({ evidenceId: plan.evidenceId })).rejects.toThrow('先完成')
      expect(resourceHash(await readFile(join(variantRoot, 'Model.bin')))).toBe(
        variants.models[0].sha256
      )
      expect(resolve).not.toHaveBeenCalled()
      resolve.mockRestore()
    })
  }, 30000)
  it('a taken snapshot is revoked on successful restore before any execution', async () => {
    await capsuleFixture(async ({ service, ready, change }) => {
      const plan = await ready()
      await service.check({ evidenceId: plan.evidenceId })
      const snapshot = await service.takeChecked({ evidenceId: plan.evidenceId })
      await change.restore('core')
      await expect(snapshot.recheck()).rejects.toMatchObject({ code: 'checked-invalidated' })
    })
  }, 30000)
  it('model bytes changed after check reject at take with no resolve/repair', async () => {
    await capsuleFixture(async ({ service, ready, store }) => {
      const plan = await ready()
      await service.check({ evidenceId: plan.evidenceId })
      const resolve = vi.spyOn(store, 'resolveCoreRoot')
      await writeFile(join(variantRoot, 'Model.bin'), Buffer.alloc(modelBytes.length))
      await expect(service.takeChecked({ evidenceId: plan.evidenceId })).rejects.toThrow()
      expect(resolve).not.toHaveBeenCalled()
      resolve.mockRestore()
    })
  }, 30000)
  it('a parser result for another core version cannot publish a checked proof', async () => {
    await capsuleFixture(
      async ({ service, ready }) => {
        const plan = await ready()
        await service.check({ evidenceId: plan.evidenceId })
        await expect(service.takeChecked({ evidenceId: plan.evidenceId })).rejects.toThrow('先完成')
      },
      async (source) => ({ ...passed(source), coreVersion: 'alpha-ca8d7c4' })
    )
  }, 30000)
  it('parser-side input mutation after captured copy cannot become an executable candidate', async () => {
    await capsuleFixture(
      async ({ service, ready }) => {
        const plan = await ready()
        expect((await service.check({ evidenceId: plan.evidenceId })).status).toBe('unavailable')
        await expect(service.takeChecked({ evidenceId: plan.evidenceId })).rejects.toThrow('先完成')
      },
      async (source, assets) => {
        requiredModel(assets).bytes.fill(0)
        return { ...passed(source), coreVersion: smartPin.version }
      }
    )
  }, 30000)
  it('mutating the exposed taken Model buffer fails pure recheck and does not touch source bytes', async () => {
    await capsuleFixture(async ({ service, ready }) => {
      const plan = await ready()
      await service.check({ evidenceId: plan.evidenceId })
      const snapshot = await service.takeChecked({ evidenceId: plan.evidenceId })
      requiredModel(snapshot.assets).bytes.fill(0)
      await expect(snapshot.recheck()).rejects.toMatchObject({ code: 'checked-assets' })
      expect(resourceHash(await readFile(join(variantRoot, 'Model.bin')))).toBe(
        variants.models[0].sha256
      )
    })
  }, 30000)
  it('Model slot remains rejected without a captured Smart profile and mismatched body/counts stay closed', async () => {
    await capsuleFixture(async ({ service, ready }) => {
      const plan = await ready()
      await service.check({ evidenceId: plan.evidenceId })
      const snapshot = await service.takeChecked({ evidenceId: plan.evidenceId }),
        execution = snapshot.execution
      if (!execution) throw new Error('Missing execution')
      expect(() => validateBoundConfiguration(snapshot.configuration, snapshot.assets)).toThrow(
        '路径'
      )
      expect(() =>
        validateBoundConfiguration(snapshot.configuration, snapshot.assets, {
          ...execution,
          profile: 'alpha'
        })
      ).toThrow('模型槽')
      expect(() =>
        validateBoundConfiguration(snapshot.configuration, snapshot.assets.slice(0, 1), execution)
      ).toThrow('执行资产')
      const wrongCore = { ...execution, core: { ...execution.core, sha256: '0'.repeat(64) } }
      expect(() =>
        validateCapturedCore(
          {
            version: smartPin.version,
            architecture: hostArchitecture,
            sha256: smartPin.assets[hostArchitecture].sha256,
            executable: '/unused'
          },
          wrongCore
        )
      ).toThrow('固定核心')
    })
  }, 30000)
  it('rejects parser resource version or body SHA mismatches even when the Geo receipt is fixed', async () => {
    const pin = geodataManifest.assets[hostArchitecture],
      resource: Parameters<typeof validateCapturedCore>[0] = {
        capability: 'local-geodata-v1',
        version: geodataManifest.version,
        architecture: hostArchitecture,
        sha256: pin.sha256,
        executable: '/unused-private-validator'
      },
      receipt: Parameters<typeof validateCapturedCore>[1] = {
        version: 2,
        profile: 'local-geodata-v1',
        architecture: hostArchitecture,
        core: { version: geodataManifest.version, sha256: pin.sha256, size: pin.size },
        configurationSHA256: '1'.repeat(64),
        selectionSHA256: '2'.repeat(64),
        snapshotSHA256: '3'.repeat(64),
        expiresAt: Date.now() + 60000,
        assets: []
      }
    expect(() => validateCapturedCore(resource, receipt)).not.toThrow()
    for (const changed of [
      { ...resource, version: resource.version + '-wrong' },
      { ...resource, sha256: '0'.repeat(64) },
      { ...resource, version: resource.version + '-wrong', sha256: '0'.repeat(64) }
    ])
      expect(() => validateCapturedCore(changed, receipt)).toThrow('固定核心')
  })
  it('also captures the exact selected Alpha Core with ASN and no model slot', async () => {
    const alpha = variants.cores.find((p) => p.family === 'alpha')
    if (!alpha) throw new Error('Missing fixed Alpha')
    const pin = alpha.assets[hostArchitecture],
      archive = await readFile(join('.relay-build/variant-reference', `alpha-${pin.asset}`)),
      path = join(capsuleHome, 'alpha-input')
    expect(resourceHash(archive)).toBe(pin.archiveSHA256)
    const bytes = gunzipSync(archive, { maxOutputLength: pin.size })
    expect(resourceHash(bytes)).toBe(pin.sha256)
    await writeFile(path, bytes, { mode: 0o700 })
    const selected = await variantStore.acquire({
      kind: 'core',
      architecture: hostArchitecture,
      version: alpha.version,
      sha256: pin.sha256,
      size: pin.size,
      sourcePath: path
    })
    await variantStore.select({ id: selected.id })
    await capsuleFixture(
      async ({ service, ready }) => {
        const plan = await ready()
        expect((await service.check({ evidenceId: plan.evidenceId })).status).toBe('passed')
        const snapshot = await service.takeChecked({ evidenceId: plan.evidenceId })
        expect(snapshot.execution?.core.sha256).toBe(pin.sha256)
        expect(snapshot.execution?.profile).toBe('alpha')
        expect(snapshot.execution?.model).toBeUndefined()
        expect(snapshot.assets.map((a) => a.path)).toEqual(['ASN.mmdb'])
        await snapshot.recheck()
      },
      async (source, _assets, _signal, execution) => {
        if (!execution) throw new Error('Missing execution')
        return { ...passed(source), coreVersion: execution.receipt.core.version }
      },
      true
    )
  }, 30000)
  it('raw model receipt change after check is not normalized or repaired at consume', async () => {
    await capsuleFixture(async ({ service, ready, store }) => {
      const plan = await ready()
      await service.check({ evidenceId: plan.evidenceId })
      const resolve = vi.spyOn(store, 'resolveCoreRoot'),
        changed = Buffer.concat([modelReceipt, Buffer.from('\n')])
      await writeFile(join(variantRoot, 'relay-model.json'), changed)
      await expect(service.takeChecked({ evidenceId: plan.evidenceId })).rejects.toThrow()
      expect(resolve).not.toHaveBeenCalled()
      expect(await readFile(join(variantRoot, 'relay-model.json'))).toEqual(changed)
    })
  }, 30000)
  it('Core body change after parser result rejects before consume without resolving a replacement', async () => {
    await capsuleFixture(async ({ service, ready, store }) => {
      const plan = await ready()
      await service.check({ evidenceId: plan.evidenceId })
      const resolve = vi.spyOn(store, 'resolveCoreRoot'),
        path = join(variantRoot, smartPin.assets[hostArchitecture].path),
        file = await open(path, 'r+'),
        original = Buffer.alloc(1)
      try {
        await file.read(original, 0, 1, 0)
        await file.write(Buffer.from([original[0] ^ 255]), 0, 1, 0)
        await expect(service.takeChecked({ evidenceId: plan.evidenceId })).rejects.toThrow()
        expect(resolve).not.toHaveBeenCalled()
      } finally {
        await file.write(original, 0, 1, 0)
        await file.close()
      }
    })
  }, 30000)
  it('clock-adapter reentry cannot republish a cleared legacy proof at the final publication gate', async () => {
    await fixture(async (stores) => {
      let completed = false,
        revoked = false
      const service = createCompleteConfigurationService({
        ...stores,
        script: vi.fn(),
        now: () => {
          if (completed && !revoked) {
            revoked = true
            service.clear()
          }
          return Date.now()
        },
        check: async (source) => {
          completed = true
          return { ...passed(source), coreVersion: 'v1.19.33' }
        }
      })
      const plan = await service.prepare(stores.request)
      expect((await service.check({ evidenceId: plan.evidenceId })).status).toBe('cancelled')
      await expect(service.takeChecked({ evidenceId: plan.evidenceId })).rejects.toThrow('先完成')
    })
  })
})

function requiredModel(assets: readonly RuntimeAsset[]): RuntimeAsset {
  const model = assets.find((asset) => asset.path === 'Model.bin')
  if (!model) throw new Error('Missing captured Model.bin')
  return model
}
