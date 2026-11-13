import { chmodSync, fstatSync, readdirSync, renameSync, linkSync, writeFileSync } from 'fs'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { generateKeyPairSync, sign } from 'crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GatewayError } from '../../resolve/plugin/gateway'
import type { PluginResponse } from '../../resolve/plugin/http-client'
import type { OperationContext } from '../../resolve/plugin/operation'
import type { RelayPluginRecord } from '../../../shared/relay/plugins'
import { ProfileStore } from '../profiles/store'
import { buildDiscoverySignInput } from '../../resolve/plugin/discovery-sig'
import { RelayPluginStore, RelayPluginStorageUncertain, pluginTargetKey } from './store'
import { createRelayPluginService } from './service'
import { createRelayPluginContext } from './transport'
import { createRelayPluginScheduler } from './scheduler'
import type { RelayPluginPermission } from './service'

const fsFaults = vi.hoisted(() => ({
  stage: undefined as ((fd: number) => void) | undefined,
  partial: false,
  renameACK: false,
  seenFD: -1
}))
vi.mock('fs', async (original) => {
  const actual = await original<typeof import('fs')>()
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (typeof args[0] === 'number' && fsFaults.partial && Buffer.isBuffer(args[1])) {
        fsFaults.partial = false
        fsFaults.seenFD = args[0]
        actual.writeFileSync(args[0], args[1].subarray(0, 7), args[2])
        throw Object.assign(new Error('injected partial stage write'), { code: 'EIO' })
      }
      actual.writeFileSync(...args)
      if (typeof args[0] === 'number' && fsFaults.stage) {
        const callback = fsFaults.stage
        fsFaults.stage = undefined
        fsFaults.seenFD = args[0]
        callback(args[0])
      }
    },
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      actual.renameSync(...args)
      if (fsFaults.renameACK && String(args[0]).includes('/.record-')) {
        fsFaults.renameACK = false
        throw Object.assign(new Error('injected post-rename lost ACK'), { code: 'EIO' })
      }
    }
  }
})
vi.mock('electron', () => ({ shell: { openExternal: vi.fn() } }))
const homes: string[] = []
afterEach(async () => {
  fsFaults.stage = undefined
  fsFaults.partial = false
  fsFaults.renameACK = false
  fsFaults.seenFD = -1
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})
const descriptor = JSON.stringify({
  magic: 'CPXF',
  v: 2,
  spec: 'cpx-plugin/2',
  loginUrl: 'https://provider.example/authorize',
  provider: { name: 'Fixture provider' }
})
const configuration = JSON.stringify({
  proxies: [{ name: 'A', type: 'http', server: '127.0.0.1', port: 1234 }],
  'proxy-groups': [{ name: 'G', type: 'select', proxies: ['A'] }],
  rules: ['MATCH,G']
})
const wellKnown = {
  spec: 'cpx-plugin/2',
  gateway: 'https://gateway.example',
  endpoints: { enroll: '/enroll', challenge: '/challenge', config: '/config', revoke: '/revoke' }
}

async function fixture(descriptorText = descriptor) {
  const home = await realpath(await mkdtemp('/private/tmp/relay-plugin-workflow-'))
  homes.push(home)
  const context = { home, stateRoot: join(home, 'Library/Application Support/Relay') }
  const crypto = {
    available: vi.fn(async () => true),
    encrypt: vi.fn(async (text: string) =>
      Buffer.from('test-encrypted:' + Buffer.from(text).toString('base64'))
    ),
    decrypt: vi.fn(async (bytes: Buffer) =>
      Buffer.from(bytes.toString('utf8').slice('test-encrypted:'.length), 'base64').toString('utf8')
    )
  }
  const store = new RelayPluginStore(context, crypto),
    profiles = new ProfileStore(context)
  let discoveryDocument: Record<string, unknown> = wellKnown,
    configDiscovery: string | undefined,
    failConfig = false,
    configText = configuration,
    failEnroll = false,
    failRevoke = false
  const network = vi.fn(async (url: string): Promise<PluginResponse> => {
    const pathname = new URL(url).pathname
    if (pathname === '/.well-known/cpx-gateway')
      return { status: 200, headers: {}, body: JSON.stringify(discoveryDocument) }
    if (pathname === '/challenge')
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ nonceId: 'nonce', nonce: Buffer.alloc(32, 1).toString('base64') })
      }
    if (pathname === '/enroll') {
      if (failEnroll)
        throw new GatewayError('transient', 'request possibly sent', undefined, 'possibly-sent')
      return { status: 200, headers: {}, body: '{}' }
    }
    if (pathname === '/revoke') {
      if (failRevoke) throw new GatewayError('transient', 'remote failed')
      return { status: 200, headers: {}, body: '{}' }
    }
    if (pathname === '/config') {
      if (failConfig) throw new GatewayError('transient', 'server failed')
      return {
        status: 200,
        headers: configDiscovery ? { 'x-cpx-discovery': configDiscovery } : {},
        body: configText
      }
    }
    throw new Error('Unexpected fixture URL')
  })
  const confirm = vi.fn(async (_permission: RelayPluginPermission) => true),
    oauth = vi.fn(async (_url: string, _signal: AbortSignal) => ({
      code: 'one-time-code',
      verifier: 'fixture-verifier',
      redirectUri: 'http://127.0.0.1:12345/callback'
    })),
    openBrowser = vi.fn(async () => {}),
    saveProfile = vi.fn((name: string, text: string) => profiles.save(name, text)),
    createContext = vi.fn((_record: RelayPluginRecord, signal: AbortSignal): OperationContext => ({
      signal,
      remainingMs: () => 10000,
      requester: { request: network },
      stage() {
        /* The Relay service persists validated metadata explicitly. */
      }
    }))
  const downloadDescriptor = vi.fn(async () => descriptorText)
  const pickDescriptor = vi.fn(async (): Promise<string | undefined> => descriptorText)
  const service = createRelayPluginService({
    downloadDescriptor,
    pickDescriptor,
    store,
    confirm,
    context: createContext,
    oauth,
    openBrowser,
    saveProfile
  })
  const install = async (): Promise<string> => {
    const result = await service.install({ text: descriptorText, route: 'proxy' })
    if (result.status !== 'installed') throw new Error('Fixture install failed')
    return result.id
  }
  return {
    context,
    crypto,
    store,
    profiles,
    service,
    network,
    confirm,
    oauth,
    openBrowser,
    saveProfile,
    createContext,
    downloadDescriptor,
    pickDescriptor,
    install,
    failConfig: (value: boolean) => {
      failConfig = value
    },
    config: (value: string) => {
      configText = value
    },
    failEnroll: (value: boolean) => {
      failEnroll = value
    },
    failRevoke: (value: boolean) => {
      failRevoke = value
    },
    discovery: (value: Record<string, unknown>) => {
      discoveryDocument = value
    },
    configDiscovery: (value: string | undefined) => {
      configDiscovery = value
    }
  }
}

async function revokeRecoveryFixture() {
  const f = await fixture(),
    id = await f.install()
  await f.service.login(id)
  const entry = await f.store.read(id),
    gateways = ['https://gateway.example', 'https://backup.example']
  if (!entry.record.discovery) throw new Error('Fixture discovery missing')
  await f.store.save({
    ...entry,
    record: {
      ...entry.record,
      approvedOrigins: [...entry.record.approvedOrigins, gateways[1]],
      discovery: { ...entry.record.discovery, gateways }
    }
  })
  const request = f.network.getMockImplementation()
  if (!request) throw new Error('Fixture requester missing')
  f.network.mockClear()
  f.confirm.mockClear()
  f.oauth.mockClear()
  return { ...f, id, gateways, request }
}

