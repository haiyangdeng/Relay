import { createHash } from 'node:crypto'
import { chmod, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  defaultLocalProxyPlan,
  localProxyPlan,
  localProxyPlanRecord,
  localProxyPlanSaveRequest
} from '../../../shared/relay/local-proxy-plan'
import { LocalProxyPlanStore } from './local-proxy-plan-store'
import { localProxyConfiguration } from './local-proxy-runtime'

const homes: string[] = []
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'relay-local-proxy-plan-')))
  homes.push(home)
  const context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') }
  return { context, store: new LocalProxyPlanStore(context) }
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})
const dedicatedPlan = {
  httpPort: 18191,
  resolverMode: 'off' as const,
  dedicated: { httpPort: 18193, socksPort: 18190, route: 'fixed-node' }
}

describe('Saved local proxy startup plan schema', () => {
  it('keeps the ordinary defaults and never enables a dedicated listener implicitly', () => {
    expect(localProxyPlan(defaultLocalProxyPlan())).toEqual({
      httpPort: 18191,
      resolverMode: 'profile'
    })
    expect(localProxyPlan(dedicatedPlan)).toEqual(dedicatedPlan)
    expect(localProxyPlanRecord({ document: dedicatedPlan, revision: '', exists: false })).toEqual({
      document: dedicatedPlan,
      revision: '',
      exists: false
    })
  })
  it.each([
    { enabled: true },
    { lifetime: 'persistent' },
    { tun: true },
    { systemProxy: true },
    { profile: 'other' },
    { resolverMode: undefined },
    { httpPort: 80 },
    { httpPort: '18191' },
    { dedicated: { socksPort: 18191, route: 'fixed-node' } },
    { dedicated: { httpPort: 18191, route: 'fixed-node' } },
    { dedicated: { httpPort: 18193, route: 'DIRECT' } }
  ])('rejects invalid values and runtime authority fields: %j', (patch) => {
    expect(() => localProxyPlan({ ...defaultLocalProxyPlan(), ...patch })).toThrow()
  })
  it('requires exact save and record shapes with a valid CAS revision', () => {
    const document = dedicatedPlan
    expect(() =>
      localProxyPlanSaveRequest({ document, expectedRevision: '', force: true })
    ).toThrow()
    expect(() => localProxyPlanSaveRequest({ document, expectedRevision: 'old' })).toThrow()
    expect(() => localProxyPlanRecord({ document, revision: '', exists: true })).toThrow()
  })
})

