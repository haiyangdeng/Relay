import { afterEach, describe, expect, it, vi } from 'vitest'
import { profileHash, type ProfileSource } from '../profiles/source'
import { inspectProfile, analyzeProfile } from '../profiles/inspect'
import type { RelayProfileSelection } from '../../../shared/relay/runtime'
import type { RelayStoredProfile } from '../../../shared/relay/profiles'
import type { ProviderBatchPreparation } from '../../../shared/relay/providers'
import { resourceBinding } from './materialize'
import { createProviderService } from './service'

const node = { name: 'Node', type: 'http', server: '127.0.0.1', port: 12345, password: 'PRIVATE' },
  resourceText = JSON.stringify({ proxies: [node] })
const clean: (() => void)[] = []
afterEach(() => {
  clean.splice(0).forEach((f) => f())
  vi.useRealTimers()
})
function fixture(kind: 'inline' | 'http' | 'file' | 'batch' = 'inline') {
  const remote = {
    type: 'http',
    url: 'https://p.invalid/PRIVATE?token=PRIVATE',
    header: { Authorization: ['Bearer PRIVATE'] }
  }
  const text = JSON.stringify({
    dns: { enable: true, nameserver: ['10.0.0.53'] },
    'proxy-providers': {
      P:
        kind === 'inline'
          ? { type: 'inline', payload: [node] }
          : kind === 'file'
            ? { type: 'file', path: '/PRIVATE' }
            : remote,
      ...(kind === 'batch'
        ? {
            Q: { type: 'http', url: 'http://q.invalid/PRIVATE', 'size-limit': 512 },
            R: { type: 'http', url: 'https://r.invalid/PRIVATE' },
            Inline: { type: 'inline', payload: [node] },
            File: { type: 'file', path: '/PRIVATE' },
            Invalid: { ...remote, header: { Host: ['PRIVATE'] } }
          }
        : {})
    },
    'proxy-groups': [{ name: 'Group', type: 'select', use: ['P'] }],
    rules: ['MATCH,Group']
  })
  const summary = inspectProfile(text).summary
  if (!summary) throw new Error('fixture missing summary')
  const base = {
    profile: {
      id: '00000000-0000-0000-0000-000000000001',
      sha256: profileHash(text),
      name: 'Fixture',
      createdAt: '2026-10-24',
      summary
    },
    text,
    revision: 'a'.repeat(64)
  }
  const records = new Map<string, { profile: RelayStoredProfile; text: string; revision: string }>()
  let time = 0,
    counter = 1
  const save = vi.fn(async (name: string, content: string) => {
    const summary = inspectProfile(content).summary
    if (!summary) throw new Error('invalid cache fixture')
    const profile = {
      id: '00000000-0000-0000-0000-' + String(++counter).padStart(12, '0'),
      sha256: profileHash(content),
      name,
      createdAt: '2026-10-24',
      summary
    }
    records.set(profile.id, { profile, text: content, revision: profileHash(name + content) })
    return structuredClone(profile)
  })
  const picked: ProfileSource = {
    name: 'fixture',
    text: resourceText,
    readAgain: vi.fn(async () => picked.text)
  }
  const adapters = {
    read: vi.fn(async (_selection: RelayProfileSelection) => structuredClone(base)),
    cache: {
      save,
      read: vi.fn(async (selection: RelayProfileSelection) => {
        const record = records.get(selection.id)
        if (!record || record.profile.sha256 !== selection.sha256)
          throw new Error('PRIVATE cache mismatch')
        return structuredClone(record)
      }),
      list: vi.fn(async () => ({
        profiles: [...records.values()].map((r) => structuredClone(r.profile)),
        activeId: null,
        incomplete: 0,
        warnings: []
      }))
    },
    save: vi.fn(async (name: string, text: string) => {
      const summary = inspectProfile(text).summary
      if (!summary) throw new Error()
      return { ...base.profile, name, sha256: profileHash(text), summary }
    }),
    pick: vi.fn(async (): Promise<ProfileSource | undefined> => picked),
    download: vi.fn(
      async (
        _url: string,
        _port: number,
        _signal: AbortSignal,
        _headers: Record<string, string>,
        _limit: number
      ) => resourceText
    ),
    confirmAcquire: vi.fn(async () => false),
    confirmBatchAcquire: vi.fn(async (_report: ProviderBatchPreparation) => false),
    confirmSnapshot: vi.fn(async () => false),
    now: () => time
  }
  const service = createProviderService(adapters),
    selection = { id: base.profile.id, sha256: base.profile.sha256 }
  clean.push(() => service.clear())
  return {
    service,
    adapters,
    base,
    records,
    selection,
    picked,
    advance: (n: number) => {
      time += n
    }
  }
}
async function cache(f: ReturnType<typeof fixture>) {
  f.adapters.confirmAcquire.mockResolvedValue(true)
  const prepared = await f.service.prepare({
    profile: f.selection,
    provider: 'P',
    proxyPort: 18191
  })
  const result = await f.service.acquire({ evidenceId: prepared.evidenceId })
  if (!result.resource) throw new Error('fixture did not cache')
  return { prepared, resource: result.resource }
}
describe('Bound provider acquisition, caching and static snapshots', () => {
  it('does no startup IO, strips declarations in public reports and cancels before download or cache IO', async () => {
    const f = fixture('http')
    expect(f.service.state()).toMatchObject({ pending: false })
    expect(f.adapters.read).not.toHaveBeenCalled()
    const inventory = await f.service.inspect(f.selection)
    expect(JSON.stringify(inventory)).not.toContain('PRIVATE')
    const report = await f.service.prepare({
      profile: f.selection,
      provider: 'P',
      proxyPort: 18191
    })
    expect(JSON.stringify(report)).not.toContain('PRIVATE')
    expect((await f.service.acquire({ evidenceId: report.evidenceId })).status).toBe('cancelled')
    expect(f.adapters.download).not.toHaveBeenCalled()
    expect(f.adapters.cache.save).not.toHaveBeenCalled()
  })
  it('rejects path/controller injection and binds each cached resource to the original source revision', async () => {
    const f = fixture()
    await expect(
      f.service.prepare({ profile: f.selection, provider: 'P', proxyPort: 18191, path: '/PRIVATE' })
    ).rejects.toThrow('只接受')
    const { resource } = await cache(f),
      record = f.records.get(resource.id)
    expect(record?.profile.name).toBe(resourceBinding(f.base.profile.id, f.base.revision, 'P'))
    expect(f.adapters.download).not.toHaveBeenCalled()
    expect(f.adapters.pick).not.toHaveBeenCalled()
    expect((await f.service.inspect(f.selection)).providers[0].resources).toHaveLength(1)
    f.base.revision = 'b'.repeat(64)
    expect((await f.service.inspect(f.selection)).providers[0].resources).toHaveLength(0)
    await expect(
      f.service.prepareSnapshot({
        profile: f.selection,
        resources: { P: { id: resource.id, sha256: resource.sha256 } }
      })
    ).rejects.toThrow('归属')
    expect(f.records.size).toBe(1)
  })
  it('passes the held HTTP headers, port and size budget without renderer mutation or fallback', async () => {
    const f = fixture('http')
    f.adapters.confirmAcquire.mockResolvedValue(true)
    const prepared = await f.service.prepare({
      profile: f.selection,
      provider: 'P',
      proxyPort: 18191
    })
    prepared.proxyPort = 1234
    prepared.provider.name = 'Injected'
    expect((await f.service.acquire({ evidenceId: prepared.evidenceId })).status).toBe('cached')
    expect(f.adapters.download).toHaveBeenCalledWith(
      'https://p.invalid/PRIVATE?token=PRIVATE',
      18191,
      expect.any(AbortSignal),
      { authorization: 'Bearer PRIVATE' },
      2097152
    )
    expect(f.adapters.download).toHaveBeenCalledOnce()
  })
  it('uses only the selected local file and rejects a changing file before cache write', async () => {
    const f = fixture('file')
    f.adapters.confirmAcquire.mockResolvedValue(true)
    const prepared = await f.service.prepare({
      profile: f.selection,
      provider: 'P',
      proxyPort: 18191
    })
    vi.mocked(f.picked.readAgain).mockResolvedValue('proxies: []')
    expect((await f.service.acquire({ evidenceId: prepared.evidenceId })).status).toBe('failed')
    expect(f.adapters.pick).toHaveBeenCalledOnce()
    expect(f.adapters.download).not.toHaveBeenCalled()
    expect(f.adapters.cache.save).not.toHaveBeenCalled()
  })
  it('refuses stale source or expired proof before external IO and preserves previous caches on failure', async () => {
    const f = fixture('http')
    await cache(f)
    f.adapters.download.mockRejectedValueOnce(new Error('PRIVATE transport failure'))
    const prepared = await f.service.prepare({
      profile: f.selection,
      provider: 'P',
      proxyPort: 18191
    })
    const failed = await f.service.acquire({ evidenceId: prepared.evidenceId })
    expect(failed.status).toBe('failed')
    expect(JSON.stringify(failed)).not.toContain('PRIVATE')
    expect(f.records.size).toBe(1)
    const stale = await f.service.prepare({ profile: f.selection, provider: 'P', proxyPort: 18191 })
    f.base.revision = 'b'.repeat(64)
    expect((await f.service.acquire({ evidenceId: stale.evidenceId })).status).toBe('failed')
    const expired = await f.service.prepare({
      profile: f.selection,
      provider: 'P',
      proxyPort: 18191
    })
    f.advance(60001)
    await expect(f.service.acquire({ evidenceId: expired.evidenceId })).rejects.toThrow('过期')
    expect(f.adapters.download).toHaveBeenCalledTimes(2)
  })
  it('rechecks all cache revisions at save and keeps the base original unchanged', async () => {
    const f = fixture(),
      before = f.base.text,
      { resource } = await cache(f)
    const prepare = () =>
      f.service.prepareSnapshot({
        profile: f.selection,
        resources: { P: { id: resource.id, sha256: resource.sha256 } }
      })
    let plan = await prepare()
    expect(plan.nodes).toBe(1)
    expect((await f.service.saveSnapshot({ evidenceId: plan.evidenceId })).status).toBe('cancelled')
    plan = await prepare()
    f.adapters.confirmSnapshot.mockResolvedValue(true)
    const cached = f.records.get(resource.id)
    if (!cached) throw new Error()
    cached.revision = 'changed'
    expect((await f.service.saveSnapshot({ evidenceId: plan.evidenceId })).status).toBe('failed')
    expect(f.adapters.save).not.toHaveBeenCalled()
    plan = await prepare()
    expect((await f.service.saveSnapshot({ evidenceId: plan.evidenceId })).status).toBe('saved')
    const text = f.adapters.save.mock.calls[0][1]
    expect(text).toContain('# source-profile: ' + f.base.profile.id)
    expect(text).toContain('# provider-cache: ' + resource.id)
    expect(analyzeProfile(text).data?.['proxy-providers']).toEqual({})
    expect(f.base.text).toBe(before)
    await expect(f.service.saveSnapshot({ evidenceId: plan.evidenceId })).rejects.toThrow('失效')
  })
  it('aborts only the current fetch and waits before closing without a write or retry', async () => {
    const f = fixture('http')
    f.adapters.confirmAcquire.mockResolvedValue(true)
    let signal!: AbortSignal, reject!: (error: Error) => void
    f.adapters.download.mockImplementationOnce(async (_url, _port, current) => {
      signal = current
      return new Promise<string>((_resolve, fail) => {
        reject = fail
      })
    })
    const plan = await f.service.prepare({ profile: f.selection, provider: 'P', proxyPort: 18191 }),
      pending = f.service.acquire({ evidenceId: plan.evidenceId })
    await vi.waitFor(() => expect(f.adapters.download).toHaveBeenCalled())
    expect(f.service.cancel({ evidenceId: '00000000-0000-0000-0000-000000000099' }).status).toBe(
      'stale'
    )
    expect(signal.aborted).toBe(false)
    const close = f.service.requestClose()
    expect(f.service.requestClose()).toBe(close)
    expect(signal.aborted).toBe(true)
    reject(new Error('PRIVATE'))
    expect((await pending).status).toBe('cancelled')
    await close
    expect(f.adapters.cache.save).not.toHaveBeenCalled()
  })
})