describe('Relay-owned plugin lifecycle using the pinned pure CPX protocol', () => {
  it('requires separate discovery consent and does not decrypt, log in, enroll or replace subscriptions', async () => {
    const f = await fixture(),
      id = await f.install()
    f.confirm.mockClear().mockResolvedValueOnce(false)
    expect(await f.service.rediscover(id)).toEqual({ status: 'cancelled' })
    expect(f.network).not.toHaveBeenCalled()
    expect(await f.service.rediscover(id)).toEqual({ status: 'rediscovered', id })
    expect(
      f.network.mock.calls.every(([url]) => new URL(url).pathname === '/.well-known/cpx-gateway')
    ).toBe(true)
    expect(f.crypto.decrypt).not.toHaveBeenCalled()
    expect(f.crypto.available).not.toHaveBeenCalled()
    expect(f.oauth).not.toHaveBeenCalled()
    const before = await f.store.read(id)
    expect(before.record.subscription).toBeUndefined()
    f.discovery({ spec: 'invalid' })
    await expect(f.service.rediscover(id)).rejects.toThrow('未确认')
    expect((await f.store.read(id)).record.discovery).toEqual(before.record.discovery)
  })
  it('pins a higher signed discovery before new-origin consent, rejects rollback and grants before decrypting an update', async () => {
    const key = generateKeyPairSync('ed25519'),
      pub = key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')
    const signed = (seq: number, gateway: string): string => {
      const bytes = Buffer.from(
        JSON.stringify({
          spec: 'cpx-plugin/2',
          seq,
          gateways: [gateway],
          endpoints: wellKnown.endpoints
        })
      )
      return (
        bytes.toString('base64') +
        '.' +
        sign(null, buildDiscoverySignInput(bytes), key.privateKey).toString('base64')
      )
    }
    const f = await fixture(JSON.stringify({ ...JSON.parse(descriptor), providerPubKey: pub }))
    f.discovery({ ...wellKnown, signed: signed(1, wellKnown.gateway) })
    const id = await f.install()
    await f.service.login(id)
    const before = await f.store.read(id),
      rotated = 'https://rotated.example'
    f.crypto.decrypt.mockClear()
    f.oauth.mockClear()
    f.discovery({ ...wellKnown, gateway: rotated, signed: signed(3, rotated) })
    f.confirm.mockImplementation(async (permission) => permission.action !== 'gateways')
    expect(await f.service.rediscover(id)).toEqual({ status: 'cancelled' })
    expect((await f.store.read(id)).record.discovery?.seq).toBe(3)
    expect((await f.store.read(id)).record.approvedOrigins).not.toContain(rotated)
    expect((await f.store.read(id)).encryptedCredential).toBe(before.encryptedCredential)
    expect((await f.store.read(id)).record.subscription).toEqual(before.record.subscription)
    const requests = f.network.mock.calls.length
    expect(await f.service.update(id)).toEqual({ status: 'cancelled' })
    expect(f.network).toHaveBeenCalledTimes(requests)
    expect(f.crypto.decrypt).not.toHaveBeenCalled()
    f.discovery({ ...wellKnown, signed: signed(2, wellKnown.gateway) })
    await expect(f.service.rediscover(id)).rejects.toThrow()
    expect((await f.store.read(id)).record.discovery?.seq).toBe(3)
    f.discovery({ ...wellKnown, gateway: rotated, signed: signed(3, rotated) })
    f.confirm.mockResolvedValue(true)
    expect(await f.service.rediscover(id)).toEqual({ status: 'rediscovered', id })
    expect((await f.store.read(id)).record.approvedOrigins).toContain(rotated)
    expect(f.crypto.decrypt).not.toHaveBeenCalled()
    expect(f.oauth).not.toHaveBeenCalled()
    expect((await f.service.update(id)).status).toBe('updated')
    expect(f.oauth).not.toHaveBeenCalled()
  })
  it('invalidates an old scheduler binding when explicit rediscovery changes the gateway', async () => {
    const f = await fixture(),
      id = await f.install()
    await f.service.login(id)
    const permit = await f.service.prepareSchedule(id)
    await permit.activate()
    const before = (await f.store.read(id)).record.subscription
    f.crypto.decrypt.mockClear()
    f.discovery({ ...wellKnown, gateway: 'https://new-gateway.example' })
    expect((await f.service.rediscover(id)).status).toBe('rediscovered')
    const requests = f.network.mock.calls.length
    expect((await permit.run()).status).toBe('changed')
    expect(f.network).toHaveBeenCalledTimes(requests)
    expect(f.crypto.decrypt).not.toHaveBeenCalled()
    expect((await f.store.read(id)).record.subscription).toEqual(before)
  })
  it('expires discovery permission before network work and waits for a cancelled confirmation', async () => {
    const f = await fixture(),
      id = await f.install()
    let clock = 1
    const timed = createRelayPluginService({
      store: f.store,
      context: f.createContext,
      openBrowser: f.openBrowser,
      saveProfile: f.saveProfile,
      now: () => clock,
      confirm: async () => {
        clock = 60002
        return true
      }
    })
    await expect(timed.rediscover(id)).rejects.toThrow()
    expect(f.network).not.toHaveBeenCalled()
    let answer: (value: boolean) => void = () => {
      throw new Error('No prompt.')
    }
    f.confirm.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    const previousPrompts = f.confirm.mock.calls.length
    const pending = f.service.rediscover(id)
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledTimes(previousPrompts + 1))
    const closing = f.service.requestClose()
    answer(true)
    await expect(pending).rejects.toThrow()
    await closing
    expect(f.network).not.toHaveBeenCalled()
  })
  it('previews an explicitly selected local file without installation, credentials or network work', async () => {
    const f = await fixture()
    expect(await f.service.previewFile()).toMatchObject({ status: 'preview', text: descriptor })
    expect((await f.service.state()).records).toEqual([])
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.crypto.available).not.toHaveBeenCalled()
    expect(f.network).not.toHaveBeenCalled()
    expect(f.downloadDescriptor).not.toHaveBeenCalled()
    f.pickDescriptor.mockResolvedValueOnce(undefined)
    expect(await f.service.previewFile()).toEqual({ status: 'cancelled' })
    f.pickDescriptor.mockResolvedValueOnce('{malformed}')
    await expect(f.service.previewFile()).rejects.toThrow()
    expect((await f.service.state()).records).toEqual([])
  })
  it('serializes local file reads, waits for the picker and discards its result after cancellation', async () => {
    const f = await fixture()
    let chosen: (text: string) => void = () => {
      throw new Error('No picker.')
    }
    f.pickDescriptor.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          chosen = resolve
        })
    )
    const pending = f.service.previewFile()
    expect((await f.service.state()).pending).toBe(true)
    await expect(f.service.install({ text: descriptor, route: 'proxy' })).rejects.toThrow()
    f.service.cancel()
    const idle = f.service.whenIdle()
    chosen(descriptor)
    await expect(pending).rejects.toThrow()
    await idle
    expect((await f.service.state()).pending).toBe(false)
    expect((await f.service.state()).records).toEqual([])
    expect(f.network).not.toHaveBeenCalled()
  })
  it('previews without networking and cancels installation before creating a record', async () => {
    const f = await fixture()
    expect(f.service.preview(descriptor).origins).toEqual(['https://provider.example'])
    expect(f.network).not.toHaveBeenCalled()
    f.confirm.mockResolvedValueOnce(false)
    expect(await f.service.install({ text: descriptor, route: 'proxy' })).toEqual({
      status: 'cancelled'
    })
    expect((await f.service.state()).records).toEqual([])
    expect(f.crypto.available).not.toHaveBeenCalled()
  })
  it('stores public metadata privately and does not log in or decrypt on listing', async () => {
    const f = await fixture(),
      id = await f.install()
    const state = await f.service.state()
    expect(state.records[0]).toMatchObject({ id, route: 'proxy', status: 'needs-login' })
    expect(state.automaticUpdatesEnabled).toBe(false)
    expect((await stat(join(f.context.stateRoot, 'Plugins', id, 'record.json'))).mode & 0o777).toBe(
      0o600
    )
    expect(f.network).not.toHaveBeenCalled()
    expect(f.crypto.decrypt).not.toHaveBeenCalled()
  })
  it('refuses login before discovery and browser opening when secure storage is unavailable', async () => {
    const f = await fixture(),
      id = await f.install()
    f.crypto.available.mockResolvedValue(false)
    await expect(f.service.login(id)).rejects.toThrow('未确认')
    expect(f.network).not.toHaveBeenCalled()
    expect(f.oauth).not.toHaveBeenCalled()
    expect((await f.service.state()).records[0].subscription).toBeUndefined()
  })
  it('requires a second permission for discovered origins before opening OAuth or enrolling', async () => {
    const f = await fixture(),
      id = await f.install()
    f.confirm.mockImplementation(async (permission) => permission.action !== 'gateways')
    expect(await f.service.login(id)).toEqual({ status: 'cancelled' })
    expect(f.network.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/.well-known/cpx-gateway'
    ])
    expect(f.oauth).not.toHaveBeenCalled()
    expect((await f.store.read(id)).record.approvedOrigins).toEqual(['https://provider.example'])
  })
  it('encrypts device keys and saves a private inactive subscription without touching a runtime', async () => {
    const f = await fixture(),
      id = await f.install()
    expect(await f.service.login(id)).toEqual({ status: 'updated', id })
    const entry = await f.store.read(id),
      credential = await f.store.credential(entry)
    expect(entry.record.status).toBe('active')
    expect(entry.record.approvedOrigins).toContain('https://gateway.example')
    expect(credential?.phase).toBe('active')
    const raw = await readFile(join(f.context.stateRoot, 'Plugins', id, 'record.json'), 'utf8')
    expect(raw).not.toContain(credential?.keys.privKeyB64)
    expect(raw).not.toContain('one-time-code')
    expect((await f.store.subscription(id)).text).toBe(configuration)
    expect(JSON.stringify(await f.service.state())).not.toContain('encryptedCredential')
    expect(f.saveProfile).not.toHaveBeenCalled()
  })
  it('reuses enrolled credentials after the first config fetch fails instead of enrolling again', async () => {
    const f = await fixture(),
      id = await f.install()
    f.failConfig(true)
    await expect(f.service.login(id)).rejects.toThrow('未确认')
    const initial = await f.store.credential(await f.store.read(id))
    f.failConfig(false)
    expect(await f.service.login(id)).toEqual({ status: 'updated', id })
    expect((await f.store.credential(await f.store.read(id)))?.keys.deviceId).toBe(
      initial?.keys.deviceId
    )
    expect(f.oauth).toHaveBeenCalledOnce()
    expect(
      f.network.mock.calls.filter(([url]) => new URL(url).pathname === '/enroll')
    ).toHaveLength(1)
  })
  it('retains prewritten keys when enroll may have been sent and recovers without replaying the code', async () => {
    const f = await fixture(),
      id = await f.install()
    f.failEnroll(true)
    await expect(f.service.login(id)).rejects.toThrow('未确认')
    const initial = await f.store.credential(await f.store.read(id))
    expect(initial?.phase).toBe('enrollment-pending')
    expect((await f.store.read(id)).record.status).toBe('uncertain')
    f.failEnroll(false)
    await f.service.login(id)
    expect(f.oauth).toHaveBeenCalledOnce()
    expect(
      f.network.mock.calls.filter(([url]) => new URL(url).pathname === '/enroll')
    ).toHaveLength(1)
    expect((await f.store.credential(await f.store.read(id)))?.keys.deviceId).toBe(
      initial?.keys.deviceId
    )
  })
  it('preserves the prior subscription after a malformed update', async () => {
    const f = await fixture(),
      id = await f.install()
    await f.service.login(id)
    const before = (await f.store.read(id)).record.subscription
    f.config('proxies: broken')
    await expect(f.service.update(id)).rejects.toThrow('未确认')
    expect((await f.store.read(id)).record.subscription).toEqual(before)
    expect((await f.store.subscription(id)).text).toBe(configuration)
  })
  it('preserves credentials on a failed revoke and only deletes local copies after explicit local-only removal', async () => {
    const f = await fixture(),
      id = await f.install()
    await f.service.login(id)
    const copied = await f.service.saveProfile(id)
    if (copied.status !== 'saved-profile') throw new Error('Missing copied profile')
    f.failRevoke(true)
    await expect(f.service.remove({ id, localOnly: false })).rejects.toThrow('未确认')
    expect((await f.store.read(id)).encryptedCredential).toBeDefined()
    expect(await f.service.remove({ id, localOnly: true })).toEqual({ status: 'removed', id })
    expect((await f.service.state()).records).toEqual([])
    expect(
      (await f.profiles.read({ id: copied.profile.id, sha256: copied.profile.sha256 })).text
    ).toBe(configuration)
  })
  it.each(['retired', 'unreachable', 'transient'] as const)(
    'revokes through the existing approved backup after a safe %s failure without discovery or OAuth',
    async (kind) => {
      const f = await revokeRecoveryFixture(),
        copied = await f.service.saveProfile(f.id)
      if (copied.status !== 'saved-profile') throw new Error('Fixture profile missing')
      f.confirm.mockClear()
      f.network.mockImplementation(async (url) => {
        if (new URL(url).origin === f.gateways[0] && new URL(url).pathname === '/revoke')
          throw new GatewayError(
            kind,
            'first gateway unavailable',
            kind === 'retired' ? 410 : undefined
          )
        return f.request(url)
      })
      expect(await f.service.remove({ id: f.id, localOnly: false })).toEqual({
        status: 'removed',
        id: f.id
      })
      expect(f.network.mock.calls.map(([url]) => url)).toEqual([
        f.gateways[0] + '/challenge',
        f.gateways[0] + '/revoke',
        f.gateways[1] + '/challenge',
        f.gateways[1] + '/revoke'
      ])
      expect(f.confirm.mock.calls.map(([permission]) => permission.action)).toEqual(['remove'])
      expect(f.oauth).not.toHaveBeenCalled()
      expect((await f.service.state()).records).toEqual([])
      expect(
        (await f.profiles.read({ id: copied.profile.id, sha256: copied.profile.sha256 })).text
      ).toBe(configuration)
    }
  )
  it('keeps the encrypted keys and confirmed subscription when every approved revoke gateway fails', async () => {
    const f = await revokeRecoveryFixture(),
      before = await f.store.read(f.id)
    f.network.mockImplementation(async (url) => {
      if (new URL(url).pathname === '/revoke')
        throw new GatewayError('unreachable', 'fixture unavailable')
      return f.request(url)
    })
    await expect(f.service.remove({ id: f.id, localOnly: false })).rejects.toThrow('未确认')
    const after = await f.store.read(f.id)
    expect(after.encryptedCredential).toEqual(before.encryptedCredential)
    expect(after.record.subscription).toEqual(before.record.subscription)
    expect((await f.store.subscription(f.id)).text).toBe(configuration)
    expect(f.network.mock.calls.map(([url]) => url)).toEqual([
      f.gateways[0] + '/challenge',
      f.gateways[0] + '/revoke',
      f.gateways[1] + '/challenge',
      f.gateways[1] + '/revoke'
    ])
  })
  it.each([
    new GatewayError('blocked', 'guard refused'),
    new GatewayError('transient', 'HTTP unauthorized', 401),
    new GatewayError('transient', 'HTTP forbidden', 403),
    new GatewayError('transient', 'HTTP server failure', 500)
  ])('stops revoke recovery on a terminal gateway failure (case %#)', async (failure) => {
    const f = await revokeRecoveryFixture(),
      before = await f.store.read(f.id)
    f.network.mockRejectedValueOnce(failure)
    await expect(f.service.remove({ id: f.id, localOnly: false })).rejects.toThrow('未确认')
    expect(f.network.mock.calls.map(([url]) => url)).toEqual([f.gateways[0] + '/challenge'])
    const after = await f.store.read(f.id)
    expect(after.encryptedCredential).toEqual(before.encryptedCredential)
    expect(after.record.subscription).toEqual(before.record.subscription)
  })
  it('accepts a confirmed revoked device as already removed without contacting another gateway', async () => {
    const f = await revokeRecoveryFixture()
    f.network.mockImplementation(async (url) =>
      new URL(url).pathname === '/revoke'
        ? { status: 403, headers: {}, body: '{"error":"device_revoked"}' }
        : f.request(url)
    )
    expect(await f.service.remove({ id: f.id, localOnly: false })).toEqual({
      status: 'removed',
      id: f.id
    })
    expect(f.network.mock.calls.map(([url]) => url)).toEqual([
      f.gateways[0] + '/challenge',
      f.gateways[0] + '/revoke'
    ])
    expect((await f.service.state()).records).toEqual([])
  })
  it('preserves local data on close and waits for an in-flight challenge without sending revoke or changing gateway', async () => {
    const f = await revokeRecoveryFixture(),
      before = await f.store.read(f.id),
      response = Promise.withResolvers<PluginResponse>()
    f.network.mockImplementationOnce(() => response.promise)
    const removing = f.service.remove({ id: f.id, localOnly: false }),
      rejected = expect(removing).rejects.toThrow('已取消')
    await vi.waitFor(() => expect(f.network).toHaveBeenCalledTimes(1))
    const closed = vi.fn(),
      closing = f.service.requestClose().then(closed)
    expect(f.service.isBlocking()).toBe(true)
    expect(closed).not.toHaveBeenCalled()
    await expect(f.service.update(f.id)).rejects.toThrow('结束当前')
    response.resolve(await f.request(f.gateways[0] + '/challenge'))
    await rejected
    await closing
    expect(closed).toHaveBeenCalledTimes(1)
    expect(f.service.isBlocking()).toBe(false)
    expect(f.network.mock.calls.map(([url]) => url)).toEqual([f.gateways[0] + '/challenge'])
    const after = await f.store.read(f.id)
    expect(after.encryptedCredential).toEqual(before.encryptedCredential)
    expect(after.record.subscription).toEqual(before.record.subscription)
  })
  it('cancels browser waiting and blocks a second write until the current operation is finished', async () => {
    const f = await fixture(),
      id = await f.install()
    f.oauth.mockImplementationOnce(
      (_url, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })
        )
    )
    const loggingIn = f.service.login(id)
    const rejection = expect(loggingIn).rejects.toThrow('已取消')
    await vi.waitFor(() => expect(f.oauth).toHaveBeenCalled())
    expect(f.service.isBlocking()).toBe(true)
    await expect(f.service.update(id)).rejects.toThrow('结束当前')
    await f.service.requestClose()
    await rejection
    expect(f.service.isBusy()).toBe(false)
    expect((await f.store.read(id)).encryptedCredential).toBeUndefined()
  })
  it('rejects a signed discovery rollback without overwriting the current subscription or sequence', async () => {
    const key = generateKeyPairSync('ed25519'),
      pub = key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')
    const signed = (seq: number): string => {
      const bytes = Buffer.from(
        JSON.stringify({
          spec: 'cpx-plugin/2',
          seq,
          gateways: [wellKnown.gateway],
          endpoints: wellKnown.endpoints
        })
      )
      return (
        bytes.toString('base64') +
        '.' +
        sign(null, buildDiscoverySignInput(bytes), key.privateKey).toString('base64')
      )
    }
    const f = await fixture(JSON.stringify({ ...JSON.parse(descriptor), providerPubKey: pub }))
    f.discovery({ ...wellKnown, signed: signed(2) })
    const id = await f.install()
    await f.service.login(id)
    const before = (await f.store.read(id)).record.subscription
    f.configDiscovery(signed(1))
    await expect(f.service.update(id)).rejects.toThrow('未确认')
    expect((await f.store.read(id)).record.discovery?.seq).toBe(2)
    expect((await f.store.read(id)).record.subscription).toEqual(before)
  })
  it('commits a newly seen signed sequence before permission and never contacts an unapproved rotated gateway', async () => {
    const key = generateKeyPairSync('ed25519'),
      pub = key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')
    const signed = (seq: number, gateway: string): string => {
      const bytes = Buffer.from(
        JSON.stringify({
          spec: 'cpx-plugin/2',
          seq,
          gateways: [gateway],
          endpoints: wellKnown.endpoints
        })
      )
      return (
        bytes.toString('base64') +
        '.' +
        sign(null, buildDiscoverySignInput(bytes), key.privateKey).toString('base64')
      )
    }
    const f = await fixture(JSON.stringify({ ...JSON.parse(descriptor), providerPubKey: pub }))
    f.discovery({ ...wellKnown, signed: signed(2, wellKnown.gateway) })
    const id = await f.install()
    await f.service.login(id)
    const before = (await f.store.read(id)).record.subscription
    f.confirm.mockImplementation(async (permission) => permission.action !== 'gateways')
    f.configDiscovery(signed(3, 'https://new-gateway.example'))
    expect(await f.service.update(id)).toEqual({ status: 'cancelled' })
    expect((await f.store.read(id)).record.discovery?.seq).toBe(3)
    expect((await f.store.read(id)).record.subscription).toEqual(before)
    const calls = f.network.mock.calls.length
    expect(await f.service.update(id)).toEqual({ status: 'cancelled' })
    expect(f.network.mock.calls).toHaveLength(calls)
    expect(f.network.mock.calls.some(([url]) => url.includes('new-gateway'))).toBe(false)
  })
  it('refuses stale metadata writes and tampered private snapshots before exporting a profile', async () => {
    const f = await fixture(),
      id = await f.install(),
      stale = await f.store.read(id)
    await f.service.login(id)
    await expect(f.store.save(stale)).rejects.toThrow('已改变')
    const entry = await f.store.read(id)
    if (!entry.record.subscription) throw new Error('Missing saved fixture')
    const { writeFile } = await import('fs/promises')
    await writeFile(
      join(
        f.context.stateRoot,
        'Plugins',
        id,
        'Subscriptions',
        entry.record.subscription.sha256 + '.yaml'
      ),
      'tampered'
    )
    await expect(f.service.saveProfile(id)).rejects.toThrow('未确认')
    expect(f.saveProfile).not.toHaveBeenCalled()
  })
  it('reports a storage acknowledgement failure as uncertain and preserves the last confirmed subscription', async () => {
    const f = await fixture(),
      id = await f.install()
    await f.service.login(id)
    const before = (await f.store.read(id)).record.subscription,
      save = f.store.save.bind(f.store)
    vi.spyOn(f.store, 'save').mockImplementationOnce(async (entry) => {
      await save(entry)
      throw new RelayPluginStorageUncertain()
    })
    await expect(f.service.update(id)).rejects.toThrow('未确认')
    expect((await f.service.state()).uncertain).toBe(true)
    expect((await f.store.read(id)).record.subscription).toEqual(before)
    expect((await f.store.read(id)).record.lastError).toBe('storage')
  })
  it('creates an inactive session capability and updates without another dialog, OAuth or credential rewrite', async () => {
    const f = await fixture(),
      id = await f.install()
    await f.service.login(id)
    f.confirm.mockClear()
    f.oauth.mockClear()
    f.crypto.encrypt.mockClear()
    f.crypto.decrypt.mockClear()
    const permit = await f.service.prepareSchedule(id),
      before = f.network.mock.calls.length
    expect(await permit.run()).toEqual({ status: 'cancelled' })
    expect(f.network.mock.calls).toHaveLength(before)
    expect(f.crypto.decrypt).not.toHaveBeenCalled()
    expect(JSON.stringify(permit.permission)).not.toContain('Credential')
    await permit.activate()
    expect(await permit.run()).toEqual({ status: 'updated' })
    expect(await permit.run()).toEqual({ status: 'updated' })
    expect(f.crypto.decrypt).toHaveBeenCalledOnce()
    expect(f.crypto.encrypt).not.toHaveBeenCalled()
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.oauth).not.toHaveBeenCalled()
    permit.revoke()
    expect(await permit.run()).toEqual({ status: 'cancelled' })
    await expect(permit.activate()).rejects.toThrow('失效')
  })
  it.each(['route', 'origins', 'discovery'] as const)(
    'rejects %s changes made during schedule confirmation',
    async (field) => {
      const f = await fixture(),
        id = await f.install()
      await f.service.login(id)
      const permit = await f.service.prepareSchedule(id),
        entry = await f.store.read(id),
        before = f.network.mock.calls.length
      await f.store.save({
        ...entry,
        record: {
          ...entry.record,
          ...(field === 'route' ? { route: 'direct' as const } : {}),
          ...(field === 'origins'
            ? { approvedOrigins: [...entry.record.approvedOrigins, 'https://new.example'] }
            : {}),
          ...(field === 'discovery'
            ? {
                lastGoodTarget: undefined,
                discovery: {
                  ...wellKnown,
                  gateways: ['https://gateway.example'],
                  endpoints: { ...wellKnown.endpoints, config: '/new-config' }
                }
              }
            : {})
        }
      })
      await expect(permit.activate()).rejects.toThrow('已改变')
      expect(f.network.mock.calls).toHaveLength(before)
      permit.revoke()
    }
  )
  it('checks the binding after each response and preserves the old snapshot after an in-flight record change', async () => {
    const f = await fixture(),
      id = await f.install()
    await f.service.login(id)
    const permit = await f.service.prepareSchedule(id)
    await permit.activate()
    const before = (await f.store.read(id)).record.subscription
    f.network.mockImplementationOnce(async () => {
      const entry = await f.store.read(id)
      await f.store.save({ ...entry, record: { ...entry.record, route: 'direct' } })
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ nonceId: 'nonce', nonce: Buffer.alloc(32, 1).toString('base64') })
      }
    })
    expect(await permit.run()).toEqual({ status: 'changed' })
    expect((await f.store.read(id)).record.subscription).toEqual(before)
    permit.revoke()
  })
  it('retains the signed rotation evidence and stops before any background permission or new-origin request', async () => {
    const key = generateKeyPairSync('ed25519'),
      pub = key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
      signed = (seq: number, gateway: string): string => {
        const bytes = Buffer.from(
          JSON.stringify({
            spec: 'cpx-plugin/2',
            seq,
            gateways: [gateway],
            endpoints: wellKnown.endpoints
          })
        )
        return (
          bytes.toString('base64') +
          '.' +
          sign(null, buildDiscoverySignInput(bytes), key.privateKey).toString('base64')
        )
      },
      f = await fixture(JSON.stringify({ ...JSON.parse(descriptor), providerPubKey: pub }))
    f.discovery({ ...wellKnown, signed: signed(2, wellKnown.gateway) })
    const id = await f.install()
    await f.service.login(id)
    const before = (await f.store.read(id)).record.subscription,
      permit = await f.service.prepareSchedule(id)
    await permit.activate()
    f.confirm.mockClear()
    f.configDiscovery(signed(3, 'https://new-gateway.example'))
    expect(await permit.run()).toEqual({ status: 'changed' })
    expect((await f.store.read(id)).record.discovery?.seq).toBe(3)
    expect((await f.store.read(id)).record.subscription).toEqual(before)
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.network.mock.calls.some(([url]) => url.includes('new-gateway'))).toBe(false)
    permit.revoke()
  })
  it('keeps the same snapshot on transient failure and advances only its own error revision for later retries', async () => {
    const f = await fixture(),
      id = await f.install()
    await f.service.login(id)
    const permit = await f.service.prepareSchedule(id),
      before = (await f.store.read(id)).record.subscription
    await permit.activate()
    f.failConfig(true)
    expect(await permit.run()).toEqual({ status: 'failed' })
    expect((await f.store.read(id)).record.subscription).toEqual(before)
    f.failConfig(false)
    expect(await permit.run()).toEqual({ status: 'updated' })
    permit.revoke()
  })
  it('stops on revoked credentials without opening OAuth and retains the saved subscription', async () => {
    const f = await fixture(),
      id = await f.install()
    await f.service.login(id)
    const permit = await f.service.prepareSchedule(id),
      before = (await f.store.read(id)).record.subscription
    await permit.activate()
    f.oauth.mockClear()
    f.network.mockResolvedValueOnce({ status: 403, headers: {}, body: '{"error":"revoked"}' })
    expect(await permit.run()).toEqual({ status: 'credentials' })
    expect((await f.store.read(id)).record.status).toBe('needs-reauth')
    expect((await f.store.read(id)).encryptedCredential).toBeUndefined()
    expect((await f.store.read(id)).record.subscription).toEqual(before)
    expect(f.oauth).not.toHaveBeenCalled()
    permit.revoke()
  })
  it('revokes in-flight and unactivated capabilities on close without replacing the old snapshot', async () => {
    const f = await fixture(),
      id = await f.install()
    await f.service.login(id)
    const permit = await f.service.prepareSchedule(id),
      unused = await f.service.prepareSchedule(id),
      before = (await f.store.read(id)).record.subscription
    await permit.activate()
    f.createContext.mockImplementationOnce((_record, signal) => ({
      signal,
      remainingMs: () => 10000,
      stage() {
        /* No staged metadata in this abort fixture. */
      },
      requester: {
        request: async () =>
          new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          )
      }
    }))
    const updating = permit.run()
    await vi.waitFor(() => expect(f.service.isBlocking()).toBe(true))
    await f.service.requestClose()
    expect(await updating).toEqual({ status: 'cancelled' })
    await expect(unused.activate()).rejects.toThrow('失效')
    expect((await f.store.read(id)).record.subscription).toEqual(before)
    expect(f.service.isBusy()).toBe(false)
  })
  it('reports an unacknowledged scheduled cache write as uncertain without retrying under the old binding', async () => {
    const f = await fixture(),
      id = await f.install()
    await f.service.login(id)
    const permit = await f.service.prepareSchedule(id),
      before = (await f.store.read(id)).record.subscription
    await permit.activate()
    vi.spyOn(f.store, 'saveSubscription').mockRejectedValueOnce(new RelayPluginStorageUncertain())
    expect(await permit.run()).toEqual({ status: 'uncertain' })
    expect((await f.service.state()).uncertain).toBe(true)
    expect((await f.store.read(id)).record.subscription).toEqual(before)
    permit.revoke()
  })
  it('accepts an identical signed discovery including rotated login metadata without another permission', async () => {
    const key = generateKeyPairSync('ed25519'),
      pub = key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64'),
      bytes = Buffer.from(
        JSON.stringify({
          spec: 'cpx-plugin/2',
          seq: 2,
          gateways: [wellKnown.gateway],
          endpoints: wellKnown.endpoints,
          loginUrl: 'https://provider.example/authorize-2'
        })
      ),
      signed =
        bytes.toString('base64') +
        '.' +
        sign(null, buildDiscoverySignInput(bytes), key.privateKey).toString('base64'),
      f = await fixture(JSON.stringify({ ...JSON.parse(descriptor), providerPubKey: pub }))
    f.discovery({ ...wellKnown, signed })
    const id = await f.install()
    await f.service.login(id)
    const permit = await f.service.prepareSchedule(id)
    await permit.activate()
    f.confirm.mockClear()
    f.configDiscovery(signed)
    expect(await permit.run()).toEqual({ status: 'updated' })
    expect(f.confirm).not.toHaveBeenCalled()
    permit.revoke()
  })
  it('stops an HTTP authentication failure but preserves the encrypted keys for manual recovery', async () => {
    const f = await fixture(),
      id = await f.install()
    await f.service.login(id)
    const before = await f.store.read(id),
      permit = await f.service.prepareSchedule(id)
    await permit.activate()
    f.network.mockResolvedValueOnce({ status: 401, headers: {}, body: '{}' })
    expect(await permit.run()).toEqual({ status: 'credentials' })
    expect((await f.store.read(id)).encryptedCredential).toBe(before.encryptedCredential)
    expect((await f.store.read(id)).record.subscription).toEqual(before.record.subscription)
    expect((await f.service.state()).automaticUpdatesEnabled).toBe(false)
  })
  it('does not replace the subscription when authorization is revoked immediately before cache commit', async () => {
    const f = await fixture(),
      id = await f.install()
    await f.service.login(id)
    const before = (await f.store.read(id)).record.subscription,
      permit = await f.service.prepareSchedule(id),
      save = f.store.saveSubscription.bind(f.store)
    await permit.activate()
    vi.spyOn(f.store, 'saveSubscription').mockImplementationOnce(async (...args) => {
      permit.revoke()
      return save(...args)
    })
    expect(await permit.run()).toEqual({ status: 'cancelled' })
    expect((await f.store.read(id)).record.subscription).toEqual(before)
  })
  it('checks revocation after the final CAS read resolves and before starting metadata replacement', async () => {
    const f = await fixture(),
      id = await f.install()
    await f.service.login(id)
    const before = (await f.store.read(id)).record.subscription,
      permit = await f.service.prepareSchedule(id),
      read = f.store.read.bind(f.store),
      save = f.store.save.bind(f.store)
    await permit.activate()
    let block = false,
      waiting = false,
      release: () => void = () => {
        throw new Error('CAS fixture is not waiting')
      }
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(f.store, 'save').mockImplementationOnce(async (...args) => {
      block = true
      return save(...args)
    })
    vi.spyOn(f.store, 'read').mockImplementation(async (selected) => {
      const entry = await read(selected)
      if (block && !waiting) {
        waiting = true
        await gate
      }
      return entry
    })
    const updating = permit.run()
    await vi.waitFor(() => expect(waiting).toBe(true))
    permit.revoke()
    release()
    expect(await updating).toEqual({ status: 'cancelled' })
    expect((await f.store.read(id)).record.subscription).toEqual(before)
  })
  it('runs the real private service capability only after the scheduler period and revokes it on close', async () => {
    const f = await fixture(),
      id = await f.install()
    await f.service.login(id)
    f.confirm.mockClear()
    f.oauth.mockClear()
    const before = f.network.mock.calls.length,
      confirm = vi.fn(async () => true),
      scheduler = createRelayPluginScheduler({
        prepare: (selected) => f.service.prepareSchedule(selected),
        confirm,
        canRun: () => !f.service.isBusy()
      })
    vi.useFakeTimers()
    try {
      await scheduler.arm({ id, minutes: 1 })
      await vi.advanceTimersByTimeAsync(59999)
      expect(f.network.mock.calls).toHaveLength(before)
      await vi.advanceTimersByTimeAsync(1)
      await scheduler.whenIdle()
      expect(scheduler.state().entries[0]).toMatchObject({ enabled: true, lastStatus: 'updated' })
      expect(f.network.mock.calls).toHaveLength(before + 2)
      expect(confirm).toHaveBeenCalledOnce()
      expect(f.confirm).not.toHaveBeenCalled()
      expect(f.oauth).not.toHaveBeenCalled()
      await scheduler.requestClose()
      expect((await f.service.state()).automaticUpdatesEnabled).toBe(false)
      await vi.advanceTimersByTimeAsync(120000)
      expect(f.network.mock.calls).toHaveLength(before + 2)
    } finally {
      await scheduler.requestClose()
      vi.useRealTimers()
    }
  })
})

