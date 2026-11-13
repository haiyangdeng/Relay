import * as files from 'fs/promises'
import type { FileHandle } from 'fs/promises'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { zstdCompressSync } from 'zlib'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { ResourceValidationJob } from '../resources/check-definition'
import { RESOURCE_BYTE_LIMIT, resourceHash } from '../resources/source'
import {
  createTunResourceInbox,
  type TunResourceInbox,
  type TunResourceInboxRetainedReport
} from './resource-inbox'
import { tunRuleProviderBlobTicket, type TunRuleProviderBlobKind } from './rule-provider-ticket'

vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>()
  return {
    ...actual,
    open: vi.fn(actual.open),
    unlink: vi.fn(actual.unlink),
    rm: vi.fn(actual.rm),
    rmdir: vi.fn(actual.rmdir)
  }
})
const reports: TunResourceInboxRetainedReport[] = []
function mrs(): Buffer {
  // Same bounded structural fixture as resources/check-definition.test.ts.
  const plain = Buffer.alloc(63)
  Buffer.from([77, 82, 83, 1]).copy(plain)
  plain[4] = 0
  plain.writeBigInt64BE(2n, 5)
  plain[21] = 1
  for (const offset of [22, 38, 54]) plain.writeBigInt64BE(1n, offset)
  plain[62] = 97
  return zstdCompressSync(plain)
}
const provider = (
  kind: TunRuleProviderBlobKind = 'rule-yaml',
  bytes?: Buffer
): ResourceValidationJob => {
  bytes ??=
    kind === 'rule-mrs'
      ? mrs()
      : Buffer.from(kind === 'rule-yaml' ? 'payload:\n - fixture.invalid\n' : 'fixture.invalid\n')
  return {
    descriptor: { name: 'PRIVATE_SOURCE_NAME', kind, behavior: 'domain', selector: '' },
    bytes,
    sha256: resourceHash(bytes)
  }
}
const geo = (bytes = Buffer.from('private geo bytes')): ResourceValidationJob => ({
  descriptor: { name: 'Private Geo', kind: 'geoip-dat', behavior: null, selector: 'cn' },
  bytes,
  sha256: resourceHash(bytes)
})
async function fixture(run: (inbox: TunResourceInbox) => Promise<void>): Promise<void> {
  const inbox = await createTunResourceInbox()
  try {
    await run(inbox)
  } finally {
    reports.push(await inbox.dispose())
  }
}
afterEach(async () => {
  expect(files.unlink).not.toHaveBeenCalled()
  expect(files.rm).not.toHaveBeenCalled()
  expect(files.rmdir).not.toHaveBeenCalled()
  vi.restoreAllMocks()
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
  vi.mocked(files.open).mockReset().mockImplementation(actual.open)
})
afterAll(async () => {
  if (process.env.RELAY_TUN_PROVIDER_INBOX_OUTPUT)
    await files.writeFile(
      process.env.RELAY_TUN_PROVIDER_INBOX_OUTPUT,
      JSON.stringify(
        {
          scope:
            'Actual ordinary-UID private files only; Native ACK simulated. No Native/Core/network. Producer and tests never delete paths; all reports retained.',
          reports
        },
        null,
        2
      ) + '\n',
      { mode: 0o600 }
    )
})
const invoke = (inbox: TunResourceInbox, raw: unknown) =>
  Reflect.apply(inbox.stageRuleProvider, inbox, [raw, new AbortController().signal, () => {}])

