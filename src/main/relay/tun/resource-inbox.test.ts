import * as files from 'fs/promises'
import type { FileHandle } from 'fs/promises'
import { basename, join } from 'path'
import { randomUUID } from 'crypto'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { geoResourceKinds, type GeoResourceKind } from '../../../shared/relay/geo-origins'
import { resourceHash, RESOURCE_BYTE_LIMIT } from '../resources/source'
import type { ResourceValidationJob } from '../resources/check-definition'
import {
  createTunResourceInbox,
  TUN_RESOURCE_INBOX_MAX_BYTES,
  type TunResourceBlobTicket,
  type TunResourceInbox,
  type TunResourceInboxRetainedReport
} from './resource-inbox'

vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>()
  return {
    ...actual,
    open: vi.fn(actual.open),
    mkdir: vi.fn(actual.mkdir),
    mkdtemp: vi.fn(actual.mkdtemp),
    unlink: vi.fn(actual.unlink),
    rm: vi.fn(actual.rm),
    rmdir: vi.fn(actual.rmdir)
  }
})
const reports: TunResourceInboxRetainedReport[] = [],
  names = ['GeoIP.dat', 'GeoSite.dat', 'Country.mmdb', 'ASN.mmdb']
const job = (
  kind: GeoResourceKind = 'geoip-dat',
  bytes = Buffer.from([0xff, 0, 1, 2])
): ResourceValidationJob => ({
  descriptor: { name: 'Private fixture', kind, behavior: null, selector: 'cn' },
  bytes,
  sha256: resourceHash(bytes)
})
const invoke = (inbox: TunResourceInbox, raw: unknown) =>
  Reflect.apply(inbox.stage, inbox, [raw, new AbortController().signal, () => {}])