describe('Remote public descriptor is a separate consented draft', () => {
  const source = { url: 'https://provider.example/plugin.cpx', route: 'proxy' }
  it('cancels before any request and never installs or opens OAuth while previewing', async () => {
    const f = await fixture()
    f.confirm.mockResolvedValueOnce(false)
    expect(await f.service.previewRemote(source)).toEqual({ status: 'cancelled' })
    expect(f.downloadDescriptor).not.toHaveBeenCalled()
    expect((await f.service.previewRemote(source)).status).toBe('preview')
    expect(f.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'preview-remote',
        origins: ['https://provider.example'],
        route: 'proxy'
      })
    )
    expect((await f.service.state()).records).toHaveLength(0)
    expect(f.oauth).not.toHaveBeenCalled()
    expect(f.openBrowser).not.toHaveBeenCalled()
  })
  it('keeps invalid remote content from becoming an installable draft', async () => {
    const f = await fixture()
    f.downloadDescriptor.mockResolvedValueOnce('<html>not CPX</html>')
    await expect(f.service.previewRemote(source)).rejects.toThrow('未确认')
    expect(f.service.isBusy()).toBe(false)
    expect((await f.service.state()).records).toHaveLength(0)
  })
  it('holds the plugin ownership gate and cancels a pending download without returning a late draft', async () => {
    const f = await fixture()
    let finish!: (value: string) => void
    f.downloadDescriptor.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve
        })
    )
    const fetching = f.service.previewRemote(source),
      rejected = expect(fetching).rejects.toThrow('取消')
    await vi.waitFor(() => expect(f.downloadDescriptor).toHaveBeenCalled())
    expect(f.service.isBusy()).toBe(true)
    await expect(f.service.install({ text: descriptor, route: 'proxy' })).rejects.toThrow('结束')
    const closing = f.service.requestClose()
    finish(descriptor)
    await rejected
    await closing
    expect(f.service.isBusy()).toBe(false)
    expect((await f.service.state()).records).toHaveLength(0)
  })
})

