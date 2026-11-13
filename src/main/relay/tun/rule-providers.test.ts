import { describe, expect, it, vi } from 'vitest'
import { resourceHash } from '../resources/source'
import type { RuleProviderResourceCandidate } from '../resources/rule-provider-candidate'
import { createTunRuleProvidersService, type TunRuleProviderLease } from './rule-providers'
import type {
  TunRuleProvidersNativeSnapshot,
  TunRuleProvidersChannelResult,
  TunRuleProvidersMutation
} from './rule-providers-contract'

const sessionId = '11111111-1111-4111-8111-111111111111',
  selected = { id: '22222222-2222-4222-8222-222222222222', sha256: '' },
  revision = 'a'.repeat(64),
  generation = 'b'.repeat(64),
  oldSHA256 = 'c'.repeat(64),
  bytes = Buffer.from('payload: [two.invalid]\n'),
  sha256 = resourceHash(bytes),
  blobId = '33333333-3333-4333-8333-333333333333'
function snapshot(updated = false): TunRuleProvidersNativeSnapshot {
  const row = {
    name: 'one',
    kind: 'rule-yaml' as const,
    behavior: 'domain' as const,
    fileSHA256: updated ? sha256 : oldSHA256,
    bytes: updated ? bytes.length : 10,
    ruleCount: 1
  }
  return {
    configurationRevision: revision,
    generationSHA256: updated ? 'd'.repeat(64) : generation,
    groups: [['one', 'same file'], ['unrelated']],
    providers: [row, { ...row, name: 'same file' }, { ...row, name: 'unrelated' }].map(
      (provider) =>
        provider.name === 'unrelated' ? { ...provider, fileSHA256: oldSHA256, bytes: 10 } : provider
    )
  }
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => (resolve = complete))
  return { promise, resolve }
}
async function until(predicate: () => boolean) {
  for (let index = 0; index < 30 && !predicate(); ++index) await Promise.resolve()
  expect(predicate()).toBe(true)
}
function fixture() {
  const ticket = {
      blobId,
      kind: 'rule-yaml' as const,
      sha256,
      bytes: bytes.length,
      filename: `${blobId}.yaml`
    },
    candidate: RuleProviderResourceCandidate = {
      job: {
        descriptor: { name: 'cache', kind: 'rule-yaml', behavior: 'domain', selector: '' },
        bytes: Buffer.from(bytes),
        sha256
      },
      revision: 'e'.repeat(64),
      recheck: vi.fn(async () => {})
    },
    channel = {
      read: vi.fn(async () => ({ status: 'snapshot' as const, snapshot: snapshot() })),
      replace: vi.fn(
        async (_input: TunRuleProvidersMutation): Promise<TunRuleProvidersChannelResult> => ({
          status: 'updated',
          snapshot: snapshot(true)
        })
      ),
      discardBlob: vi.fn(async () => 'discarded' as const),
      cancel: vi.fn(async () => {}),
      invalidate: vi.fn(),
      isAvailable: vi.fn(() => true),
      isBusy: vi.fn(() => false),
      whenIdle: vi.fn(async () => {})
    },
    inbox = {
      stageRuleProvider: vi.fn(async () => ({ ...ticket })),
      acknowledgeDiscard: vi.fn()
    },
    lease: TunRuleProviderLease = {
      owner: {},
      sessionId,
      configurationRevision: revision,
      channel,
      inbox,
      assertCurrent: vi.fn(),
      release: vi.fn()
    },
    adapters = {
      acquire: vi.fn(() => ({ status: 'held' as const, lease })),
      readCandidate: vi.fn(async () => candidate),
      confirm: vi.fn(async () => true),
      now: () => 100
    },
    service = createTunRuleProvidersService(adapters),
    request = () => ({
      sessionId,
      configurationRevision: revision,
      expectedGenerationSHA256: generation,
      provider: 'one',
      resource: { ...selected, sha256 }
    })
  return { service, adapters, lease, channel, inbox, candidate, request, ticket }
}

