import { gunzipSync } from 'zlib'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { VariantStore } from '../core/variant-store'
import catalog from '../core/variants-manifest.json'
import official from '../core/manifest.json'
import geodata from '../core/geodata-manifest.json'
import { isolatedCoreConfiguration } from '../core/configuration'
import { SMART_MODEL_CONTROLS } from '../profiles/groups'
import { resourceHash } from '../resources/source'
import { captureSelectedCoreSnapshot, type CoreSnapshotScope } from './core-snapshot-prototype'

const smart = catalog.cores.find((item) => item.family === 'smart')
if (!smart) throw new Error('固定Smart核心清单缺失。')
const architecture = process.arch === 'arm64' ? 'arm64' : 'x64'
const corePin = smart.assets[architecture]
const source = (asn = true): string =>
  JSON.stringify({
    ...isolatedCoreConfiguration(),
    ...SMART_MODEL_CONTROLS,
    'geox-url': {},
    'proxy-groups': [
      {
        name: 'Smart',
        type: 'smart',
        proxies: ['REJECT'],
        uselightgbm: true,
        collectdata: false,
        'prefer-asn': asn,
        url: 'http://127.0.0.1:1/fixture'
      }
    ]
  })
let home: string,
  root: string,
  store: VariantStore,
  metadata: Buffer,
  modelReceipt: Buffer,
  originalModel: Buffer,
  asn: Buffer,
  modelId: string,
  alternateModelId: string
let scope: CoreSnapshotScope
const resources = () => [{ path: 'ASN.mmdb', sha256: resourceHash(asn), bytes: Buffer.from(asn) }]
const capture = (extra: Partial<Parameters<typeof captureSelectedCoreSnapshot>[0]> = {}) =>
  captureSelectedCoreSnapshot({
    store,
    defaultRoot: '/not-used',
    configuration: source(),
    resources: resources(),
    scope,
    ...extra
  })

beforeAll(async () => {
  home = await realpath(await mkdtemp('/private/tmp/relay-core-model-snapshot-'))
  store = new VariantStore({ stateRoot: join(home, 'state') })
  const archive = await readFile(join('.relay-build/variant-reference', `smart-${corePin.asset}`))
  expect(resourceHash(archive)).toBe(corePin.archiveSHA256)
  const executable = gunzipSync(archive, { maxOutputLength: corePin.size })
  expect(resourceHash(executable)).toBe(corePin.sha256)
  const coreSource = join(home, 'trusted-core')
  await writeFile(coreSource, executable, { mode: 0o700 })
  const core = await store.acquire({
    kind: 'core',
    architecture,
    version: smart.version,
    sha256: corePin.sha256,
    size: corePin.size,
    sourcePath: coreSource
  })
  for (const [index, pin] of catalog.models.slice(0, 2).entries()) {
    const sourcePath = join(home, `model-${index}`),
      bytes = await readFile(join('.relay-build/variant-reference', `model-${pin.asset}`))
    expect(resourceHash(bytes)).toBe(pin.sha256)
    await writeFile(sourcePath, bytes, { mode: 0o600 })
    const record = await store.acquire({
      kind: 'smart',
      version: pin.version,
      sha256: pin.sha256,
      size: pin.size,
      sourcePath
    })
    if (index === 0) {
      modelId = record.id
      originalModel = bytes
    } else alternateModelId = record.id
  }
  await store.select({ id: modelId })
  await store.select({ id: core.id })
  root = await store.resolveCoreRoot('/not-used')
  modelReceipt = await readFile(join(root, 'relay-model.json'))
  metadata = await readFile(join(home, 'state/Variants/variants.json'))
  asn = await readFile('scripts/relay/fixtures/assets/GeoLite2-ASN-Test.mmdb')
}, 30_000)
beforeEach(async () => {
  scope = { generation: 1, assertLive: vi.fn() }
  await writeFile(join(home, 'state/Variants/variants.json'), metadata)
  await writeFile(join(root, 'Model.bin'), originalModel)
  await writeFile(join(root, 'relay-model.json'), modelReceipt)
})
afterAll(async () => {
  if (home) await rm(home, { recursive: true, force: true })
})