describe('Finite plugin gateway recovery proposal', () => {
  it('uses a backup for safe no-status transient without redoing OAuth', async () => {
    const f = await revokeRecoveryFixture()
    f.network.mockImplementation(async (url) => {
      if (url === f.gateways[0] + '/config')
        throw new GatewayError('transient', 'no HTTP response', undefined, 'possibly-sent')
      return f.request(url)
    })
    expect(await f.service.update(f.id)).toEqual({ status: 'updated', id: f.id })
    expect(f.network.mock.calls.map(([url]) => url)).toContain(f.gateways[1] + '/config')
    expect(f.oauth).not.toHaveBeenCalled()
    expect((await f.store.read(f.id)).record).toHaveProperty('lastGoodTarget')
  })
  it('switches enrollment gateway only after a proven pre-send unreachable error with the same code and keys', async () => {
    const f = await fixture(),
      gateways = [wellKnown.gateway, 'https://backup.example']
    f.discovery({ ...wellKnown, gateways })
    const original = f.network.getMockImplementation()
    if (!original) throw new Error('missing fixture request')
    f.network.mockImplementation(async (url) => {
      if (url === gateways[0] + '/enroll')
        throw new GatewayError('unreachable', 'never sent', undefined, 'pre-send')
      return original(url)
    })
    const id = await f.install()
    expect(await f.service.login(id)).toEqual({ status: 'updated', id })
    expect(
      f.network.mock.calls.map(([url]) => url).filter((url) => url.endsWith('/enroll'))
    ).toEqual(gateways.map((gateway) => gateway + '/enroll'))
    expect(f.oauth).toHaveBeenCalledOnce()
    expect((await f.store.credential(await f.store.read(id)))?.phase).toBe('active')
  })
  it('performs only one signed rediscovery after exhausting switchable targets and commits the floor before new-origin permission', async () => {
    const key = generateKeyPairSync('ed25519'),
      pub = key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')
    const signed = (seq: number, gateway: string) => {
      const bytes = Buffer.from(
        JSON.stringify({
          spec: 'cpx-plugin/2',
          seq,
          gateways: [gateway],
          endpoints: wellKnown.endpoints
        })
      )
      return (
        bytes.toString('base64') +
        '.' +
        sign(null, buildDiscoverySignInput(bytes), key.privateKey).toString('base64')
      )
    }
    const f = await fixture(JSON.stringify({ ...JSON.parse(descriptor), providerPubKey: pub }))
    f.discovery({ ...wellKnown, signed: signed(2, wellKnown.gateway) })
    const id = await f.install()
    await f.service.login(id)
    const before = await f.store.read(id),
      original = f.network.getMockImplementation(),
      next = 'https://rotated.example'
    if (!original) throw new Error('missing fixture request')
    f.discovery({ ...wellKnown, gateway: next, signed: signed(3, next) })
    f.network.mockClear()
    f.oauth.mockClear()
    f.network.mockImplementation(async (url) => {
      if (url === wellKnown.gateway + '/config')
        throw new GatewayError('retired', 'old gateway retired', 410)
      return original(url)
    })
    f.confirm.mockImplementation(async (permission) => {
      if (permission.action === 'gateways') {
        expect((await f.store.read(id)).record.discovery?.seq).toBe(3)
        expect(f.network.mock.calls.some(([url]) => url.startsWith(next))).toBe(false)
      }
      return true
    })
    expect(await f.service.update(id)).toEqual({ status: 'updated', id })
    expect(
      f.network.mock.calls.filter(([url]) => url.endsWith('/.well-known/cpx-gateway'))
    ).toHaveLength(1)
    expect((await f.store.read(id)).record.discovery?.seq).toBe(3)
    expect((await f.store.read(id)).record.subscription?.sha256).toBe(
      before.record.subscription?.sha256
    )
    expect(f.oauth).not.toHaveBeenCalled()
  })
  it('advances only its own preference/subscription CAS and keeps the same background permit usable for the next run', async () => {
    const f = await revokeRecoveryFixture()
    f.network.mockImplementation(async (url) => {
      if (url === f.gateways[0] + '/config') throw new GatewayError('transient', 'no HTTP response')
      return f.request(url)
    })
    const permit = await f.service.prepareSchedule(f.id)
    await permit.activate()
    expect(await permit.run()).toEqual({ status: 'updated' })
    f.network.mockClear()
    expect(await permit.run()).toEqual({ status: 'updated' })
    expect(f.network.mock.calls[0][0]).toBe(f.gateways[1] + '/challenge')
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.oauth).not.toHaveBeenCalled()
    permit.revoke()
  })
})

