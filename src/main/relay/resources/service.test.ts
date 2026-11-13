import { mkdtemp, realpath, rm, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resourceDescriptor, type ResourceCheckResult } from '../../../shared/relay/resources'
import { ResourceStore } from './store'
import { resourceHash } from './source'
import { createResourceService } from './service'
import type { ResourceValidationJob } from './check-definition'

const clean: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of clean.splice(0)) await close()
})
async function fixture() {
  const home = await realpath(await mkdtemp('/private/tmp/relay-resource-service-')),
    cache = new ResourceStore({
      home,
      stateRoot: join(home, 'Library/Application Support/Relay-Preview')
    }),
    bytes = Buffer.from('fixture.invalid\n')
  let time = 0
  const picked = { bytes, readAgain: vi.fn(async () => Buffer.from(bytes)) },
    adapters = {
      cache,
      pick: vi.fn(async () => picked),
      download: vi.fn(
        async (
          _url: string,
          _port: number,
          _signal: AbortSignal,
          _headers: Record<string, string>
        ) => Buffer.from(bytes)
      ),
      confirm: vi.fn(async () => false),
      check: vi.fn(async (job: ResourceValidationJob): Promise<ResourceCheckResult> => ({
        status: 'passed',
        resourceSHA256: job.sha256,
        ruleCount: 1,
        warnings: ['simulated core fixture']
      })),
      now: () => time
    },
    service = createResourceService(adapters),
    input = {
      descriptor: { name: 'Fixture', kind: 'rule-text', behavior: 'domain', selector: '' },
      source: {
        kind: 'http',
        url: 'https://resource.invalid/PRIVATE?token=PRIVATE',
        proxyPort: 18191,
        headers: { Authorization: 'Bearer PRIVATE' }
      },
      expectedSHA256: ''
    }
  clean.push(async () => {
    await service.requestClose()
    service.clear()
    await rm(home, { recursive: true, force: true })
  })
  return {
    cache,
    service,
    adapters,
    bytes,
    picked,
    input,
    advance: () => {
      time += 60001
    }
  }
}
describe('Resource acquire and check orchestration', () => {
  it('keeps a cancelled preview busy until its existing converter has actually drained', async () => {
    const f = await fixture(),
      info = await f.cache.save(
        { ...resourceDescriptor(f.input.descriptor), kind: 'rule-mrs' },
        Buffer.from('MRS fixture')
      ),
      entered = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<{ entries: string[]; sourceRules: number }>(),
      service = createResourceService({
        ...f.adapters,
        convertRuleMRS: async () => {
          entered.resolve()
          return finish.promise
        }
      }),
      pending = service.preview({ id: info.id, sha256: info.sha256 }),
      rejected = expect(pending).rejects.toThrow('预览未确认')
    await entered.promise
    service.clear()
    const closed = service.requestClose()
    expect(service.isBusy()).toBe(true)
    expect(() => service.prepare(f.input)).toThrow('尚未结束')
    finish.resolve({ entries: ['fixture.invalid'], sourceRules: 1 })
    await rejected
    await closed
    expect(service.isBusy()).toBe(false)
    expect((await f.cache.read({ id: info.id, sha256: info.sha256 })).bytes).toEqual(
      Buffer.from('MRS fixture')
    )
    expect(f.adapters.pick).not.toHaveBeenCalled()
    expect(f.adapters.download).not.toHaveBeenCalled()
    expect(f.adapters.confirm).not.toHaveBeenCalled()
  })
  it('rechecks cancellation after a synchronous terminal view guard and preserves a prepared acquisition', async () => {
    const f = await fixture(),
      info = await f.cache.save(resourceDescriptor(f.input.descriptor), f.bytes),
      plan = f.service.prepare(f.input)
    const read = f.cache.read.bind(f.cache)
    let reads = 0,
      verifiedAgain = false
    vi.spyOn(f.cache, 'read').mockImplementation(async (...args) => {
      const result = await read(...args)
      verifiedAgain = ++reads === 2
      return result
    })
    await expect(
      f.service.preview({ id: info.id, sha256: info.sha256 }, () => {
        if (verifiedAgain) f.service.cancel({ evidenceId: f.service.state().operationId })
      })
    ).rejects.toThrow('预览未确认')
    expect(f.service.isBusy()).toBe(false)
    expect(f.service.state().preparedId).toBe(plan.evidenceId)
  })
  it('does no startup IO and defaults to cancellation without requesting the private URL', async () => {
    const f = await fixture(),
      p = f.service.prepare(f.input)
    expect(JSON.stringify(p)).not.toContain('PRIVATE')
    expect((await f.service.acquire({ evidenceId: p.evidenceId })).status).toBe('cancelled')
    expect(f.adapters.download).not.toHaveBeenCalled()
    expect((await f.cache.list()).resources).toHaveLength(0)
  })
  it('uses held headers/port and refuses expired or mismatched expected hashes before cache write', async () => {
    const f = await fixture()
    f.adapters.confirm.mockResolvedValue(true)
    let p = f.service.prepare(f.input)
    p.source.proxyPort = 1234
    p.descriptor.name = 'Injected'
    const result = await f.service.acquire({ evidenceId: p.evidenceId })
    expect(result.status).toBe('cached')
    expect(result.resource?.name).toBe('Fixture')
    expect(f.adapters.download).toHaveBeenCalledWith(
      f.input.source.url,
      18191,
      expect.any(AbortSignal),
      { authorization: 'Bearer PRIVATE' }
    )
    p = f.service.prepare({ ...f.input, expectedSHA256: '0'.repeat(64) })
    expect((await f.service.acquire({ evidenceId: p.evidenceId })).status).toBe('failed')
    expect((await f.cache.list()).resources).toHaveLength(1)
    p = f.service.prepare(f.input)
    f.advance()
    await expect(f.service.acquire({ evidenceId: p.evidenceId })).rejects.toThrow('失效')
  })
  it('requires a stable selected file and checks inline rules without a network request', async () => {
    const f = await fixture()
    f.adapters.confirm.mockResolvedValue(true)
    f.picked.readAgain.mockResolvedValueOnce(Buffer.from('changed'))
    let p = f.service.prepare({ ...f.input, source: { kind: 'file' } })
    expect((await f.service.acquire({ evidenceId: p.evidenceId })).status).toBe('failed')
    p = f.service.prepare({
      ...f.input,
      descriptor: { ...f.input.descriptor, kind: 'rule-yaml' },
      source: { kind: 'inline', payload: ['fixture.invalid'] }
    })
    const r = await f.service.acquire({ evidenceId: p.evidenceId })
    expect(r.status).toBe('cached')
    expect(f.adapters.download).not.toHaveBeenCalled()
    if (!r.resource) throw new Error()
    expect(
      (await f.cache.read({ id: r.resource.id, sha256: r.resource.sha256 })).bytes.toString()
    ).toContain('payload:')
  })
  it('rechecks resource revisions after a core check and does not publish a stale pass', async () => {
    const f = await fixture(),
      info = await f.cache.save(
        { name: 'Fixture', kind: 'rule-text', behavior: 'domain', selector: '' },
        f.bytes
      ),
      selection = { id: info.id, sha256: info.sha256 }
    const pending = f.service.prepare(f.input)
    expect(pending.evidenceId).toBeDefined()
    f.adapters.check.mockImplementationOnce(async (job) => {
      const path = join(f.cache.directory, info.id, 'metadata.json'),
        raw = JSON.parse(await readFile(path, 'utf8'))
      await writeFile(path, JSON.stringify({ ...raw, name: 'Changed' }))
      return { status: 'passed', resourceSHA256: job.sha256, warnings: ['simulated'] }
    })
    const result = await f.service.check(selection)
    expect(result.status).toBe('failed')
    expect(result.check).toBeUndefined()
    expect(f.service.state().preparedId).toBeUndefined()
  })
  it('aborts only its current acquisition and waits before exiting without caching or retrying', async () => {
    const f = await fixture()
    f.adapters.confirm.mockResolvedValue(true)
    let signal!: AbortSignal, fail!: (error: Error) => void
    f.adapters.download.mockImplementationOnce(async (_url, _port, abort) => {
      signal = abort
      return new Promise((_resolve, reject) => {
        fail = reject
      })
    })
    const p = f.service.prepare(f.input),
      pending = f.service.acquire({ evidenceId: p.evidenceId })
    await vi.waitFor(() => expect(signal).toBeDefined())
    const close = f.service.requestClose()
    expect(signal.aborted).toBe(true)
    fail(new Error('PRIVATE'))
    const result = await pending
    expect(result.status).toBe('cancelled')
    await close
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect((await f.cache.list()).resources).toHaveLength(0)
    expect(resourceHash(f.bytes)).toHaveLength(64)
  })
  it('keeps an unconfirmed cleanup result when closing during a check', async () => {
    const f = await fixture(),
      info = await f.cache.save(
        { name: 'Fixture', kind: 'rule-text', behavior: 'domain', selector: '' },
        f.bytes
      )
    let finish!: (result: ResourceCheckResult) => void
    f.adapters.check.mockImplementationOnce(
      async () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = f.service.check({ id: info.id, sha256: info.sha256 })
    await vi.waitFor(() => expect(finish).toBeDefined())
    const close = f.service.requestClose()
    finish({
      status: 'uncertain',
      resourceSHA256: info.sha256,
      warnings: ['simulated cleanup unresolved']
    })
    expect((await pending).status).toBe('uncertain')
    await close
  })
})