describe('Isolated selected Core and Smart execution snapshot prototype', () => {
  it('captures actual fixed Core/model/ASN bytes with no executable/path authority in the receipt', async () => {
    const result = await capture()
    expect(result.receipt).toMatchObject({
      version: 2,
      profile: 'smart',
      architecture,
      core: { version: smart.version, sha256: corePin.sha256, size: corePin.size },
      model: { path: 'Model.bin', sha256: catalog.models[0].sha256, size: originalModel.length }
    })
    expect(result.receipt.assets.map((item) => item.path)).toEqual(['ASN.mmdb', 'Model.bin'])
    expect(JSON.stringify(result.receipt)).not.toContain(home)
    expect(Object.isFrozen(result.receipt.model)).toBe(true)
    expect(Object.isFrozen(result.receipt.assets[0])).toBe(true)
    expect(await result.parserRoot()).toBe(root)
  })
  it('copies assets independently of both caller and returned buffers', async () => {
    const input = resources(),
      result = await capture({ resources: input })
    input[0].bytes.fill(0)
    const first = result.copyAssets()
    first[0].bytes.fill(1)
    first[1].bytes.fill(1)
    const second = result.copyAssets()
    expect(resourceHash(second[0].bytes)).toBe(resourceHash(asn))
    expect(resourceHash(second[1].bytes)).toBe(catalog.models[0].sha256)
    await result.recheck()
  })
  it('invalidates an already captured model selection rather than rebinding it', async () => {
    const result = await capture(),
      resolve = vi.spyOn(store, 'resolveCoreRoot')
    await store.select({ id: alternateModelId })
    await expect(result.recheck()).rejects.toThrow('选择已改变')
    expect(resolve).not.toHaveBeenCalled()
    expect(resourceHash(await readFile(join(root, 'Model.bin')))).toBe(resourceHash(originalModel))
    resolve.mockRestore()
  })
  it('rejects changed original receipt bytes without repairing them', async () => {
    const result = await capture(),
      changed = Buffer.concat([modelReceipt, Buffer.from('\n')])
    await writeFile(join(root, 'relay-model.json'), changed)
    await expect(result.recheck()).rejects.toThrow('回执已改变')
    expect(await readFile(join(root, 'relay-model.json'))).toEqual(changed)
  })
  it('rejects tampered Model.bin before exposing a private parser root', async () => {
    const result = await capture(),
      changed = Buffer.from(originalModel)
    changed[80] ^= 1
    await writeFile(join(root, 'Model.bin'), changed)
    await expect(result.parserRoot()).rejects.toThrow('模型字节已改变')
    expect(resourceHash(await readFile(join(root, 'Model.bin')))).toBe(resourceHash(changed))
  })
  it('rejects missing selected model before resolving a root', async () => {
    await store.restore('smart')
    const resolve = vi.spyOn(store, 'resolveCoreRoot')
    await expect(capture()).rejects.toThrow('模型缺失')
    expect(resolve).not.toHaveBeenCalled()
    resolve.mockRestore()
  })
  it('checks selection after a resolver await before any snapshot is returned', async () => {
    const resolver = {
      list: store.list.bind(store),
      async resolveCoreRoot(defaultRoot: string) {
        const value = await store.resolveCoreRoot(defaultRoot)
        await store.select({ id: alternateModelId })
        return value
      }
    }
    await expect(capture({ store: resolver })).rejects.toThrow('选择已改变')
  })
  it('rejects changed selection metadata even when the selected executable bytes stay identical', async () => {
    const result = await capture(),
      parsed = JSON.parse(metadata.toString('utf8'))
    parsed.records.find((item: { id: string }) => item.id === parsed.activeCoreId).acquiredAt++
    await writeFile(join(home, 'state/Variants/variants.json'), JSON.stringify(parsed))
    await expect(result.recheck()).rejects.toThrow('选择已改变')
  })
  it('counts the captured model inside the existing 200-asset budget', async () => {
    const input = resources(),
      bytes = Buffer.from('private fixture')
    for (let index = 1; index < 200; index++)
      input.push({
        path: `relay-files/${index.toString(16).padStart(64, '0')}.bin`,
        bytes,
        sha256: resourceHash(bytes)
      })
    await expect(capture({ resources: input })).rejects.toThrow('含模型的完整运行资产超过原有预算')
  })
  it('checks reentrant cancellation before the first I/O and after every await', async () => {
    const signal = new AbortController(),
      list = vi.fn(store.list.bind(store))
    scope.assertLive = () => signal.abort()
    await expect(
      capture({
        signal: signal.signal,
        store: { list, resolveCoreRoot: store.resolveCoreRoot.bind(store) }
      })
    ).rejects.toThrow('范围已失效')
    expect(list).not.toHaveBeenCalled()
    scope.assertLive = () => {}
    const changed = {
      list: async () => {
        const value = await store.list()
        scope.generation++
        return value
      },
      resolveCoreRoot: vi.fn()
    }
    await expect(capture({ store: changed })).rejects.toThrow('范围已失效')
    expect(changed.resolveCoreRoot).not.toHaveBeenCalled()
  })
  it('rejects generation/context loss, expiry and clock rollback for a completed snapshot', async () => {
    let now = 1000
    const result = await capture({ now: () => now, expiresAt: 2000 })
    now = 2000
    expect(() => result.copyAssets()).toThrow('范围已失效')
    now = 999
    await expect(result.recheck()).rejects.toThrow('范围已失效')
    now = 1000
    scope.generation++
    expect(() => result.copyAssets()).toThrow('范围已失效')
  })
  it('samples expiry after a synchronous scope callback and checks clock-side invalidation', async () => {
    let now = 1000,
      invalidate = false
    const result = await capture({
      now: () => {
        if (invalidate) scope.generation++
        return now
      },
      expiresAt: 2000
    })
    scope.assertLive = () => {
      now = 2000
    }
    expect(() => result.copyAssets()).toThrow('范围已失效')
    now = 1000
    scope.assertLive = vi.fn()
    invalidate = true
    expect(() => result.copyAssets()).toThrow('范围已失效')
  })
  it('retains the old official and extended default profiles without implicitly selecting Smart', async () => {
    await store.restore('core')
    const configuration = JSON.stringify({ ...isolatedCoreConfiguration(), 'geox-url': {} })
    for (const [directory, pin, profile] of [
      ['core', official.assets[architecture], 'stable'],
      ['core-geodata-v1', geodata.assets[architecture], 'local-geodata-v1']
    ] as const) {
      const result = await capture({
        defaultRoot: await realpath(join('extra/relay', directory)),
        configuration,
        resources: []
      })
      expect(result.receipt.profile).toBe(profile)
      expect(result.receipt.core.sha256).toBe(pin.sha256)
      expect(result.receipt.model).toBeUndefined()
      expect(result.copyAssets()).toEqual([])
    }
  })
  it('keeps the old asset whitelist and Smart no-download controls fail-closed', async () => {
    await expect(
      capture({
        resources: [{ path: 'Model.bin', bytes: originalModel, sha256: catalog.models[0].sha256 }]
      })
    ).rejects.toThrow('运行资源')
    await expect(capture({ resources: [] })).rejects.toThrow('未解决')
    const configuration = JSON.parse(source())
    configuration['lgbm-auto-update'] = true
    await expect(capture({ configuration: JSON.stringify(configuration) })).rejects.toThrow(
      '完整配置结构未通过'
    )
  })
})