describe('Finite plugin gateway authority and preference boundaries', () => {
  it.each([
    new GatewayError('unreachable', 'may have been sent', undefined, 'possibly-sent'),
    new GatewayError('retired', 'HTTP retired', 410, 'pre-send'),
    new GatewayError('transient', 'timeout without response', undefined, 'pre-send'),
    new GatewayError('transient', 'HTTP unauthorized', 401, 'pre-send'),
    new GatewayError('blocked', 'policy denied', undefined, 'pre-send')
  ])(
    'does not replay a consuming enrollment after a terminal or uncertain failure: %j',
    async (failure) => {
      const f = await fixture(),
        gateways = [wellKnown.gateway, 'https://backup.example']
      f.discovery({ ...wellKnown, gateways })
      const original = f.network.getMockImplementation()
      if (!original) throw new Error('missing fixture request')
      f.network.mockImplementation(async (url) => {
        if (url === gateways[0] + '/enroll') throw failure
        return original(url)
      })
      const id = await f.install()
      await expect(f.service.login(id)).rejects.toThrow()
      expect(
        f.network.mock.calls.map(([url]) => url).filter((url) => url.endsWith('/enroll'))
      ).toEqual([gateways[0] + '/enroll'])
      expect(
        f.network.mock.calls.filter(([url]) => url.endsWith('/.well-known/cpx-gateway'))
      ).toHaveLength(1)
      expect(f.oauth).toHaveBeenCalledOnce()
      expect((await f.store.credential(await f.store.read(id)))?.phase).toBe('enrollment-pending')
    }
  )
  it.each([
    new GatewayError('transient', 'HTTP unauthorized', 401),
    new GatewayError('unreachable', 'inconsistent HTTP-marked error', 403, 'pre-send'),
    new GatewayError('blocked', 'guard denied')
  ])(
    'keeps safe HTTP/auth/policy terminal errors from switching or rediscovering: %j',
    async (failure) => {
      const f = await revokeRecoveryFixture(),
        before = await f.store.read(f.id)
      f.network.mockImplementation(async (url) => {
        if (url.endsWith('/config')) throw failure
        return f.request(url)
      })
      await expect(f.service.update(f.id)).rejects.toThrow()
      expect(f.network.mock.calls.map(([url]) => url)).toEqual([
        f.gateways[0] + '/challenge',
        f.gateways[0] + '/config'
      ])
      expect((await f.store.read(f.id)).record.subscription).toEqual(before.record.subscription)
      expect(f.oauth).not.toHaveBeenCalled()
    }
  )
  it('does not retry the same complete targets after one unchanged rediscovery', async () => {
    const f = await revokeRecoveryFixture()
    f.discovery({ ...wellKnown, gateways: f.gateways })
    f.network.mockImplementation(async (url) => {
      if (url.endsWith('/config')) throw new GatewayError('transient', 'no response')
      return f.request(url)
    })
    await expect(f.service.update(f.id)).rejects.toThrow()
    expect(f.network.mock.calls.filter(([url]) => url.endsWith('/config'))).toHaveLength(2)
    expect(
      f.network.mock.calls.filter(([url]) => url.endsWith('/.well-known/cpx-gateway'))
    ).toHaveLength(1)
  })
  it('retains old no-preference records and rejects a preference for an unknown current target', async () => {
    const f = await revokeRecoveryFixture(),
      entry = await f.store.read(f.id),
      record = { ...entry.record }
    delete record.lastGoodTarget
    const old = await f.store.save({ ...entry, record })
    expect(old.record.lastGoodTarget).toBeUndefined()
    await expect(
      f.store.save({ ...old, record: { ...old.record, lastGoodTarget: 'a'.repeat(64) } })
    ).rejects.toThrow('当前完整网关目标')
    expect((await f.store.read(f.id)).revision).toBe(old.revision)
  })
  it('binds preference to all four endpoint paths and both signed epoch markers', async () => {
    const f = await revokeRecoveryFixture(),
      entry = await f.store.read(f.id),
      d = entry.record.discovery
    if (!d) throw new Error('missing fixture discovery')
    const key = pluginTargetKey(d, d.gateways[0])
    for (const name of ['enroll', 'challenge', 'config', 'revoke'] as const)
      expect(
        pluginTargetKey(
          { ...d, endpoints: { ...d.endpoints, [name]: '/v2' + d.endpoints[name] } },
          d.gateways[0]
        )
      ).not.toBe(key)
    expect(pluginTargetKey({ ...d, seq: 2, digest: 'b'.repeat(64) }, d.gateways[0])).not.toBe(
      pluginTargetKey({ ...d, seq: 3, digest: 'b'.repeat(64) }, d.gateways[0])
    )
    expect(pluginTargetKey({ ...d, seq: 2, digest: 'b'.repeat(64) }, d.gateways[0])).not.toBe(
      pluginTargetKey({ ...d, seq: 2, digest: 'c'.repeat(64) }, d.gateways[0])
    )
  })
  it('clears an old preference on acknowledged endpoint replacement while leaving the signed candidate fields intact', async () => {
    const f = await revokeRecoveryFixture(),
      entry = await f.store.read(f.id)
    expect(entry.record.lastGoodTarget).toBeDefined()
    const endpoints = { ...wellKnown.endpoints, config: '/v2/config' }
    f.discovery({ ...wellKnown, gateways: f.gateways, endpoints })
    expect(await f.service.rediscover(f.id)).toEqual({ status: 'rediscovered', id: f.id })
    const saved = await f.store.read(f.id)
    expect(saved.record.lastGoodTarget).toBeUndefined()
    expect(saved.record.discovery).toEqual({ gateways: f.gateways, endpoints })
    expect(saved.record.subscription).toEqual(entry.record.subscription)
  })
  it('does not let a preferred unapproved target grant itself network permission', async () => {
    const f = await revokeRecoveryFixture(),
      entry = await f.store.read(f.id),
      d = entry.record.discovery
    if (!d) throw new Error('missing fixture discovery')
    await f.store.save({
      ...entry,
      record: {
        ...entry.record,
        approvedOrigins: entry.record.approvedOrigins.filter((origin) => origin !== f.gateways[1]),
        lastGoodTarget: pluginTargetKey(d, f.gateways[1])
      }
    })
    f.confirm.mockImplementation(async (permission) => permission.action !== 'gateways')
    expect(await f.service.update(f.id)).toEqual({ status: 'cancelled' })
    expect(f.network).not.toHaveBeenCalled()
  })
  it('keeps remove within its current authorized list without an inline discovery', async () => {
    const f = await revokeRecoveryFixture()
    f.network.mockImplementation(async (url) => {
      if (url.endsWith('/revoke')) throw new GatewayError('transient', 'no response')
      return f.request(url)
    })
    await expect(f.service.remove({ id: f.id, localOnly: false })).rejects.toThrow()
    expect(f.network.mock.calls.filter(([url]) => url.endsWith('/revoke'))).toHaveLength(2)
    expect(f.network.mock.calls.some(([url]) => url.endsWith('/.well-known/cpx-gateway'))).toBe(
      false
    )
    expect((await f.store.read(f.id)).encryptedCredential).toBeDefined()
  })
  it('keeps a single original transport deadline instead of rebuilding it after gateway failures', async () => {
    const f = await revokeRecoveryFixture()
    let time = 0
    f.createContext.mockImplementation((record, signal) =>
      createRelayPluginContext({
        record,
        signal,
        now: () => time,
        proxy: async () => ({ host: '127.0.0.1', port: 18191 }),
        resolveAll: async () => [{ address: '93.184.216.34', family: 4 }],
        request: f.network
      })
    )
    f.network.mockImplementation(async (url) => {
      if (url.endsWith('/config')) {
        time = 119500
        throw new GatewayError('transient', 'late failure')
      }
      return f.request(url)
    })
    f.createContext.mockClear()
    await expect(f.service.update(f.id)).rejects.toThrow()
    expect(f.createContext).toHaveBeenCalledOnce()
    expect(f.network.mock.calls.map(([url]) => url)).toEqual([
      f.gateways[0] + '/challenge',
      f.gateways[0] + '/config'
    ])
  })
  it('refuses a concurrent manual action while a background request owns the operation', async () => {
    let release!: (value: PluginResponse) => void
    const gate = {
      promise: new Promise<PluginResponse>((resolve) => {
        release = resolve
      }),
      resolve: (value: PluginResponse) => release(value)
    }
    const f = await revokeRecoveryFixture(),
      permit = await f.service.prepareSchedule(f.id)
    await permit.activate()
    f.network.mockImplementationOnce(() => gate.promise)
    const running = permit.run()
    while (!f.service.isBusy()) await Promise.resolve()
    await expect(f.service.update(f.id)).rejects.toThrow('结束当前插件')
    gate.resolve(await f.request(f.gateways[0] + '/challenge'))
    expect(await running).toEqual({ status: 'updated' })
    permit.revoke()
  })
  it('treats a foreign preference-only CAS during background work as an external record change', async () => {
    const f = await revokeRecoveryFixture(),
      permit = await f.service.prepareSchedule(f.id)
    await permit.activate()
    f.network.mockImplementationOnce(async (url) => {
      const entry = await f.store.read(f.id),
        d = entry.record.discovery
      if (!d) throw new Error('missing fixture discovery')
      await f.store.save({
        ...entry,
        record: { ...entry.record, lastGoodTarget: pluginTargetKey(d, f.gateways[1]) }
      })
      return f.request(url)
    })
    expect(await permit.run()).toEqual({ status: 'changed' })
    expect(f.network).toHaveBeenCalledOnce()
    permit.revoke()
  })
  it('retains an unknown acknowledged save and cannot reuse its stale background revision', async () => {
    const f = await revokeRecoveryFixture(),
      permit = await f.service.prepareSchedule(f.id)
    await permit.activate()
    const save = f.store.saveSubscription.bind(f.store)
    vi.spyOn(f.store, 'saveSubscription').mockImplementationOnce(async (...args) => {
      await save(...args)
      throw new RelayPluginStorageUncertain()
    })
    expect(await permit.run()).toEqual({ status: 'uncertain' })
    const calls = f.network.mock.calls.length
    expect(await permit.run()).toEqual({ status: 'cancelled' })
    expect(f.network.mock.calls).toHaveLength(calls)
    permit.revoke()
  })
})