async function fixture(
  run: (f: {
    inbox: TunResourceInbox
    guard: () => void
    lose: () => void
    hold<T>(value: T): { promise: Promise<T>; release: () => void }
    watchFile(fn: (handle: FileHandle, path: string) => Promise<void> | void): Promise<void>
  }) => Promise<void>
): Promise<void> {
  const inbox = await createTunResourceInbox(),
    releases: Array<() => void> = []
  let live = true
  const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises')
  try {
    await run({
      inbox,
      guard: () => {
        if (!live) throw new Error('private synthetic context')
      },
      lose: () => {
        live = false
      },
      hold<T>(value: T) {
        const gate = Promise.withResolvers<T>(),
          release = () => gate.resolve(value)
        releases.push(release)
        return { promise: gate.promise, release }
      },
      async watchFile(fn) {
        vi.mocked(files.open).mockImplementation(async (path, flags, mode) => {
          const handle = await actual.open(path, flags, mode)
          if (names.includes(basename(String(path)))) await fn(handle, String(path))
          return handle
        })
      }
    })
  } finally {
    for (const release of releases) release()
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
  vi.mocked(files.mkdir).mockReset().mockImplementation(actual.mkdir)
  vi.mocked(files.mkdtemp).mockReset().mockImplementation(actual.mkdtemp)
  vi.mocked(files.unlink).mockClear()
  vi.mocked(files.rm).mockClear()
  vi.mocked(files.rmdir).mockClear()
})
afterAll(async () => {
  if (process.env.RELAY_TUN_RESOURCE_INBOX_OUTPUT)
    await files.writeFile(
      process.env.RELAY_TUN_RESOURCE_INBOX_OUTPUT,
      JSON.stringify(
        {
          verifiedAt: new Date().toISOString(),
          scope:
            'Real ordinary-UID private tmp staging; Native ACK is explicitly simulated, no Native/client/Core/network. Every directory is retained for inspection; tests and producer never rm/unlink/rmdir.',
          reports
        },
        null,
        2
      ) + '\n',
      { mode: 0o600 }
    )
})
describe('Ordinary UID immutable Geo inbox producer without Node path deletion', () => {
  it('refuses root or mismatched effective UID before any temporary root creation', async () => {
    const count = vi.mocked(files.mkdtemp).mock.calls.length
    vi.spyOn(process, 'getuid').mockReturnValue(0)
    await expect(createTunResourceInbox()).rejects.toThrow('非root')
    expect(vi.mocked(files.mkdtemp).mock.calls.length).toBe(count)
  })
  it('creates only canonical UID-owned0700 directories and four exact fixed0600 filenames with full binary SHA', async () =>
    fixture(async (f) => {
      expect(f.inbox.directory).toMatch(
        new RegExp('^/private/tmp/relay-geo-main-' + process.getuid?.() + '-[A-Za-z0-9]+$')
      )
      expect((await files.stat(f.inbox.directory)).mode & 0o7777).toBe(0o700)
      for (const [index, kind] of geoResourceKinds.entries()) {
        const input = job(kind),
          ticket = await f.inbox.stage(input, new AbortController().signal, f.guard)
        expect(Object.keys(ticket).sort()).toEqual([
          'blobId',
          'bytes',
          'kind',
          'selector',
          'sha256'
        ])
        const child = join(f.inbox.directory, ticket.blobId),
          path = join(child, names[index])
        expect(await files.readdir(child)).toEqual([names[index]])
        expect((await files.stat(child)).mode & 0o7777).toBe(0o700)
        const file = await files.lstat(path, { bigint: true })
        expect(file.nlink).toBe(1n)
        expect(file.mode & 0o7777n).toBe(0o600n)
        expect(await files.readFile(path)).toEqual(input.bytes)
        expect(ticket.sha256).toBe(resourceHash(await files.readFile(path)))
      }
      expect(f.inbox.retained().retained).toHaveLength(4)
    }))
  it('rejects bad SHA, false/rule kinds, extra path fields and selector UTF8 overflow before allocating a child', async () =>
    fixture(async (f) => {
      const good = job()
      for (const bad of [
        { ...good, sha256: '0'.repeat(64) },
        { ...good, descriptor: { ...good.descriptor, kind: false } },
        {
          ...good,
          descriptor: { ...good.descriptor, kind: 'rule-text', behavior: 'domain', selector: '' }
        },
        { ...good, path: '/PRIVATE' },
        { ...good, descriptor: { ...good.descriptor, selector: '界'.repeat(86) } }
      ])
        await expect(invoke(f.inbox, bad)).rejects.toThrow()
      expect(await files.readdir(f.inbox.directory)).toEqual([])
      expect(f.inbox.retained().retained).toEqual([])
    }))
  it('copies and hashes input before its first await so later Buffer/descriptor mutation cannot alter staged data', async () =>
    fixture(async (f) => {
      const input = job(),
        original = Buffer.from(input.bytes),
        pending = f.inbox.stage(input, new AbortController().signal, f.guard)
      input.bytes.fill(0x5a)
      input.descriptor.selector = 'us'
      input.sha256 = '0'.repeat(64)
      const ticket = await pending
      expect(ticket.sha256).toBe(resourceHash(original))
      expect(ticket.selector).toBe('cn')
      expect(await files.readFile(join(f.inbox.directory, ticket.blobId, 'GeoIP.dat'))).toEqual(
        original
      )
    }))
  it('keeps singleflight and dispose busy until the actual held writer settles, retaining a partial diagnostic', async () =>
    fixture(async (f) => {
      const gate = f.hold(undefined),
        entered = Promise.withResolvers<void>(),
        opened: FileHandle[] = []
      await f.watchFile((handle) => {
        opened.push(handle)
        const write = handle.writeFile.bind(handle)
        vi.spyOn(handle, 'writeFile').mockImplementation(async (...args) => {
          await write(...args)
          entered.resolve()
          await gate.promise
        })
      })
      const pending = f.inbox.stage(job(), new AbortController().signal, f.guard),
        rejected = expect(pending).rejects.toThrow('未发布票据')
      await entered.promise
      await expect(f.inbox.stage(job(), new AbortController().signal, f.guard)).rejects.toThrow(
        '尚未结束'
      )
      expect(() => f.inbox.acknowledgeDiscard(f.inbox.retained().retained[0].ticket)).toThrow(
        '尚未结束'
      )
      let disposed = false
      const close = f.inbox.dispose().then((report) => {
        disposed = true
        return report
      })
      await Promise.resolve()
      expect(disposed).toBe(false)
      expect(f.inbox.isBusy()).toBe(true)
      gate.release()
      await rejected
      const report = await close
      expect(report.retained).toHaveLength(1)
      expect(report.retained[0].status).toBe('partial')
      expect(report.retained[0].writeAttempted).toBe(true)
      expect(report.retained[0].diagnostic).toContain('未确认')
      expect(report.handlesClosed).toBe(true)
      expect(opened.every((handle) => handle.fd === -1)).toBe(true)
      await expect(f.inbox.stage(job(), new AbortController().signal, f.guard)).rejects.toThrow(
        '关闭'
      )
    }))
  it('rejects reentrant dispose or an already-aborted signal before creating a UUID entry', async () =>
    fixture(async (f) => {
      const abort = new AbortController()
      abort.abort()
      await expect(f.inbox.stage(job(), abort.signal, f.guard)).rejects.toThrow()
      await expect(
        f.inbox.stage(job(), new AbortController().signal, () => {
          void f.inbox.dispose()
        })
      ).rejects.toThrow()
      expect(await files.readdir(f.inbox.directory)).toEqual([])
      expect(f.inbox.retained().retained).toEqual([])
    }))
  it.each(['context', 'signal'] as const)(
    'drops %s lost after awaited fsync without returning a ticket or reading more data',
    async (loss) =>
      fixture(async (f) => {
        const gate = f.hold(undefined),
          entered = Promise.withResolvers<void>(),
          reads: ReturnType<typeof vi.spyOn>[] = []
        await f.watchFile((handle) => {
          const sync = handle.sync.bind(handle)
          reads.push(vi.spyOn(handle, 'read'))
          vi.spyOn(handle, 'sync').mockImplementationOnce(async () => {
            await sync()
            entered.resolve()
            await gate.promise
          })
        })
        const abort = new AbortController(),
          pending = f.inbox.stage(job(), abort.signal, f.guard),
          rejected = expect(pending).rejects.toThrow()
        await entered.promise
        if (loss === 'context') f.lose()
        else abort.abort()
        gate.release()
        await rejected
        expect(reads.every((read) => read.mock.calls.length === 0)).toBe(true)
        expect(f.inbox.retained().retained[0].status).toBe('partial')
        expect(f.inbox.retained().retained[0].writeAttempted).toBe(true)
      })
  )
  it('owns and closes an acquired FD even when context is lost before open returns to its caller', async () =>
    fixture(async (f) => {
      const opened: FileHandle[] = []
      await f.watchFile((handle) => {
        opened.push(handle)
        f.lose()
      })
      await expect(f.inbox.stage(job(), new AbortController().signal, f.guard)).rejects.toThrow()
      expect(opened).toHaveLength(1)
      expect(opened[0].fd).toBe(-1)
      expect(f.inbox.retained().retained[0].status).toBe('partial')
    }))
  it('preserves a foreign replacement root and retained old root instead of following or deleting either', async () =>
    fixture(async (f) => {
      const original = f.inbox.directory + '-retained'
      await files.rename(f.inbox.directory, original)
      await files.mkdir(f.inbox.directory, { mode: 0o700 })
      const foreign = join(f.inbox.directory, 'foreign.txt')
      await files.writeFile(foreign, 'foreign')
      await expect(f.inbox.stage(job(), new AbortController().signal, f.guard)).rejects.toThrow()
      expect(await files.readFile(foreign, 'utf8')).toBe('foreign')
      expect(await files.readdir(original)).toEqual([])
      expect(await files.readdir(f.inbox.directory)).toEqual(['foreign.txt'])
    }))
  it('refuses a symlinked UUID child without creating a file in its foreign target', async () =>
    fixture(async (f) => {
      const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises'),
        foreign = await files.mkdtemp('/private/tmp/relay-geo-inbox-foreign-')
      vi.mocked(files.mkdir).mockImplementation(async (path, options) => {
        if (String(path).startsWith(f.inbox.directory + '/')) {
          await files.symlink(foreign, String(path))
          return undefined
        }
        return actual.mkdir(path, options)
      })
      await expect(f.inbox.stage(job(), new AbortController().signal, f.guard)).rejects.toThrow()
      expect(await files.readdir(foreign)).toEqual([])
      const child = f.inbox.retained().retained[0].ticket.blobId
      expect((await files.lstat(join(f.inbox.directory, child))).isSymbolicLink()).toBe(true)
    }))
  it('refuses a symlink at the exclusive data filename and never overwrites its target', async () =>
    fixture(async (f) => {
      const actual = await vi.importActual<typeof import('fs/promises')>('fs/promises'),
        foreignRoot = await files.mkdtemp('/private/tmp/relay-geo-inbox-foreign-'),
        foreign = join(foreignRoot, 'data')
      await files.writeFile(foreign, 'foreign', { mode: 0o600 })
      vi.mocked(files.open).mockImplementation(async (path, flags, mode) => {
        if (names.includes(basename(String(path)))) await files.symlink(foreign, String(path))
        return actual.open(path, flags, mode)
      })
      await expect(f.inbox.stage(job(), new AbortController().signal, f.guard)).rejects.toThrow()
      expect(await files.readFile(foreign, 'utf8')).toBe('foreign')
      const entry = f.inbox.retained().retained[0]
      expect(
        (
          await files.lstat(join(f.inbox.directory, entry.ticket.blobId, 'GeoIP.dat'))
        ).isSymbolicLink()
      ).toBe(true)
    }))
  it.each(['mode', 'hardlink'] as const)(
    'refuses changed file %s without repair or removal',
    async (kind) =>
      fixture(async (f) => {
        await f.watchFile((handle, path) => {
          if (kind === 'mode') return files.chmod(path, 0o644)
          const write = handle.writeFile.bind(handle)
          vi.spyOn(handle, 'writeFile').mockImplementationOnce(async (...args) => {
            await write(...args)
            await files.link(path, path + '.link')
          })
          return undefined
        })
        await expect(f.inbox.stage(job(), new AbortController().signal, f.guard)).rejects.toThrow()
        const entry = f.inbox.retained().retained[0],
          path = join(f.inbox.directory, entry.ticket.blobId, 'GeoIP.dat'),
          stat = await files.lstat(path, { bigint: true })
        expect(kind === 'mode' ? stat.mode & 0o7777n : stat.nlink).toBe(
          kind === 'mode' ? 0o644n : 2n
        )
      })
  )
  it('rechecks BigInt full file identity after close and catches mutation with restored mtime', async () =>
    fixture(async (f) => {
      await f.watchFile((handle, path) => {
        const close = handle.close.bind(handle)
        vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
          const before = await files.stat(path)
          await close()
          await files.writeFile(path, Buffer.from('evil'))
          await files.utimes(path, before.atime, before.mtime)
        })
      })
      await expect(
        f.inbox.stage(job('geoip-dat', Buffer.from('GOOD')), new AbortController().signal, f.guard)
      ).rejects.toThrow()
      const entry = f.inbox.retained().retained[0]
      expect(
        await files.readFile(join(f.inbox.directory, entry.ticket.blobId, 'GeoIP.dat'), 'utf8')
      ).toBe('evil')
      expect(entry.status).toBe('partial')
    }))
  it('matches every ACK field before releasing memory, with no Node deletion and retained files on dispose', async () =>
    fixture(async (f) => {
      const tickets: TunResourceBlobTicket[] = []
      for (let n = 0; n < 4; n++)
        tickets.push(await f.inbox.stage(job(), new AbortController().signal, f.guard))
      await expect(f.inbox.stage(job(), new AbortController().signal, f.guard)).rejects.toThrow()
      const first = tickets[0]
      for (const wrong of [
        { ...first, blobId: randomUUID() },
        { ...first, sha256: '0'.repeat(64) },
        { ...first, bytes: first.bytes + 1 },
        { ...first, kind: 'asn-mmdb' as const },
        { ...first, selector: 'us' }
      ])
        expect(() => f.inbox.acknowledgeDiscard(wrong)).toThrow('ACK')
      expect(f.inbox.retained().retained).toHaveLength(4)
      // This is a simulated authenticated Native ACK. The producer deliberately
      // does not inspect/delete its file; real Native consume/discard is separate.
      f.inbox.acknowledgeDiscard(first)
      f.inbox.acknowledgeDiscard(first)
      expect(f.inbox.retained().retained).toHaveLength(3)
      const report = await f.inbox.dispose()
      expect(report.retained).toHaveLength(3)
      expect((await files.readdir(f.inbox.directory)).length).toBe(4)
      expect(await files.readFile(join(f.inbox.directory, first.blobId, 'GeoIP.dat'))).toEqual(
        job().bytes
      )
    }))
  it(
    'enforces the256MiB reservation cap independently of the four-ticket count',
    async () =>
      fixture(async (f) => {
        const bytes = Buffer.alloc(RESOURCE_BYTE_LIMIT, 0x2a),
          input = job('geoip-dat', bytes)
        await f.inbox.stage(input, new AbortController().signal, f.guard)
        await f.inbox.stage(input, new AbortController().signal, f.guard)
        expect(f.inbox.retained().reservedBytes).toBe(TUN_RESOURCE_INBOX_MAX_BYTES)
        await expect(
          f.inbox.stage(job('geoip-dat', Buffer.from('x')), new AbortController().signal, f.guard)
        ).rejects.toThrow()
        expect(f.inbox.retained().retained).toHaveLength(2)
      }),
    20000
  )
})