describe.runIf(process.getuid !== undefined)('Local proxy startup private persistence', () => {
  it('does not create a file while reading absent defaults, including concurrent first reads', async () => {
    const { store } = await fixture()
    const reads = [store.read(), store.read()]
    expect(store.isReading()).toBe(true)
    const [first, second] = await Promise.all(reads)
    expect(first).toEqual({ document: defaultLocalProxyPlan(), revision: '', exists: false })
    expect(second).toEqual(first)
    first.document.httpPort = 18192
    expect(second.document.httpPort).toBe(18191)
    expect(store.isReading()).toBe(false)
    expect(store.isBusy()).toBe(false)
    await expect(lstat(store.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('persists the exact plan privately and reads it unchanged in a new process store', async () => {
    const { store, context } = await fixture()
    const saved = await store.save({ document: dedicatedPlan, expectedRevision: '' })
    expect(store.path).toBe(join(context.stateRoot, 'Configuration/local-proxy-plan.json'))
    const bytes = await readFile(store.path)
    expect(saved.revision).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect((await lstat(store.path)).mode & 0o7777).toBe(0o600)
    expect(await new LocalProxyPlanStore(context).read()).toEqual(saved)
    const source = JSON.stringify({
      proxies: [{ name: 'fixed-node', type: 'http', server: '127.0.0.1', port: 1234 }],
      rules: ['MATCH,REJECT']
    })
    const config = JSON.parse(
      localProxyConfiguration(
        source,
        saved.document.httpPort,
        saved.document.resolverMode,
        saved.document.dedicated
      ).configuration
    )
    expect(config.listeners).toEqual([
      {
        name: 'relay-ai-http',
        type: 'http',
        port: 18193,
        listen: '127.0.0.1',
        proxy: 'fixed-node',
        udp: false
      },
      {
        name: 'relay-ai-socks',
        type: 'socks',
        port: 18190,
        listen: '127.0.0.1',
        proxy: 'fixed-node',
        udp: false
      }
    ])
    expect(() =>
      localProxyConfiguration(
        source.replace('fixed-node', 'other-node'),
        saved.document.httpPort,
        saved.document.resolverMode,
        saved.document.dedicated
      )
    ).toThrow('具体代理节点')
    expect(await store.read()).toEqual(saved)
  })
  it('refuses a stale save from a different instance and preserves the newer node', async () => {
    const { store, context } = await fixture()
    const first = await store.save({ document: dedicatedPlan, expectedRevision: '' })
    const second = await new LocalProxyPlanStore(context).save({
      document: { ...dedicatedPlan, dedicated: { ...dedicatedPlan.dedicated, route: 'new-node' } },
      expectedRevision: first.revision
    })
    await expect(
      store.save({ document: dedicatedPlan, expectedRevision: first.revision })
    ).rejects.toThrow()
    expect(await store.read()).toEqual(second)
  })
  it('freezes the request, refuses readers during a save and exposes an idle barrier', async () => {
    const { store } = await fixture(),
      gate = Promise.withResolvers<void>(),
      document = structuredClone(dedicatedPlan)
    const saving = store.save(
      { document, expectedRevision: '' },
      () => {},
      () => gate.promise
    )
    let idle = false
    const waiting = store.whenIdle().then(() => {
      idle = true
    })
    document.dedicated.route = 'changed-after-request'
    expect(store.isBusy()).toBe(true)
    await expect(store.read()).rejects.toThrow('尚未结束')
    expect(store.isReading()).toBe(false)
    expect(idle).toBe(false)
    gate.resolve()
    const saved = await saving
    await waiting
    expect(idle).toBe(true)
    expect(saved.document).toEqual(dedicatedPlan)
  })
  it('checks each shared reader context separately', async () => {
    const { store } = await fixture()
    let checks = 0
    const stale = store.read(() => {
      if (++checks === 2) throw new Error('stale context')
    })
    const current = store.read()
    await expect(stale).rejects.toThrow('stale context')
    expect((await current).document).toEqual(defaultLocalProxyPlan())
  })
  it('refuses an owner change immediately before commit and preserves old settings', async () => {
    const { store } = await fixture()
    const saved = await store.save({ document: dedicatedPlan, expectedRevision: '' })
    let checks = 0
    await expect(
      store.save(
        { document: defaultLocalProxyPlan(), expectedRevision: saved.revision },
        () => {},
        async () => {
          if (++checks === 2) throw new Error('owner changed')
        }
      )
    ).rejects.toThrow('owner changed')
    expect(await store.read()).toEqual(saved)
  })
  it.each(['corrupt', 'permissions', 'symlink'])(
    'refuses %s records without a silent default',
    async (kind) => {
      const { store, context } = await fixture()
      await store.save({ document: dedicatedPlan, expectedRevision: '' })
      if (kind === 'corrupt') await writeFile(store.path, '{invalid', { mode: 0o600 })
      if (kind === 'permissions') await chmod(store.path, 0o644)
      if (kind === 'symlink') {
        const other = join(context.home, 'other.json')
        await writeFile(other, JSON.stringify(dedicatedPlan), { mode: 0o600 })
        await rm(store.path)
        await symlink(other, store.path)
      }
      await expect(store.read()).rejects.toThrow()
      await expect(
        store.save({ document: defaultLocalProxyPlan(), expectedRevision: '' })
      ).rejects.toThrow()
    }
  )
})