async function signedRecoveryFixture() {
  const keys = generateKeyPairSync('ed25519'),
    pub = keys.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64')
  const signed = (seq: number, gateway: string) => {
    const bytes = Buffer.from(
      JSON.stringify({
        spec: 'cpx-plugin/2',
        seq,
        gateways: [gateway],
        endpoints: wellKnown.endpoints
      })
    )
    return (
      bytes.toString('base64') +
      '.' +
      sign(null, buildDiscoverySignInput(bytes), keys.privateKey).toString('base64')
    )
  }
  const f = await fixture(JSON.stringify({ ...JSON.parse(descriptor), providerPubKey: pub }))
  f.discovery({ ...wellKnown, signed: signed(2, wellKnown.gateway) })
  const id = await f.install()
  await f.service.login(id)
  const original = f.network.getMockImplementation(),
    before = await f.store.read(id),
    next = 'https://rotated.example'
  if (!original) throw new Error('missing fixture request')
  f.network.mockClear()
  f.confirm.mockClear()
  f.oauth.mockClear()
  f.crypto.encrypt.mockClear()
  f.createContext.mockClear()
  f.discovery({ ...wellKnown, gateway: next, signed: signed(3, next) })
  f.network.mockImplementation(async (url) => {
    if (url === wellKnown.gateway + '/config') throw new GatewayError('retired', 'retired', 410)
    return original(url)
  })
  return { ...f, id, before, next, signed, original }
}