const batchRequest = (f: ReturnType<typeof fixture>) => ({
  profile: f.selection,
  providers: ['P', 'Q', 'R'],
  proxyPort: 18191
})

describe('Private batch acquisition of eligible HTTP(S) node providers', () => {
  it('verifies the complete eligible set and holds the consent and transfer inputs across IPC', async () => {
    const f = fixture('batch'),
      request = batchRequest(f)
    await expect(f.service.prepareBatch({ ...request, providers: ['P', 'Q'] })).rejects.toThrow()
    await expect(
      f.service.prepareBatch({ ...request, providers: ['P', 'Q', 'Q'] })
    ).rejects.toThrow()
    await expect(
      f.service.prepareBatch({ ...request, providers: ['P', 'Q', 'Inline'] })
    ).rejects.toThrow()
    const report = await f.service.prepareBatch({ ...request, providers: ['R', 'Q', 'P'] }),
      token = { evidenceId: report.evidenceId }
    expect(f.service.state().batchPreparedId).toBe(token.evidenceId)
    expect(report.providers.map((d) => d.origin)).toEqual([
      'https://p.invalid',
      'http://q.invalid',
      'https://r.invalid'
    ])
    expect(JSON.stringify(report)).not.toContain('PRIVATE')
    expect(f.adapters.download).not.toHaveBeenCalled()
    expect(f.adapters.cache.save).not.toHaveBeenCalled()

    report.proxyPort = 9999
    report.providers[0].name = 'Injected'
    f.adapters.confirmBatchAcquire.mockImplementationOnce(async (confirmation) => {
      expect(confirmation.providers.map((item) => item.name)).toEqual(['P', 'Q', 'R'])
      expect(confirmation.proxyPort).toBe(18191)
      confirmation.proxyPort = 9999
      return true
    })
    const result = await f.service.acquireBatch(token)
    expect(result.status).toBe('cached')
    expect(result.items.map((item) => [item.provider, item.status])).toEqual([
      ['P', 'cached'],
      ['Q', 'cached'],
      ['R', 'cached']
    ])
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(
      f.adapters.download.mock.calls.map(([url, port, , headers, limit]) => [
        url,
        port,
        headers,
        limit
      ])
    ).toEqual([
      [
        'https://p.invalid/PRIVATE?token=PRIVATE',
        18191,
        { authorization: 'Bearer PRIVATE' },
        2097152
      ],
      ['http://q.invalid/PRIVATE', 18191, {}, 512],
      ['https://r.invalid/PRIVATE', 18191, {}, 2097152]
    ])
    expect(f.adapters.cache.save.mock.calls.map(([name]) => name)).toEqual(
      ['P', 'Q', 'R'].map((name) => resourceBinding(f.selection.id, f.base.revision, name))
    )
    expect(f.adapters.confirmBatchAcquire).toHaveBeenCalledOnce()
    expect(f.adapters.pick).not.toHaveBeenCalled()
    expect(f.adapters.save).not.toHaveBeenCalled()
    await expect(f.service.acquireBatch(token)).rejects.toThrow('过期')
  })

  it('reports ordinary row failures while continuing the confirmed batch without retry or revealing errors', async () => {
    const f = fixture('batch')
    f.adapters.confirmBatchAcquire.mockResolvedValue(true)
    f.adapters.download
      .mockResolvedValueOnce('proxies: []')
      .mockRejectedValueOnce(new Error('PRIVATE transport failure'))
    const { evidenceId } = await f.service.prepareBatch(batchRequest(f)),
      result = await f.service.acquireBatch({ evidenceId })
    expect(result.status).toBe('partial')
    expect(result.items.map((item) => item.status)).toEqual(['failed', 'failed', 'cached'])
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(f.adapters.download).toHaveBeenCalledTimes(3)
    expect(f.adapters.cache.save).toHaveBeenCalledOnce()
  })

  it('stops on source drift before writing and on an unconfirmed write before another transfer', async () => {
    const f = fixture('batch')
    f.adapters.confirmBatchAcquire.mockResolvedValue(true)
    f.adapters.download.mockImplementationOnce(async () => {
      f.base.revision = 'b'.repeat(64)
      return resourceText
    })
    const stale = await f.service.prepareBatch(batchRequest(f)),
      staleResult = await f.service.acquireBatch({ evidenceId: stale.evidenceId })
    expect(staleResult.status).toBe('failed')
    expect(staleResult.items.map((item) => item.status)).toEqual(['failed', 'skipped', 'skipped'])
    expect(f.adapters.download).toHaveBeenCalledOnce()
    expect(f.adapters.cache.save).not.toHaveBeenCalled()

    f.adapters.cache.save.mockRejectedValueOnce(new Error('PRIVATE cache write'))
    const pending = await f.service.prepareBatch(batchRequest(f)),
      uncertain = await f.service.acquireBatch({ evidenceId: pending.evidenceId })
    expect(uncertain.status).toBe('uncertain')
    expect(uncertain.items.map((item) => item.status)).toEqual(['uncertain', 'skipped', 'skipped'])
    expect(JSON.stringify(uncertain)).not.toContain('PRIVATE')
    expect(f.adapters.download).toHaveBeenCalledTimes(2)
  })

  it('consumes a declined plan and refuses an expired plan after the native prompt', async () => {
    const f = fixture('batch')
    const declined = await f.service.prepareBatch(batchRequest(f))
    expect((await f.service.acquireBatch({ evidenceId: declined.evidenceId })).status).toBe(
      'cancelled'
    )
    await expect(f.service.acquireBatch({ evidenceId: declined.evidenceId })).rejects.toThrow()
    f.adapters.confirmBatchAcquire.mockImplementationOnce(async () => {
      f.advance(60001)
      return true
    })
    const expired = await f.service.prepareBatch(batchRequest(f))
    expect((await f.service.acquireBatch({ evidenceId: expired.evidenceId })).status).toBe('failed')
    expect(f.adapters.download).not.toHaveBeenCalled()
    expect(f.adapters.cache.save).not.toHaveBeenCalled()
  })

  it('invalidates only batch preparations, including when a source read is still in flight', async () => {
    const f = fixture('batch')
    const single = await f.service.prepare({
      profile: f.selection,
      provider: 'P',
      proxyPort: 18191
    })
    f.service.invalidateBatch()
    expect(f.service.state().preparedId).toBe(single.evidenceId)

    const batch = await f.service.prepareBatch(batchRequest(f))
    f.service.invalidateBatch()
    expect(f.service.state().batchPreparedId).toBeUndefined()
    await expect(f.service.acquireBatch({ evidenceId: batch.evidenceId })).rejects.toThrow('过期')

    const source = Promise.withResolvers<typeof f.base>()
    f.adapters.read.mockImplementationOnce(() => source.promise)
    const pending = f.service.prepareBatch(batchRequest(f))
    f.service.invalidateBatch()
    source.resolve(f.base)
    await expect(pending).rejects.toThrow('批量准备未通过')
    expect(f.service.state()).toMatchObject({ pending: false })
    expect(f.adapters.download).not.toHaveBeenCalled()
  })

  it('aborts a batch transfer when its view is invalidated and keeps earlier cache entries', async () => {
    const f = fixture('batch')
    f.adapters.confirmBatchAcquire.mockResolvedValue(true)
    f.adapters.download.mockResolvedValueOnce(resourceText).mockImplementationOnce(
      async (_url, _port, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('PRIVATE')), { once: true })
        })
    )
    const { evidenceId } = await f.service.prepareBatch(batchRequest(f))
    const pending = f.service.acquireBatch({ evidenceId })
    try {
      await vi.waitFor(() => expect(f.adapters.download).toHaveBeenCalledTimes(2))
    } finally {
      f.service.invalidateBatch()
    }
    const result = await pending
    expect(result.status).toBe('partial')
    expect(result.items.map((item) => item.status)).toEqual(['cached', 'cancelled', 'skipped'])
    expect(f.records.size).toBe(1)
    expect(f.adapters.download).toHaveBeenCalledTimes(2)
    expect(f.service.state()).toMatchObject({ pending: false })
  })

  it('cancels later requests during a cache write and keeps a completed immutable cache entry', async () => {
    const f = fixture('batch'),
      save = f.adapters.cache.save.getMockImplementation()
    if (!save) throw new Error('fixture missing cache writer')
    f.adapters.confirmBatchAcquire.mockResolvedValue(true)
    let finish!: () => void
    f.adapters.cache.save.mockImplementationOnce(async (name, resource) => {
      await new Promise<void>((resolve) => {
        finish = resolve
      })
      return save(name, resource)
    })
    const { evidenceId } = await f.service.prepareBatch(batchRequest(f)),
      pending = f.service.acquireBatch({ evidenceId })
    await vi.waitFor(() => expect(f.service.state().phase).toBe('saving'))
    expect(f.adapters.download).toHaveBeenCalledOnce()
    expect(f.service.cancel({ evidenceId }).status).toBe('requested')
    const close = f.service.requestClose()
    finish()
    const result = await pending
    await close
    expect(result.status).toBe('partial')
    expect(result.items.map((item) => item.status)).toEqual(['cached', 'skipped', 'skipped'])
    expect(f.records.size).toBe(1)
    expect(f.adapters.download).toHaveBeenCalledOnce()
  })

  it('aborts the in-flight transfer at the total budget and skips queued requests', async () => {
    vi.useFakeTimers()
    const f = fixture('batch')
    f.adapters.confirmBatchAcquire.mockResolvedValue(true)
    f.adapters.download.mockImplementationOnce(async (_url, _port, signal) => {
      return new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('PRIVATE')), { once: true })
      })
    })
    const { evidenceId } = await f.service.prepareBatch(batchRequest(f)),
      pending = f.service.acquireBatch({ evidenceId })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.adapters.download).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(90000)
    const result = await pending
    expect(result.status).toBe('failed')
    expect(result.items.map((item) => item.status)).toEqual(['failed', 'skipped', 'skipped'])
    expect(f.adapters.download).toHaveBeenCalledOnce()
    expect(f.adapters.cache.save).not.toHaveBeenCalled()
  })
})