describe('Held-owner local rule-provider publication coordinator', () => {
  it('reads without candidate acquisition, consent or publication', async () => {
    const f = fixture()
    const result = await f.service.read({ sessionId }, () => {})
    expect(result.status).toBe('snapshot')
    expect(f.adapters.readCandidate).not.toHaveBeenCalled()
    expect(f.adapters.confirm).not.toHaveBeenCalled()
    expect(f.inbox.stageRuleProvider).not.toHaveBeenCalled()
    expect(f.channel.replace).not.toHaveBeenCalled()
    expect(f.lease.release).toHaveBeenCalledOnce()
  })
  it('confirms every linked name and publishes only the immutable matching blob', async () => {
    const f = fixture(),
      result = await f.service.replace(f.request(), () => {})
    expect(result.status).toBe('updated')
    expect(f.adapters.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'one',
        linkedProviders: ['one', 'same file'],
        oldSHA256,
        newSHA256: sha256
      })
    )
    expect(f.channel.replace).toHaveBeenCalledWith(
      {
        configurationRevision: revision,
        expectedGenerationSHA256: generation,
        provider: 'one',
        oldSHA256,
        newSHA256: sha256,
        blobId,
        kind: 'rule-yaml',
        bytes: bytes.length,
        filename: `${blobId}.yaml`,
        declaredRuleCount: 1
      },
      expect.any(AbortSignal),
      expect.any(Function)
    )
    expect(f.inbox.acknowledgeDiscard).toHaveBeenCalledWith(f.ticket)
    expect(f.service.isBusy()).toBe(false)
  })
  it('refuses an old generation before reading the candidate or showing consent', async () => {
    const f = fixture(),
      result = await f.service.replace(
        { ...f.request(), expectedGenerationSHA256: 'f'.repeat(64) },
        () => {}
      )
    expect(result.status).toBe('stale')
    expect(f.adapters.readCandidate).not.toHaveBeenCalled()
    expect(f.adapters.confirm).not.toHaveBeenCalled()
    expect(f.channel.replace).not.toHaveBeenCalled()
  })
  it('native consent cancellation creates no staged file and sends no mutation', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValue(false)
    expect((await f.service.replace(f.request(), () => {})).status).toBe('cancelled')
    expect(f.inbox.stageRuleProvider).not.toHaveBeenCalled()
    expect(f.channel.replace).not.toHaveBeenCalled()
  })
  it('rechecks mutable candidate bytes after consent before any stage', async () => {
    const f = fixture()
    f.adapters.confirm.mockImplementation(async () => {
      f.candidate.job.bytes.fill(0)
      return true
    })
    expect((await f.service.replace(f.request(), () => {})).status).toBe('unavailable')
    expect(f.inbox.stageRuleProvider).not.toHaveBeenCalled()
    expect(f.channel.replace).not.toHaveBeenCalled()
  })
  it('revocation during the final owner callback cannot enter the staged writer', async () => {
    const f = fixture()
    f.adapters.confirm.mockImplementation(async () => {
      f.lease.assertCurrent = () => f.service.invalidate()
      return true
    })
    expect((await f.service.replace(f.request(), () => {})).status).toBe('cancelled')
    expect(f.inbox.stageRuleProvider).not.toHaveBeenCalled()
    expect(f.channel.replace).not.toHaveBeenCalled()
    await f.service.whenIdle()
  })
  it('does not release shared admission while a cancelled native operation is draining', async () => {
    const f = fixture(),
      drain = deferred<void>()
    f.channel.whenIdle.mockReturnValue(drain.promise)
    const work = f.service.replace(f.request(), () => {})
    await until(() => f.channel.replace.mock.calls.length === 1)
    f.service.invalidate()
    await until(() => f.channel.whenIdle.mock.calls.length === 1)
    expect(f.service.isBusy()).toBe(true)
    expect(f.lease.release).not.toHaveBeenCalled()
    expect((await f.service.read({ sessionId }, () => {})).status).toBe('busy')
    drain.resolve()
    expect((await work).status).toBe('uncertain')
    expect(f.lease.release).toHaveBeenCalledOnce()
    expect(f.channel.discardBlob).not.toHaveBeenCalled()
  })
  it('a lost acknowledgement retains its blob and cannot be adopted by a later read', async () => {
    const f = fixture()
    f.channel.replace.mockRejectedValue(new Error('private lost ACK'))
    expect((await f.service.replace(f.request(), () => {})).status).toBe('uncertain')
    expect(f.channel.discardBlob).not.toHaveBeenCalled()
    expect(f.inbox.acknowledgeDiscard).not.toHaveBeenCalled()
    const reads = f.channel.read.mock.calls.length
    expect((await f.service.read({ sessionId }, () => {})).status).toBe('uncertain')
    expect(f.channel.read).toHaveBeenCalledTimes(reads)
    expect(f.channel.replace).toHaveBeenCalledOnce()
  })
  it.each(['cancelled', 'unchanged', 'stale'] as const)(
    'does not quarantine a bound terminal %s after UI scope revocation',
    async (status) => {
      const f = fixture()
      const before = snapshot()
      if (status === 'unchanged') {
        for (const row of before.providers)
          if (row.name !== 'unrelated') {
            row.fileSHA256 = sha256
            row.bytes = bytes.length
          }
        f.channel.read.mockResolvedValue({ status: 'snapshot', snapshot: before })
      }
      f.channel.replace.mockImplementation(async () => {
        f.service.invalidate()
        return status === 'unchanged' ? { status, snapshot: before } : { status }
      })
      expect((await f.service.replace(f.request(), () => {})).status).toBe('cancelled')
      expect((await f.service.read({ sessionId }, () => {})).status).toBe('snapshot')
      expect(f.channel.replace).toHaveBeenCalledOnce()
      expect(f.channel.discardBlob).toHaveBeenCalledWith(f.ticket)
      expect(f.inbox.acknowledgeDiscard).toHaveBeenCalledWith(f.ticket)
      expect(f.channel.invalidate).not.toHaveBeenCalled()
    }
  )
  it('does not treat an inconsistent whole-table no-op receipt as zero publication after scope loss', async () => {
    const f = fixture(),
      before = snapshot()
    for (const row of before.providers)
      if (row.name !== 'unrelated') {
        row.fileSHA256 = sha256
        row.bytes = bytes.length
      }
    f.channel.read.mockResolvedValue({ status: 'snapshot', snapshot: before })
    f.channel.replace.mockImplementation(async () => {
      const after = structuredClone(before)
      after.providers[2].fileSHA256 = 'f'.repeat(64)
      f.service.invalidate()
      return { status: 'unchanged', snapshot: after }
    })
    expect((await f.service.replace(f.request(), () => {})).status).toBe('uncertain')
    expect((await f.service.read({ sessionId }, () => {})).status).toBe('uncertain')
    expect(f.channel.discardBlob).not.toHaveBeenCalled()
    expect(f.inbox.acknowledgeDiscard).not.toHaveBeenCalled()
  })
  it('binds the existing raw-entry declaration to the actual bytes without calling it Core acceptance', async () => {
    const f = fixture(),
      body = Buffer.from('payload: [one.invalid, two.invalid]\n'),
      digest = resourceHash(body),
      request = f.request()
    f.candidate.job.bytes = body
    f.candidate.job.sha256 = digest
    request.resource.sha256 = digest
    f.inbox.stageRuleProvider.mockResolvedValue({ ...f.ticket, sha256: digest, bytes: body.length })
    f.channel.replace.mockImplementation(async (input) => {
      expect(input.declaredRuleCount).toBe(2)
      const after = snapshot(true)
      for (const row of after.providers)
        if (row.name !== 'unrelated') {
          row.fileSHA256 = digest
          row.bytes = body.length
          row.ruleCount = 2
        }
      return { status: 'updated', snapshot: after }
    })
    expect((await f.service.replace(request, () => {})).status).toBe('updated')
    expect(f.channel.replace).toHaveBeenCalledOnce()
  })
  it.each(['alias', 'unrelated', 'generation', 'partial-count'])(
    'quarantines a confirmed reply whose %s escapes the consented publication',
    async (changed) => {
      const f = fixture(),
        after = snapshot(true)
      if (changed === 'alias') after.providers[1].fileSHA256 = oldSHA256
      if (changed === 'unrelated') after.providers[2].bytes++
      if (changed === 'generation') after.generationSHA256 = generation
      if (changed === 'partial-count') after.providers[0].ruleCount = 0
      f.channel.replace.mockResolvedValue({ status: 'updated', snapshot: after })
      expect((await f.service.replace(f.request(), () => {})).status).toBe('uncertain')
      expect(f.channel.discardBlob).not.toHaveBeenCalled()
      expect((await f.service.read({ sessionId }, () => {})).status).toBe('uncertain')
    }
  )
  it('a newer held owner can read without clearing the old owner quarantine', async () => {
    const f = fixture()
    f.channel.replace.mockRejectedValue(new Error('lost'))
    await f.service.replace(f.request(), () => {})
    const previous = f.lease.owner
    f.lease.owner = {}
    expect((await f.service.read({ sessionId }, () => {})).status).toBe('snapshot')
    f.lease.owner = previous
    expect((await f.service.read({ sessionId }, () => {})).status).toBe('uncertain')
  })
  it('expires a slow confirmation before staging without retrying it', async () => {
    const f = fixture()
    let now = 100
    f.adapters.now = () => now
    const service = createTunRuleProvidersService(f.adapters)
    f.adapters.confirm.mockImplementation(async () => {
      now += 30000
      return true
    })
    expect((await service.replace(f.request(), () => {})).status).toBe('cancelled')
    expect(f.inbox.stageRuleProvider).not.toHaveBeenCalled()
    expect(f.channel.replace).not.toHaveBeenCalled()
    expect(f.adapters.confirm).toHaveBeenCalledOnce()
  })
  it('does not spend the Native transaction deadline while preparing its one-time confirmation', async () => {
    const f = fixture()
    let now = 100
    const service = createTunRuleProvidersService({ ...f.adapters, now: () => now })
    f.adapters.confirm.mockImplementation(async () => {
      now = 20100
      return true
    })
    f.channel.replace.mockImplementation(async () => {
      now = 35100
      return { status: 'updated', snapshot: snapshot(true) }
    })
    expect((await service.replace(f.request(), () => {})).status).toBe('updated')
    f.channel.read.mockResolvedValue({ status: 'snapshot', snapshot: snapshot(true) })
    expect((await service.read({ sessionId }, () => {})).status).toBe('snapshot')
    expect(f.channel.replace).toHaveBeenCalledOnce()
    expect(f.channel.invalidate).not.toHaveBeenCalled()
  })
  it('revocation inside shared admission is not refreshed into a new lease', async () => {
    const f = fixture()
    f.adapters.acquire.mockImplementation(() => {
      f.service.invalidate()
      return { status: 'held', lease: f.lease }
    })
    expect((await f.service.replace(f.request(), () => {})).status).toBe('cancelled')
    expect(f.channel.read).not.toHaveBeenCalled()
    expect(f.channel.replace).not.toHaveBeenCalled()
    expect(f.lease.release).toHaveBeenCalledOnce()
  })
  it('settles waiters even if release fails after actual drain', async () => {
    const f = fixture()
    f.lease.release = () => {
      throw new Error('private release failure')
    }
    expect((await f.service.replace(f.request(), () => {})).status).toBe('uncertain')
    await f.service.whenIdle()
    expect(f.service.isBusy()).toBe(false)
    expect((await f.service.read({ sessionId }, () => {})).status).toBe('uncertain')
  })
})