describe('Finite plugin signed recovery commit boundaries', () => {
  it('keeps the signed floor and old subscription when a new origin is refused', async () => {
    const f = await signedRecoveryFixture()
    f.confirm.mockImplementation(async (permission) => permission.action !== 'gateways')
    expect(await f.service.update(f.id)).toEqual({ status: 'cancelled' })
    const saved = await f.store.read(f.id)
    expect(saved.record.discovery?.seq).toBe(3)
    expect(saved.record.lastGoodTarget).toBeUndefined()
    expect(saved.record.subscription).toEqual(f.before.record.subscription)
    expect(saved.encryptedCredential).toBe(f.before.encryptedCredential)
    expect(saved.record.approvedOrigins).not.toContain(f.next)
    expect(f.network.mock.calls.some(([url]) => url.startsWith(f.next))).toBe(false)
    expect(f.oauth).not.toHaveBeenCalled()
  })
  it('updates the same real guarded transport only after an acknowledged explicit grant', async () => {
    const f = await signedRecoveryFixture()
    f.createContext.mockImplementation((record, signal) =>
      createRelayPluginContext({
        record,
        signal,
        proxy: async () => ({ host: '127.0.0.1', port: 18191 }),
        resolveAll: async () => [{ address: '93.184.216.34', family: 4 }],
        request: f.network
      })
    )
    f.confirm.mockImplementation(async (permission) => {
      if (permission.action === 'gateways') {
        expect((await f.store.read(f.id)).record.discovery?.seq).toBe(3)
        expect(f.network.mock.calls.some(([url]) => url.startsWith(f.next))).toBe(false)
      }
      return true
    })
    expect(await f.service.update(f.id)).toEqual({ status: 'updated', id: f.id })
    expect(f.createContext).toHaveBeenCalledOnce()
    expect(
      f.network.mock.calls.filter(([url]) => url.startsWith(f.next)).map(([url]) => url)
    ).toEqual([f.next + '/challenge', f.next + '/config'])
    expect((await f.store.read(f.id)).record.approvedOrigins).toContain(f.next)
  })
  it('persists a higher signed epoch and stops a background permit without new grants or target requests', async () => {
    const f = await signedRecoveryFixture(),
      permit = await f.service.prepareSchedule(f.id)
    await permit.activate()
    expect(await permit.run()).toEqual({ status: 'changed' })
    const saved = await f.store.read(f.id)
    expect(saved.record.discovery?.seq).toBe(3)
    expect(saved.record.lastGoodTarget).toBeUndefined()
    expect(saved.record.subscription).toEqual(f.before.record.subscription)
    expect(f.confirm).not.toHaveBeenCalled()
    expect(f.oauth).not.toHaveBeenCalled()
    expect(f.network.mock.calls.some(([url]) => url.startsWith(f.next))).toBe(false)
    permit.revoke()
  })
  it('does not contact a new target after cancellation at the floor-before-grant boundary', async () => {
    const f = await signedRecoveryFixture()
    f.confirm.mockImplementation(async (permission) => {
      if (permission.action === 'gateways') {
        expect((await f.store.read(f.id)).record.discovery?.seq).toBe(3)
        f.service.cancel()
      }
      return true
    })
    await expect(f.service.update(f.id)).rejects.toThrow()
    expect((await f.store.read(f.id)).record.discovery?.seq).toBe(3)
    expect((await f.store.read(f.id)).record.subscription).toEqual(f.before.record.subscription)
    expect(f.network.mock.calls.some(([url]) => url.startsWith(f.next))).toBe(false)
  })
  it('does not advance an unknown discovery save into a new grant or target request', async () => {
    const f = await signedRecoveryFixture(),
      save = f.store.save.bind(f.store)
    vi.spyOn(f.store, 'save').mockImplementationOnce(async (...args) => {
      await save(...args)
      throw new RelayPluginStorageUncertain()
    })
    await expect(f.service.update(f.id)).rejects.toThrow()
    expect((await f.service.state()).uncertain).toBe(true)
    expect((await f.store.read(f.id)).record.discovery?.seq).toBe(3)
    expect((await f.store.read(f.id)).record.subscription).toEqual(f.before.record.subscription)
    expect(f.confirm.mock.calls.some(([permission]) => permission.action === 'gateways')).toBe(
      false
    )
    expect(f.network.mock.calls.some(([url]) => url.startsWith(f.next))).toBe(false)
  })
  it('does not retry a target endlessly after the one new signed candidate also fails', async () => {
    const f = await signedRecoveryFixture()
    f.network.mockImplementation(async (url) => {
      if (url.endsWith('/config')) throw new GatewayError('unreachable', 'no route')
      return f.original(url)
    })
    await expect(f.service.update(f.id)).rejects.toThrow()
    expect(
      f.network.mock.calls.filter(([url]) => url.endsWith('/.well-known/cpx-gateway'))
    ).toHaveLength(1)
    expect(f.network.mock.calls.filter(([url]) => url.endsWith('/config'))).toHaveLength(2)
    expect((await f.store.read(f.id)).record.discovery?.seq).toBe(3)
    expect((await f.store.read(f.id)).record.subscription).toEqual(f.before.record.subscription)
  })
  it('never rewrites signed candidate fields merely to record a successful preference', async () => {
    const f = await signedRecoveryFixture()
    // Restore the original currently signed candidate; this update succeeds at it.
    f.network.mockImplementation((url) => f.original(url))
    expect(await f.service.update(f.id)).toEqual({ status: 'updated', id: f.id })
    const saved = await f.store.read(f.id)
    expect(saved.record.discovery).toEqual(f.before.record.discovery)
    if (!saved.record.discovery) throw new Error('missing fixture discovery')
    expect(saved.record.lastGoodTarget).toBe(
      pluginTargetKey(saved.record.discovery, wellKnown.gateway)
    )
  })
})