describe('One Geo and rule-provider inbox pool without Node deletion', () => {
  it.each(['rule-yaml', 'rule-text', 'rule-mrs'] as const)(
    'stages actual %s bytes at its exact generated UUID filename',
    async (kind) =>
      fixture(async (inbox) => {
        const job = provider(kind),
          ticket = await inbox.stageRuleProvider(job, new AbortController().signal, () => {})
        expect(ticket).toEqual(tunRuleProviderBlobTicket(ticket))
        expect(Object.keys(ticket).sort()).toEqual([
          'blobId',
          'bytes',
          'filename',
          'kind',
          'sha256'
        ])
        expect(ticket.filename).toBe(`${ticket.blobId}.${kind.slice(5)}`)
        expect(JSON.stringify(ticket)).not.toContain('PRIVATE_SOURCE_NAME')
        const dir = join(inbox.directory, ticket.blobId),
          path = join(dir, ticket.filename)
        expect(await files.readdir(dir)).toEqual([ticket.filename])
        expect((await files.stat(dir)).mode & 0o7777).toBe(0o700)
        expect((await files.stat(path)).mode & 0o7777).toBe(0o600)
        expect(resourceHash(await files.readFile(path))).toBe(job.sha256)
        expect(inbox.retained().reservedBytes).toBe(job.bytes.length)
      })
  )
  it('strictly decodes each registered kind and filename without name/path/authority fields', () => {
    const blobId = randomUUID(),
      good = {
        blobId,
        kind: 'rule-yaml',
        sha256: 'a'.repeat(64),
        bytes: 1,
        filename: `${blobId}.yaml`
      }
    expect(tunRuleProviderBlobTicket(good)).toEqual(good)
    for (const raw of [
      { ...good, blobId: '0'.repeat(36) },
      { ...good, filename: `${randomUUID()}.yaml` },
      { ...good, filename: `../${blobId}.yaml` },
      { ...good, filename: `${blobId}.text` },
      { ...good, filename: good.filename.toUpperCase() },
      { ...good, kind: 'geoip-dat' },
      { ...good, kind: false },
      { ...good, sha256: 'A'.repeat(64) },
      { ...good, bytes: NaN },
      { ...good, bytes: 0 },
      { ...good, bytes: 8 * 1024 * 1024 + 1 },
      { ...good, selector: 'cn' },
      { ...good, name: 'PRIVATE' },
      { ...good, path: '/PRIVATE' },
      { ...good, authorized: true },
      Object.assign(Object.create(null), good)
    ])
      expect(() => tunRuleProviderBlobTicket(raw)).toThrow()
  })
  it('reuses bounded preflight and rejects malformed payloads before creating entries', async () =>
    fixture(async (inbox) => {
      const good = provider(),
        invokeBad = async (raw: unknown) => expect(invoke(inbox, raw)).rejects.toThrow()
      for (const bad of [
        geo(),
        { ...good, path: '/PRIVATE' },
        { ...good, sha256: '0'.repeat(64) },
        { ...good, descriptor: { ...good.descriptor, selector: 'PRIVATE' } },
        provider('rule-yaml', Buffer.from('payload: []\npayload: [a]\n')),
        provider('rule-yaml', Buffer.from('payload: &x [a]\nrules: *x\n')),
        provider('rule-text', Buffer.from([0xff])),
        provider('rule-text', Buffer.from('a\0b')),
        provider('rule-text', Buffer.alloc(8 * 1024 * 1024 + 1, 0x61)),
        provider('rule-mrs', Buffer.from('not a zstd MRS')),
        {
          ...provider('rule-mrs'),
          descriptor: { ...provider('rule-mrs').descriptor, behavior: 'classical' }
        }
      ])
        await invokeBad(bad)
      expect(inbox.retained().retained).toEqual([])
      expect(await files.readdir(inbox.directory)).toEqual([])
      // The old Geo entry remains Geo-only.
      await expect(
        inbox.stage(provider(), new AbortController().signal, () => {})
      ).rejects.toThrow()
    }))
  it('allows classical dependencies for a later complete checker without claiming Core acceptance', async () =>
    fixture(async (inbox) => {
      const job = provider('rule-text', Buffer.from('GEOSITE,fixture,REJECT\n'))
      job.descriptor.behavior = 'classical'
      const ticket = await inbox.stageRuleProvider(job, new AbortController().signal, () => {})
      expect(ticket.kind).toBe('rule-text')
      expect(
        resourceHash(await files.readFile(join(inbox.directory, ticket.blobId, ticket.filename)))
      ).toBe(job.sha256)
    }))
  it('copies the provider payload and descriptor before the first await', async () =>
    fixture(async (inbox) => {
      const job = provider(),
        original = Buffer.from(job.bytes),
        pending = inbox.stageRuleProvider(job, new AbortController().signal, () => {})
      job.bytes.fill(0)
      job.descriptor.kind = 'rule-text'
      job.descriptor.name = 'CHANGED'
      job.sha256 = '0'.repeat(64)
      const ticket = await pending
      expect(ticket.kind).toBe('rule-yaml')
      expect(ticket.sha256).toBe(resourceHash(original))
      expect(
        resourceHash(await files.readFile(join(inbox.directory, ticket.blobId, ticket.filename)))
      ).toBe(resourceHash(original))
    }))
  it('shares four tickets and validates all ACK fields using the registered discriminant', async () =>
    fixture(async (inbox) => {
      const first = await inbox.stage(geo(), new AbortController().signal, () => {}),
        second = await inbox.stageRuleProvider(provider(), new AbortController().signal, () => {})
      await inbox.stage(geo(), new AbortController().signal, () => {})
      await inbox.stageRuleProvider(provider('rule-text'), new AbortController().signal, () => {})
      expect(inbox.retained().retained).toHaveLength(4)
      await expect(inbox.stage(geo(), new AbortController().signal, () => {})).rejects.toThrow()
      await expect(
        inbox.stageRuleProvider(provider(), new AbortController().signal, () => {})
      ).rejects.toThrow()
      for (const wrong of [
        { ...second, filename: `${randomUUID()}.yaml` },
        { ...second, kind: 'rule-text' as const },
        { ...second, sha256: '0'.repeat(64) },
        { ...second, bytes: second.bytes + 1 },
        { ...first, kind: second.kind, filename: second.filename },
        { ...second, kind: first.kind, selector: first.selector }
      ])
        expect(() => inbox.acknowledgeDiscard(wrong)).toThrow('ACK')
      expect(inbox.retained().retained).toHaveLength(4)
      inbox.acknowledgeDiscard(second) // Simulated authenticated Native ACK only.
      inbox.acknowledgeDiscard(second)
      expect(inbox.retained().retained).toHaveLength(3)
      await inbox.stage(geo(), new AbortController().signal, () => {})
      expect(inbox.retained().retained).toHaveLength(4)
      expect(await files.readFile(join(inbox.directory, second.blobId, second.filename))).toEqual(
        provider().bytes
      )
    }))
  it(
    'charges provider reservations to the same 256MiB cap and releases only its exact ACK',
    async () =>
      fixture(async (inbox) => {
        const ticket = await inbox.stageRuleProvider(
            provider(),
            new AbortController().signal,
            () => {}
          ),
          bytes = Buffer.alloc(RESOURCE_BYTE_LIMIT, 0x2a),
          job = geo(bytes)
        await inbox.stage(job, new AbortController().signal, () => {})
        await expect(inbox.stage(job, new AbortController().signal, () => {})).rejects.toThrow()
        expect(inbox.retained().reservedBytes).toBe(RESOURCE_BYTE_LIMIT + ticket.bytes)
        inbox.acknowledgeDiscard(ticket)
        await inbox.stage(job, new AbortController().signal, () => {})
        expect(inbox.retained().reservedBytes).toBe(256 * 1024 * 1024)
      }),
    20_000
  )
  it.each(['geo', 'provider'] as const)(
    'keeps both lanes busy and dispose draining during a held %s writer',
    async (kind) =>
      fixture(async (inbox) => {
        const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises'),
          entered = Promise.withResolvers<void>(),
          gate = Promise.withResolvers<void>()
        let held: FileHandle | undefined
        vi.mocked(files.open).mockImplementation(async (path, flags, mode) => {
          const handle = await actual.open(path, flags, mode)
          if (String(path).endsWith('.yaml') || String(path).endsWith('GeoIP.dat')) {
            held = handle
            const write = handle.writeFile.bind(handle)
            vi.spyOn(handle, 'writeFile').mockImplementationOnce(async (...args) => {
              await write(...args)
              entered.resolve()
              await gate.promise
            })
          }
          return handle
        })
        const pending =
            kind === 'geo'
              ? inbox.stage(geo(), new AbortController().signal, () => {})
              : inbox.stageRuleProvider(provider(), new AbortController().signal, () => {}),
          rejected = expect(pending).rejects.toThrow('未发布票据')
        try {
          await entered.promise
          await expect(inbox.stage(geo(), new AbortController().signal, () => {})).rejects.toThrow(
            '尚未结束'
          )
          await expect(
            inbox.stageRuleProvider(provider(), new AbortController().signal, () => {})
          ).rejects.toThrow('尚未结束')
          expect(() => inbox.acknowledgeDiscard(inbox.retained().retained[0].ticket)).toThrow(
            '尚未结束'
          )
          let idle = false,
            disposed = false
          const idleWork = inbox.whenIdle().then(() => {
              idle = true
            }),
            close = inbox.dispose().then(() => {
              disposed = true
            })
          await Promise.resolve()
          expect(idle).toBe(false)
          expect(disposed).toBe(false)
          expect(inbox.isBusy()).toBe(true)
          gate.resolve()
          await rejected
          await idleWork
          await close
          expect(inbox.retained().retained[0].status).toBe('partial')
          expect(held?.fd).toBe(-1)
        } finally {
          gate.resolve()
          await Promise.allSettled([pending])
        }
      })
  )
  it('preserves known and unknown files on a failed provider publication', async () =>
    fixture(async (inbox) => {
      const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
      vi.mocked(files.open).mockImplementation(async (path, flags, mode) => {
        const handle = await actual.open(path, flags, mode)
        if (String(path).endsWith('.yaml')) {
          const close = handle.close.bind(handle)
          vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
            await close()
            await actual.writeFile(join(String(path), '..', 'FOREIGN'), 'foreign', { mode: 0o600 })
          })
        }
        return handle
      })
      await expect(
        inbox.stageRuleProvider(provider(), new AbortController().signal, () => {})
      ).rejects.toThrow('未发布票据')
      const entry = inbox.retained().retained[0],
        ticket = tunRuleProviderBlobTicket(entry.ticket),
        dir = join(inbox.directory, ticket.blobId)
      expect(entry.status).toBe('partial')
      expect(await files.readFile(join(dir, 'FOREIGN'), 'utf8')).toBe('foreign')
      expect(resourceHash(await files.readFile(join(dir, ticket.filename)))).toBe(ticket.sha256)
      expect(inbox.retained().reservedBytes).toBe(ticket.bytes)
    }))
  it('does not publish or allocate before reentrant cancellation, and rejects a late cancelled writer', async () =>
    fixture(async (inbox) => {
      const abort = new AbortController()
      await expect(
        inbox.stageRuleProvider(provider(), abort.signal, () => abort.abort())
      ).rejects.toThrow()
      expect(inbox.retained().retained).toEqual([])
      const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises'),
        late = new AbortController()
      vi.mocked(files.open).mockImplementation(async (path, flags, mode) => {
        const handle = await actual.open(path, flags, mode)
        if (String(path).endsWith('.yaml')) {
          const sync = handle.sync.bind(handle)
          vi.spyOn(handle, 'sync').mockImplementationOnce(async () => {
            await sync()
            late.abort()
          })
        }
        return handle
      })
      await expect(inbox.stageRuleProvider(provider(), late.signal, () => {})).rejects.toThrow(
        '未发布票据'
      )
      expect(inbox.retained().retained[0].status).toBe('partial')
    }))
})
