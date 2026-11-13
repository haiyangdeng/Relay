import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import AdmZip from 'adm-zip'
import { describe, expect, it, vi } from 'vitest'
import { remoteBackupRequest } from '../../../shared/relay/backup-remote'
import { encryptAgeContent, generateAgeKeyPair } from '../../utils/age'
import { backupFileNative } from '../native'
import { ProfileStore } from '../profiles/store'
import { BACKUP_ARCHIVE_MAX_BYTES, backupHash, backupSnapshotSHA256 } from './archive'
import * as legacy from './legacy-clash'
import { prepareLegacyMigrationRecord } from './legacy-record'
import { createBackupService } from './service'
import { createRemoteBackupService } from './remote-service'
import { createRemoteBackupTransport, encodeRemoteArchive } from './remote'
import { recoveryFixtureAdapters } from './recovery.test-fixture'
import { RelayBackupStore } from './store'

const configuration = 'proxies: []\nproxy-groups: []\nrules: [MATCH,REJECT]\n',
  rawRequest = {
    provider: 'webdav',
    action: 'download',
    archiveFormat: 'legacy-zip',
    url: 'https://dav.example/old.zip',
    username: '用户',
    password: 'PRIVATE-密码',
    proxyPort: 17891
  }
function zip(content: string | null = configuration, key?: string): Buffer {
  const archive = new AdmZip()
  archive.addFile('config.yaml', Buffer.from('{}'))
  archive.addFile('mihomo.yaml', Buffer.from('{}'))
  archive.addFile(
    'profile.yaml',
    Buffer.from(
      JSON.stringify({
        items: [
          { id: 'cached', type: 'local', name: 'Old cached', ...(key ? { ageSecretKey: key } : {}) }
        ]
      })
    )
  )
  if (content !== null) archive.addFile('profiles/cached.yaml', Buffer.from(content))
  return archive.toBuffer()
}
const response = (bytes: Buffer, status = 200) => ({ status, bytes, body: '', headers: {} })