describe('Plugin record late CAS publish boundary diagnostic', () => {
  it('retains a valid foreign preference written just after the final asynchronous authority check', async () => {
    const f = await revokeRecoveryFixture(),
      permit = await f.service.prepareSchedule(f.id)
    await permit.activate()
    const save = f.store.saveSubscription.bind(f.store)
    let checks = 0,
      expectedPreference = '',
      injected = false
    vi.spyOn(f.store, 'saveSubscription').mockImplementationOnce(async (entry, text, guard) => {
      if (!guard) throw new Error('Expected genuine background write guard')
      return save(entry, text, {
        signal: guard.signal,
        verify: async () => {
          await guard.verify()
          if (++checks === 3) {
            const current = await f.store.read(f.id),
              d = current.record.discovery
            if (!d) throw new Error('missing fixture discovery')
            expectedPreference = pluginTargetKey(d, f.gateways[1])
            const path = join(f.context.stateRoot, 'Plugins', f.id, 'record.json')
            const raw: {
              version: number
              record: RelayPluginRecord
              encryptedCredential?: string
            } = JSON.parse(await readFile(path, 'utf8'))
            raw.record.lastGoodTarget = expectedPreference
            await writeFile(path, JSON.stringify(raw))
            injected = true
          }
        }
      })
    })
    const outcome = await permit.run(),
      after = await f.store.read(f.id)
    const facts = {
      outcome,
      authorityChecks: checks,
      injected,
      expectedPreference,
      actualPreference: after.record.lastGoodTarget,
      foreignPreserved: after.record.lastGoodTarget === expectedPreference,
      userData: false,
      network: 'injected mock only',
      Keychain: false
    }
    const base = process.env.RELAY_PLUGIN_PROOF_OUTPUT
    const phase = process.env.RELAY_PLUGIN_LATE_CAS_PHASE ?? 'after'
    if (base)
      await writeFile(
        join(base, 'late-cas-' + phase + '-facts.json'),
        JSON.stringify(facts, null, 2) + '\n'
      )
    permit.revoke()
    expect(injected).toBe(true)
    expect(facts.foreignPreserved).toBe(true)
    expect(outcome.status).not.toBe('updated')
  })
})

describe('Plugin record creator-known synchronous publication', () => {
  it.each(['mode', 'replacement', 'hardlink'] as const)(
    'retains an altered stage %s with zero foreign unlink and no record change',
    async (kind) => {
      const f = await revokeRecoveryFixture(),
        entry = await f.store.read(f.id),
        directory = join(f.context.stateRoot, 'Plugins', f.id)
      let staged = '',
        originalInode = 0
      fsFaults.stage = (fd) => {
        const names = readdirSync(directory).filter((name) => name.startsWith('.record-'))
        expect(names).toHaveLength(1)
        staged = join(directory, names[0])
        originalInode = fstatSync(fd).ino
        if (kind === 'mode') chmodSync(staged, 0o644)
        if (kind === 'replacement') {
          renameSync(staged, join(directory, 'owned-stage-evidence'))
          writeFileSync(staged, 'foreign bytes', { mode: 0o600 })
        }
        if (kind === 'hardlink') linkSync(staged, join(directory, 'external-link-evidence'))
      }
      await expect(
        f.store.save({
          ...entry,
          record: { ...entry.record, updatedAt: entry.record.updatedAt + 1 }
        })
      ).rejects.toBeInstanceOf(RelayPluginStorageUncertain)
      expect((await f.store.read(f.id)).revision).toBe(entry.revision)
      expect(staged).not.toBe('')
      if (kind === 'replacement') expect(await readFile(staged, 'utf8')).toBe('foreign bytes')
      else expect((await stat(staged)).ino).toBe(originalInode)
      expect(() => fstatSync(fsFaults.seenFD)).toThrow()
    }
  )
  it('removes only its exact creator-owned partial prefix after an actual seven-byte stage write', async () => {
    const f = await revokeRecoveryFixture(),
      entry = await f.store.read(f.id),
      directory = join(f.context.stateRoot, 'Plugins', f.id)
    fsFaults.partial = true
    await expect(
      f.store.save({ ...entry, record: { ...entry.record, updatedAt: entry.record.updatedAt + 1 } })
    ).rejects.toBeInstanceOf(RelayPluginStorageUncertain)
    expect((await f.store.read(f.id)).revision).toBe(entry.revision)
    expect(fsFaults.partial).toBe(false)
    expect(fsFaults.seenFD).toBeGreaterThanOrEqual(0)
    expect(readdirSync(directory).some((name) => name.startsWith('.record-'))).toBe(false)
    expect(() => fstatSync(fsFaults.seenFD)).toThrow()
  })
  it('reports a real rename with lost ACK as uncertain and leaves its new record intact', async () => {
    const f = await revokeRecoveryFixture(),
      entry = await f.store.read(f.id),
      directory = join(f.context.stateRoot, 'Plugins', f.id),
      changedAt = entry.record.updatedAt + 1
    fsFaults.renameACK = true
    await expect(
      f.store.save({ ...entry, record: { ...entry.record, updatedAt: changedAt } })
    ).rejects.toBeInstanceOf(RelayPluginStorageUncertain)
    const saved = await f.store.read(f.id)
    expect(fsFaults.renameACK).toBe(false)
    expect(saved.record.updatedAt).toBe(changedAt)
    expect(saved.revision).not.toBe(entry.revision)
    expect(readdirSync(directory).some((name) => name.startsWith('.record-'))).toBe(false)
  })
})

describe('Remove never widens its approved-origin scope', () => {
  it('does not grant or contact a stored candidate that is outside the current approved list', async () => {
    const f = await revokeRecoveryFixture(),
      entry = await f.store.read(f.id),
      d = entry.record.discovery
    if (!d) throw new Error('missing fixture discovery')
    await f.store.save({
      ...entry,
      record: {
        ...entry.record,
        lastGoodTarget: undefined,
        approvedOrigins: entry.record.approvedOrigins.filter((origin) => origin !== f.gateways[1]),
        discovery: { ...d, gateways: [f.gateways[1]] }
      }
    })
    f.network.mockClear()
    f.confirm.mockClear()
    await expect(f.service.remove({ id: f.id, localOnly: false })).rejects.toThrow()
    expect(f.network).not.toHaveBeenCalled()
    expect(f.confirm.mock.calls.map(([permission]) => permission.action)).toEqual(['remove'])
    expect((await f.store.read(f.id)).encryptedCredential).toBeDefined()
  })
})
