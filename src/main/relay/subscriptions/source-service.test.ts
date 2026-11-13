import { mkdtemp, realpath, rm, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProfileStore } from '../profiles/store'
import type {
  SubscriptionSourcePlan,
  SubscriptionSourceInfo
} from '../../../shared/relay/subscription-sources'
import { profileHash } from '../profiles/source'
import { SubscriptionSourceStore } from './source-store'
import { createSubscriptionSourceService } from './source-service'

const clean: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const f of clean.splice(0)) await f()
})
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Missing fixture result')
  return value
}
const source = 'proxies: [{name: Node, type: http, server: 127.0.0.1, port: 18192}]'
async function fixture() {
  const home = await realpath(await mkdtemp('/private/tmp/relay-source-service-')),
    context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') },
    store = new SubscriptionSourceStore(context),
    profiles = new ProfileStore(context)
  let time = 0
  const adapters = {
    store,
    profiles,
    download: vi.fn(async (_url: string, _port: number, _signal: AbortSignal) => source),
    confirm: vi.fn(async (_p: SubscriptionSourcePlan) => false),
    now: () => time
  }
  const service = createSubscriptionSourceService(adapters)
  clean.push(async () => {
    await service.requestClose()
    service.clear()
    await rm(home, { recursive: true, force: true })
  })
  return {
    service,
    adapters,
    store,
    profiles,
    home,
    withTransfer(
      transfer: NonNullable<Parameters<typeof createSubscriptionSourceService>[0]['transfer']>
    ) {
      const service = createSubscriptionSourceService({ ...adapters, transfer })
      clean.push(async () => {
        await service.requestClose()
        service.clear()
      })
      return service
    },
    advance: () => {
      time += 60001
    }
  }
}
const select = (s: SubscriptionSourceInfo) => ({ id: s.id, revision: s.revision })
async function register(f: Awaited<ReturnType<typeof fixture>>) {
  f.adapters.confirm.mockResolvedValue(true)
  const p = f.service.prepareRegistration({
      name: 'Fixture',
      url: 'https://sub.invalid/PRIVATE?token=PRIVATE',
      proxyPort: 18191
    }),
    r = await f.service.execute({ evidenceId: p.evidenceId })
  if (!r.source) throw new Error()
  return r.source
}
async function update(f: Awaited<ReturnType<typeof fixture>>, s: SubscriptionSourceInfo) {
  const p = await f.service.prepareUpdate(select(s)),
    r = await f.service.execute({ evidenceId: p.evidenceId })
  if (!r.plan) throw new Error('no stage')
  return f.service.execute({ evidenceId: r.plan.evidenceId })
}
describe('Private source registration and two-step immutable updates', () => {
  it('pins temporary options to the manually prepared update and keeps scheduled runs independent', async () => {
    const base = await fixture(),
      transfer = vi.fn<
        NonNullable<Parameters<typeof createSubscriptionSourceService>[0]['transfer']>
      >(async () => ({
        status: 'downloaded',
        text: source,
        metadata: {
          checkedAt: new Date().toISOString(),
          status: 200,
          resourceSHA256: 'c'.repeat(64)
        }
      })),
      f = { ...base, service: base.withTransfer(transfer) },
      s = await register(f),
      original = await f.store.read(select(s))
    const requestTuning = { timeoutSeconds: 6, userAgent: 'Private-Draft/1' }
    const plan = await f.service.prepareUpdate({ ...select(s), requestTuning })
    expect(plan.requestTuning).toEqual({ timeoutSeconds: 6, customUserAgent: true })
    expect(JSON.stringify(plan)).not.toContain(requestTuning.userAgent)
    requestTuning.timeoutSeconds = 12
    requestTuning.userAgent = 'Next-Draft/2'
    await expect(
      f.service.prepareUpdate({ ...select(s), requestTuning: { timeoutSeconds: 16 } })
    ).rejects.toThrow('超时')
    const update = await f.service.execute({ evidenceId: plan.evidenceId })
    expect(transfer.mock.calls[0][5]).toEqual({ timeoutSeconds: 6, userAgent: 'Private-Draft/1' })
    await f.service.execute({ evidenceId: required(update.plan).evidenceId })
    await f.service.runScheduled(s.id, original.originRevision)
    expect(transfer.mock.calls.at(-1)?.[5]).toBeUndefined()
    expect((await f.store.readId(s.id)).options).toEqual(original.options)
  })
  it('requires a separate cache observation commit for 304 and preserves the configuration version count', async () => {
    const base = await fixture(),
      metadata = {
        checkedAt: new Date().toISOString(),
        status: 200 as const,
        resourceSHA256: profileHash('https://sub.invalid/PRIVATE?token=PRIVATE'),
        etag: '"PRIVATE"',
        quota: { total: 100 }
      },
      transfer = vi.fn<
        NonNullable<Parameters<typeof createSubscriptionSourceService>[0]['transfer']>
      >(async () => ({ status: 'downloaded', text: source, metadata })),
      f = { ...base, service: base.withTransfer(transfer) },
      s = await register(f),
      one = required((await update(f, s)).source)
    transfer.mockResolvedValueOnce({
      status: 'notModified',
      metadata: { ...metadata, status: 304 }
    })
    const p = await f.service.prepareUpdate(select(one)),
      staged = await f.service.execute({ evidenceId: p.evidenceId })
    expect(staged.plan?.observationOnly).toBe(true)
    expect((await f.store.read(select(one))).recordCount).toBe(1)
    const result = await f.service.execute({ evidenceId: required(staged.plan).evidenceId })
    expect(result.status).toBe('unchanged')
    expect(result.source?.versions).toHaveLength(1)
    expect((await f.profiles.list()).profiles).toHaveLength(1)
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(transfer.mock.calls.at(-1)?.[4]).toMatchObject({ etag: '"PRIVATE"' })
  })
  it('runs an internally authorized update without another prompt and stops between stages on close', async () => {
    const base = await fixture(),
      metadata = {
        checkedAt: new Date().toISOString(),
        status: 200 as const,
        resourceSHA256: 'c'.repeat(64)
      },
      transfer = vi.fn<
        NonNullable<Parameters<typeof createSubscriptionSourceService>[0]['transfer']>
      >(async () => ({ status: 'downloaded', text: source, metadata })),
      f = { ...base, service: base.withTransfer(transfer) },
      s = await register(f),
      stored = await f.store.read(select(s))
    f.adapters.confirm.mockClear().mockResolvedValue(false)
    expect((await f.service.runScheduled(s.id, stored.originRevision)).status).toBe('saved')
    expect(f.adapters.confirm).not.toHaveBeenCalled()
    await expect(f.service.runScheduled(s.id, 'd'.repeat(64))).rejects.toThrow('授权')
    transfer.mockResolvedValueOnce({ status: 'downloaded', text: source + '\n# next', metadata })
    const execute = f.service.execute.bind(f.service)
    vi.spyOn(f.service, 'execute').mockImplementation(async (raw) => {
      const result = await execute(raw)
      if (result.status === 'staged') await f.service.requestClose()
      return result
    })
    expect((await f.service.runScheduled(s.id, stored.originRevision)).status).toBe('cancelled')
    expect((await f.profiles.list()).profiles).toHaveLength(1)
    expect(f.service.state().preparedId).toBeUndefined()
  })
  it('is inert, redacts credentials and cancels registration without saving or downloading', async () => {
    const f = await fixture(),
      p = f.service.prepareRegistration({
        name: 'Fixture',
        url: 'https://sub.invalid/PRIVATE',
        proxyPort: 18191
      })
    expect(JSON.stringify(p)).not.toContain('PRIVATE')
    expect((await f.service.execute({ evidenceId: p.evidenceId })).status).toBe('cancelled')
    expect((await f.store.list()).sources).toEqual([])
    expect(f.adapters.download).not.toHaveBeenCalled()
  })
  it('downloads through the stored route then requires a separate save and reuses no URL from renderer input', async () => {
    const f = await fixture(),
      s = await register(f),
      p = await f.service.prepareUpdate(select(s))
    await expect(f.service.prepareUpdate({ ...select(s), url: 'http://evil' })).rejects.toThrow(
      '只接受'
    )
    const result = await f.service.execute({ evidenceId: p.evidenceId })
    expect(result.status).toBe('staged')
    expect((await f.profiles.list()).profiles).toHaveLength(0)
    expect(f.adapters.download).toHaveBeenCalledWith(
      'https://sub.invalid/PRIVATE?token=PRIVATE',
      18191,
      expect.any(AbortSignal)
    )
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    f.adapters.confirm.mockResolvedValue(false)
    expect((await f.service.execute({ evidenceId: required(result.plan).evidenceId })).status).toBe(
      'cancelled'
    )
    expect((await f.store.read(select(s))).info.versions).toHaveLength(0)
    f.adapters.confirm.mockResolvedValue(true)
    expect((await update(f, s)).status).toBe('saved')
    expect((await f.profiles.list()).profiles).toHaveLength(1)
  })
  it('does not create a duplicate for identical bytes and appends historical selection without overwriting profiles', async () => {
    const f = await fixture(),
      s = await register(f),
      first = await update(f, s)
    const one = required(first.source)
    const p = await f.service.prepareUpdate(select(one))
    expect((await f.service.execute({ evidenceId: p.evidenceId })).status).toBe('unchanged')
    f.adapters.download.mockResolvedValue(source + '\n# revision2')
    const second = await update(f, one),
      two = required(second.source),
      r = await f.service.prepareRestore({ source: select(two), versionId: one.versions[0].id }),
      restored = await f.service.execute({ evidenceId: r.evidenceId })
    expect(restored.status).toBe('saved')
    expect(restored.source?.versions.at(-1)?.profile).toEqual(one.versions[0].profile)
    expect(restored.source?.versions).toHaveLength(3)
    expect((await f.profiles.list()).profiles).toHaveLength(2)
    expect((await f.profiles.read(one.versions[0].profile)).text).toBe(source)
  })
  it('rejects expired, changed source and changed profile metadata before saving a version', async () => {
    const f = await fixture(),
      s = await register(f)
    let p = await f.service.prepareUpdate(select(s))
    f.advance()
    await expect(f.service.execute({ evidenceId: p.evidenceId })).rejects.toThrow('失效')
    p = await f.service.prepareUpdate(select(s))
    const origin = join(f.store.directory, s.id, 'source.json'),
      raw = await readFile(origin, 'utf8')
    await writeFile(origin, JSON.stringify({ ...JSON.parse(raw), name: 'Changed' }))
    expect((await f.service.execute({ evidenceId: p.evidenceId })).status).toBe('failed')
    expect(f.adapters.download).not.toHaveBeenCalled()
    await writeFile(origin, raw)
    const one = required((await update(f, s)).source),
      plan = await f.service.prepareUpdate(select(one))
    f.adapters.download.mockResolvedValue(source + '\n# next')
    const staged = await f.service.execute({ evidenceId: plan.evidenceId }),
      path = join(f.profiles.directory, one.versions[0].profile.id, 'metadata.json'),
      meta = await readFile(path, 'utf8')
    await writeFile(path, JSON.stringify({ ...JSON.parse(meta), name: 'Changed' }))
    expect((await f.service.execute({ evidenceId: required(staged.plan).evidenceId })).status).toBe(
      'failed'
    )
    expect((await f.profiles.list()).profiles).toHaveLength(1)
  })
  it('keeps previous records on transport or format failure and hides broken historical references', async () => {
    const f = await fixture(),
      s = await register(f),
      one = required((await update(f, s)).source)
    for (const outcome of ['transport', 'format']) {
      if (outcome === 'transport') f.adapters.download.mockRejectedValueOnce(new Error('PRIVATE'))
      else f.adapters.download.mockResolvedValueOnce('<html>PRIVATE</html>')
      const p = await f.service.prepareUpdate(select(one)),
        r = await f.service.execute({ evidenceId: p.evidenceId })
      expect(r.status).toBe('failed')
      expect(JSON.stringify(r)).not.toContain('PRIVATE')
    }
    expect((await f.store.read(select(one))).info.versions).toHaveLength(1)
    await writeFile(
      join(f.profiles.directory, one.versions[0].profile.id, 'profile.yaml'),
      'changed'
    )
    expect(await f.service.list()).toMatchObject({ sources: [], incomplete: 1 })
  })
  it('aborts only the current source request and waits for it before quitting', async () => {
    const f = await fixture(),
      s = await register(f)
    let signal!: AbortSignal, fail!: (error: Error) => void
    f.adapters.download.mockImplementationOnce(async (_url, _port, abort) => {
      signal = abort
      return new Promise((_resolve, reject) => {
        fail = reject
      })
    })
    const p = await f.service.prepareUpdate(select(s)),
      pending = f.service.execute({ evidenceId: p.evidenceId })
    await vi.waitFor(() => expect(signal).toBeDefined())
    const closing = f.service.requestClose()
    expect(signal.aborted).toBe(true)
    fail(new Error('PRIVATE'))
    expect((await pending).status).toBe('cancelled')
    await closing
    expect((await f.store.read(select(s))).info.versions).toHaveLength(0)
  })
})