describe('Smart collector execution snapshot', () => {
  it('binds its exact explicit size into the captured checked configuration hash', async () => {
    const parsed = JSON.parse(source(false))
    parsed.profile['smart-collector-size'] = 256
    const configuration = JSON.stringify(parsed),
      result = await capture({ configuration, resources: [] })
    expect(result.receipt.configurationSHA256).toBe(resourceHash(Buffer.from(configuration)))
    expect(result.receipt.profile).toBe('smart')
    await result.recheck()
  })
})

describe('Smart collector snapshot boundary before resource resolution', () => {
  it('rejects invalid or unknown sibling settings before resolving a Core root', async () => {
    const resolve = vi.spyOn(store, 'resolveCoreRoot')
    try {
      for (const profile of [
        { 'smart-collector-size': 0 },
        { 'smart-collector-size': 2, foreign: true }
      ])
        await expect(
          capture({ configuration: JSON.stringify({ profile }), resources: [] })
        ).rejects.toThrow()
      expect(resolve).not.toHaveBeenCalled()
    } finally {
      resolve.mockRestore()
    }
  })
  it('retains Smart family admission for a collector-only snapshot with no Smart group', async () => {
    const configuration = JSON.stringify({
      ...isolatedCoreConfiguration(),
      'geox-url': {},
      profile: { 'store-selected': false, 'store-fake-ip': false, 'smart-collector-size': 256 }
    })
    const result = await capture({ configuration, resources: [] })
    expect(result.receipt.profile).toBe('smart')
    expect(result.receipt.configurationSHA256).toBe(resourceHash(Buffer.from(configuration)))
  })
})