async function fixture(
  bytes: Buffer,
  run: (f: {
    context: { home: string; stateRoot: string }
    store: RelayBackupStore
    local: ReturnType<typeof createBackupService>
    remote: ReturnType<typeof createRemoteBackupService>
    localAdapters: Parameters<typeof createBackupService>[0]
    remoteAdapters: Parameters<typeof createRemoteBackupService>[0]
    requests: { method: string; maxBytes: number | undefined; live: boolean }[]
    authority: { account: boolean; owner: boolean; time: number }
  }) => Promise<void>
): Promise<void> {
  const home = await realpath(await mkdtemp('/private/tmp/relay-remote-legacy-')),
    context = { home, stateRoot: join(home, 'Library/Application Support/Relay') },
    conversions = new Set<string>(),
    convert = legacy.convertLegacyClashArchive,
    spy = vi.spyOn(legacy, 'convertLegacyClashArchive').mockImplementation(async (input) => {
      conversions.add(input.temporaryHome)
      return convert(input)
    })
  await mkdir(context.stateRoot, { recursive: true, mode: 0o700 })
  await writeFile(join(context.stateRoot, 'preferences.json'), 'UNCHANGED', { mode: 0o600 })
  const store = new RelayBackupStore(context, recoveryFixtureAdapters(context)),
    authority = { account: true, owner: true, time: 1000 },
    requests: { method: string; maxBytes: number | undefined; live: boolean }[] = []
  let delegated = false
  const localAdapters: Parameters<typeof createBackupService>[0] = {
      store,
      pickImport: vi.fn(async () => undefined),
      writeExport: async () => false,
      confirmExport: async () => false,
      confirmRestore: vi.fn(async () => false),
      assertIdle: () => {
        if (remote?.isBusy() && !delegated) throw new Error('Remote operation not delegated')
      },
      prepareLegacyArchive: (original, baseline, proxyPort, signal) =>
        prepareLegacyMigrationRecord(context, original, baseline, proxyPort, signal, (request) =>
          backupFileNative(
            process.env.RELAY_BACKUP_MOVE_EXECUTABLE ?? resolve('extra/relay/RelayNative'),
            context,
            request
          )
        )
    },
    local = createBackupService(localAdapters),
    remoteAdapters: Parameters<typeof createRemoteBackupService>[0] = {
      store,
      now: () => authority.time,
      confirmTransfer: vi.fn(async () => true),
      assertIdle: () => {
        if (local.isBusy() && !delegated)
          throw new Error('Local restore must not call remote idle guard')
      },
      prepareArchive: vi.fn((original, signal) => local.prepareArchive(original, signal)),
      prepareLegacyArchive: vi.fn(async (original, proxyPort, signal, guard) => {
        delegated = true
        try {
          return await local.prepareLegacyArchive(original, proxyPort, signal, guard)
        } finally {
          delegated = false
        }
      }),
      transport: createRemoteBackupTransport(async (_url, options) => {
        requests.push({
          method: options.method ?? 'GET',
          maxBytes: options.maxBytes,
          live: authority.owner
        })
        expect(options.proxy).toEqual({ host: '127.0.0.1', port: 17891 })
        expect(options.headers?.Authorization).toBe(
          'Basic ' + Buffer.from('用户:PRIVATE-密码').toString('base64')
        )
        return response(bytes)
      })
    }
  const remote = createRemoteBackupService(remoteAdapters)
  try {
    await run({ context, store, local, remote, localAdapters, remoteAdapters, requests, authority })
  } finally {
    remote.cancel()
    await remote.whenIdle()
    await local.whenIdle()
    local.cancel()
    spy.mockRestore()
    for (const directory of conversions) await rm(directory, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
}
const inspectAccount =
  (authority: { account: boolean; time: number }) =>
  async (phase?: 'transfer' | 'restore'): Promise<void> => {
    if (!authority.account || (phase !== 'restore' && authority.time >= 61000))
      throw new Error('PRIVATE-account-or-transfer-TTL')
  }
const inspectOwner = (authority: { owner: boolean }) => (): void => {
  if (!authority.owner) throw new Error('PRIVATE-owner-lost')
}

describe('Explicit WebDAV raw ZIP handoff without envelope fallback', () => {
  it('accepts only primitive WebDAV download format and rejects all raw AGE or other-action combinations', () => {
    expect(remoteBackupRequest(rawRequest).archiveFormat).toBe('legacy-zip')
    for (const invalid of [
      { ...rawRequest, archiveFormat: new String('legacy-zip') },
      { ...rawRequest, archiveFormat: 'other' },
      { ...rawRequest, secretKey: '' },
      { ...rawRequest, secretKey: undefined },
      { ...rawRequest, recipient: '' },
      ...['upload', 'list', 'delete'].map((action) => ({ ...rawRequest, action })),
      { ...rawRequest, provider: 'gist', token: 'PRIVATE-token', gistId: 'a'.repeat(32) }
    ])
      expect(() => remoteBackupRequest(invalid)).toThrow()
    expect(
      remoteBackupRequest({ ...rawRequest, archiveFormat: 'relay-envelope' }).archiveFormat
    ).toBe('relay-envelope')
  })

  it('uses bounded raw GET and the real Native original/conversion/restore path after separate confirmation', async () => {
    const original = zip()
    await fixture(original, async (f) => {
      const before = backupSnapshotSHA256(await f.store.snapshot()),
        plan = await f.remote.prepare(
          rawRequest,
          inspectAccount(f.authority),
          inspectOwner(f.authority)
        )
      expect(plan).toMatchObject({ archiveFormat: 'legacy-zip', encrypted: false })
      expect(JSON.stringify(plan)).not.toContain('PRIVATE')
      expect(f.requests).toEqual([])
      const result = await f.remote.execute({ evidenceId: plan.evidenceId })
      expect(result.status).toBe('prepared')
      expect(result.report?.format).toBe('clash-party-legacy-zip')
      expect(result.report?.archiveSHA256).toBe(backupHash(original))
      expect(f.requests).toEqual([
        { method: 'GET', maxBytes: BACKUP_ARCHIVE_MAX_BYTES, live: true }
      ])
      expect(f.localAdapters.pickImport).not.toHaveBeenCalled()
      expect(f.remoteAdapters.prepareArchive).not.toHaveBeenCalled()
      expect(backupSnapshotSHA256(await f.store.snapshot())).toBe(before)
      expect(
        await readFile(
          join(f.context.stateRoot, 'Migrations', result.migrationId ?? '', 'original.zip')
        )
      ).toEqual(original)
      f.localAdapters.confirmRestore = async () => true
      expect(await f.local.restore({ id: result.plan?.id })).toEqual({ status: 'restored' })
      expect((await new ProfileStore(f.context).list()).profiles).toHaveLength(1)
      expect(await readFile(join(f.context.stateRoot, 'preferences.json'), 'utf8')).toBe(
        'UNCHANGED'
      )
    })
  }, 20000)

  it('does not reinterpret raw ZIP as a modern envelope or silently call Legacy after decoding failure', async () => {
    await fixture(zip(), async (f) => {
      const { archiveFormat: _format, ...modern } = rawRequest,
        plan = await f.remote.prepare(modern)
      expect(plan.archiveFormat).toBe('relay-envelope')
      await expect(f.remote.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('格式')
      expect(f.remoteAdapters.prepareLegacyArchive).not.toHaveBeenCalled()
      expect(f.remoteAdapters.prepareArchive).not.toHaveBeenCalled()
      await expect(readdir(join(f.context.stateRoot, 'Migrations'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    })
  })

  it('keeps a wrongly selected envelope exact as an original and never falls back from explicit Legacy parsing', async () => {
    const envelope = await encodeRemoteArchive(zip())
    await fixture(envelope, async (f) => {
      const before = backupSnapshotSHA256(await f.store.snapshot()),
        plan = await f.remote.prepare(rawRequest)
      await expect(f.remote.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('迁移')
      const [id] = await readdir(join(f.context.stateRoot, 'Migrations'))
      expect(await readFile(join(f.context.stateRoot, 'Migrations', id, 'original.zip'))).toEqual(
        envelope
      )
      expect(f.remoteAdapters.prepareArchive).not.toHaveBeenCalled()
      expect(backupSnapshotSHA256(await f.store.snapshot())).toBe(before)
    })
  })

  it('returns inspected plus the retained-original report when no old cache can become a candidate', async () => {
    await fixture(zip(null), async (f) => {
      const before = backupSnapshotSHA256(await f.store.snapshot()),
        plan = await f.remote.prepare(rawRequest),
        result = await f.remote.execute({ evidenceId: plan.evidenceId })
      expect(result.status).toBe('inspected')
      expect(result.plan).toBeUndefined()
      expect(result.report?.counts.profiles).toBe(0)
      expect(result.report?.counts['decision-required']).toBeGreaterThan(0)
      expect(result.migrationId).toMatch(/^[a-f0-9-]{36}$/u)
      expect(backupSnapshotSHA256(await f.store.snapshot())).toBe(before)
    })
  })

  it('uses the old per-cache AGE identity from the ZIP without accepting an outer raw-download AGE key', async () => {
    const pair = await generateAgeKeyPair(),
      original = zip(
        await encryptAgeContent(configuration, pair.recipient, 'legacy fixture'),
        pair.secretKey
      )
    await fixture(original, async (f) => {
      const plan = await f.remote.prepare(rawRequest),
        result = await f.remote.execute({ evidenceId: plan.evidenceId })
      expect(result.report?.counts.profiles).toBe(1)
      expect(JSON.stringify(result.report)).not.toContain(pair.secretKey)
      f.localAdapters.confirmRestore = async () => true
      expect((await f.local.restore({ id: result.plan?.id })).status).toBe('restored')
      const [profile] = (await new ProfileStore(f.context).list()).profiles
      expect(
        (await new ProfileStore(f.context).read({ id: profile.id, sha256: profile.sha256 })).text
      ).toBe(configuration)
    })
  }, 20000)

  it('switches only completed handoff account checks to restore phase and keeps the local plan valid after transfer expiry', async () => {
    await fixture(zip(), async (f) => {
      const check = vi.fn(inspectAccount(f.authority)),
        plan = await f.remote.prepare(rawRequest, check, inspectOwner(f.authority)),
        result = await f.remote.execute({ evidenceId: plan.evidenceId })
      expect(check.mock.calls.some(([phase]) => phase === 'restore')).toBe(false)
      f.authority.time = 62000
      f.localAdapters.confirmRestore = async () => true
      expect((await f.local.restore({ id: result.plan?.id })).status).toBe('restored')
      expect(check.mock.calls.some(([phase]) => phase === 'restore')).toBe(true)
      expect(f.requests).toHaveLength(1)
    })
  }, 20000)

  it.each(['account', 'owner', 'generation'] as const)(
    'revokes a handed-off local proof on %s change without another GET or a Native restore',
    async (kind) => {
      await fixture(zip(), async (f) => {
        const plan = await f.remote.prepare(
            rawRequest,
            inspectAccount(f.authority),
            inspectOwner(f.authority)
          ),
          result = await f.remote.execute({ evidenceId: plan.evidenceId }),
          commit = vi.spyOn(f.store, 'commitRestore')
        if (kind === 'generation') f.remote.cancel()
        else f.authority[kind] = false
        expect(await f.local.restore({ id: result.plan?.id })).toEqual({ status: 'cancelled' })
        expect(f.localAdapters.confirmRestore).not.toHaveBeenCalled()
        expect(commit).not.toHaveBeenCalled()
        expect(f.requests).toHaveLength(1)
      })
    },
    20000
  )

  it('does not send raw credentials across the async pre-send microtask liveness gap', async () => {
    let live = true
    const request = vi.fn(async () => response(zip())),
      transport = createRemoteBackupTransport(request),
      check = (): void => {
        if (!live) throw new Error('Owner lost')
      }
    await expect(
      transport.download(
        remoteBackupRequest(rawRequest),
        new AbortController().signal,
        async () => {
          queueMicrotask(() => {
            live = false
          })
        },
        { assertLive: check }
      )
    ).rejects.toThrow('Owner lost')
    expect(request).not.toHaveBeenCalled()
  })

  it('keeps the local file picker on the same Legacy preparation core without any remote GET', async () => {
    const original = zip()
    await fixture(original, async (f) => {
      f.localAdapters.pickImport = vi.fn(async () => original)
      const result = await f.local.prepareLegacyImport({ proxyPort: 17891 })
      expect(result.status).toBe('prepared')
      expect(f.localAdapters.pickImport).toHaveBeenCalledWith('legacy')
      expect(result.report?.archiveSHA256).toBe(backupHash(original))
      expect(f.requests).toEqual([])
    })
  })

  it.each(['parent-abort', 'owner-loss'] as const)(
    'discards an actually staged late handoff on %s while preserving its private original',
    async (kind) => {
      await fixture(zip(), async (f) => {
        const before = backupSnapshotSHA256(await f.store.snapshot()),
          prepare = f.remoteAdapters.prepareLegacyArchive,
          plan = await f.remote.prepare(
            rawRequest,
            inspectAccount(f.authority),
            inspectOwner(f.authority)
          )
        if (!prepare) throw new Error('Missing Legacy callback')
        let restoreId = ''
        f.remoteAdapters.prepareLegacyArchive = async (...args) => {
          const result = await prepare(...args)
          restoreId = result.plan?.id ?? ''
          if (kind === 'parent-abort') f.remote.cancel()
          else f.authority.owner = false
          return result
        }
        if (kind === 'parent-abort')
          expect(await f.remote.execute({ evidenceId: plan.evidenceId })).toEqual({
            status: 'cancelled'
          })
        else await expect(f.remote.execute({ evidenceId: plan.evidenceId })).rejects.toThrow()
        expect(restoreId).not.toBe('')
        await expect(f.local.restore({ id: restoreId })).rejects.toThrow('失效')
        expect(backupSnapshotSHA256(await f.store.snapshot())).toBe(before)
        const [id] = await readdir(join(f.context.stateRoot, 'Migrations'))
        expect(
          await readFile(join(f.context.stateRoot, 'Migrations', id, 'original.zip'))
        ).toBeInstanceOf(Buffer)
        expect(f.requests).toHaveLength(1)
      })
    },
    20000
  )

  it('waits for the real Native recordPlan before discarding a parent-aborted unpublished stage', async () => {
    const original = zip()
    await fixture(original, async (f) => {
      const before = backupSnapshotSHA256(await f.store.snapshot()),
        prepare = f.localAdapters.prepareLegacyArchive,
        discard = vi.spyOn(f.store, 'discard'),
        commit = vi.spyOn(f.store, 'commitRestore'),
        entered = Promise.withResolvers<void>(),
        gate = Promise.withResolvers<void>()
      if (!prepare) throw new Error('Missing Legacy converter')
      let restoreId = ''
      f.localAdapters.prepareLegacyArchive = async (...args) => {
        const result = await prepare(...args)
        return {
          ...result,
          recordPlan: async (plan) => {
            restoreId = plan.id
            await result.recordPlan(plan)
            entered.resolve()
            await gate.promise
          }
        }
      }
      const plan = await f.remote.prepare(
          rawRequest,
          inspectAccount(f.authority),
          inspectOwner(f.authority)
        ),
        pending = f.remote.execute({ evidenceId: plan.evidenceId })
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error('Execution ended before recordPlan gate')
          })
        ])
        f.remote.cancel()
        expect(f.remote.isBusy()).toBe(true)
        expect(f.local.isBusy()).toBe(true)
        let idle = false
        void Promise.all([f.remote.whenIdle(), f.local.whenIdle()]).then(() => {
          idle = true
        })
        await Promise.resolve()
        expect(idle).toBe(false)
      } finally {
        gate.resolve()
      }
      expect(await pending).toEqual({ status: 'cancelled' })
      await Promise.all([f.remote.whenIdle(), f.local.whenIdle()])
      expect(discard).toHaveBeenCalledWith(restoreId)
      await expect(f.local.restore({ id: restoreId })).rejects.toThrow('失效')
      expect(commit).not.toHaveBeenCalled()
      expect(backupSnapshotSHA256(await f.store.snapshot())).toBe(before)
      const [id] = await readdir(join(f.context.stateRoot, 'Migrations'))
      expect(await readFile(join(f.context.stateRoot, 'Migrations', id, 'original.zip'))).toEqual(
        original
      )
      expect(f.requests).toHaveLength(1)
    })
  }, 20000)
})
