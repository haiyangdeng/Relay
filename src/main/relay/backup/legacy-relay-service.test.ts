import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'fs/promises'
import { join, resolve } from 'path'
import { describe, expect, it, vi } from 'vitest'
import {
  legacyRelayInspectRequest,
  legacyRelayPrepareRequest,
  type LegacyRelayInspection
} from '../../../shared/relay/legacy-relay'
import { backupFileNative } from '../native'
import { ProfileStore } from '../profiles/store'
import { backupHash, backupSnapshotSHA256 } from './archive'
import { createLegacyRelayMigration } from './legacy-relay'
import { prepareLegacyRelayMigrationRecord } from './legacy-record'
import { recoveryFixtureAdapters } from './recovery.test-fixture'
import { createBackupService } from './service'
import { RelayBackupStore } from './store'

const configuration = 'proxies: []\nproxy-groups: []\nrules: [MATCH,REJECT]\n'
type Adapters = Parameters<typeof createBackupService>[0]
async function fixture(
  run: (f: {
    context: { home: string; stateRoot: string }
    sourceDirectory: string
    adapters: Adapters
    store: RelayBackupStore
    service: ReturnType<typeof createBackupService>
    migrator: ReturnType<typeof createLegacyRelayMigration>
    publish: Parameters<typeof prepareLegacyRelayMigrationRecord>[3]
    conversions: Set<string>
  }) => Promise<void>
): Promise<void> {
  const home = await realpath(await mkdtemp('/private/tmp/relay-legacy-service-')),
    context = { home, stateRoot: join(home, 'Library/Application Support/Relay') },
    sourceContext = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') },
    sourceStore = new ProfileStore(sourceContext),
    original = await sourceStore.save('Legacy source', configuration),
    sourceDirectory = join(sourceContext.stateRoot, 'Profiles', original.id),
    conversions = new Set<string>()
  await mkdir(join(sourceContext.stateRoot, 'Profiles'), { mode: 0o700 })
  await rename(join(sourceStore.directory, original.id), sourceDirectory)
  await mkdir(context.stateRoot, { recursive: true, mode: 0o700 })
  await writeFile(join(context.stateRoot, 'preferences.json'), 'UNCHANGED', { mode: 0o600 })
  const store = new RelayBackupStore(context, recoveryFixtureAdapters(context)),
    migrator = createLegacyRelayMigration({ home }),
    publish: Parameters<typeof prepareLegacyRelayMigrationRecord>[3] = (request) =>
      backupFileNative(
        process.env.RELAY_BACKUP_MOVE_EXECUTABLE ?? resolve('extra/relay/RelayNative'),
        context,
        request
      ),
    adapters: Adapters = {
      store,
      pickImport: vi.fn(async () => undefined),
      writeExport: vi.fn(async () => false),
      confirmExport: vi.fn(async () => false),
      confirmRestore: vi.fn(async () => false),
      assertIdle: vi.fn(),
      confirmLegacyRelayInspect: vi.fn(async () => false),
      inspectLegacyRelay: vi.fn((request, signal) => migrator.inspect(request, signal)),
      cancelLegacyRelayInspection: vi.fn(() => migrator.cancel()),
      prepareLegacyRelayArchive: vi.fn((request, baseline, signal) =>
        prepareLegacyRelayMigrationRecord(context, baseline, signal, publish, (temporaryHome) => {
          conversions.add(temporaryHome)
          return migrator.prepare(request, { baseline, temporaryHome, signal })
        })
      )
    },
    service = createBackupService(adapters)
  try {
    await run({
      context,
      sourceDirectory,
      adapters,
      store,
      service,
      migrator,
      publish,
      conversions
    })
  } finally {
    await service.whenIdle()
    for (const directory of conversions) await rm(directory, { recursive: true, force: true })
    await rm(home, { recursive: true, force: true })
  }
}
function request(inspection: LegacyRelayInspection) {
  return {
    inspectionId: inspection.inspectionId,
    profiles: inspection.profiles.map(({ id, sha256, revision }) => ({ id, sha256, revision }))
  }
}
async function inspect(
  f: {
    adapters: Adapters
    service: ReturnType<typeof createBackupService>
  },
  recheck?: () => void
): Promise<LegacyRelayInspection> {
  f.adapters.confirmLegacyRelayInspect = vi.fn(async () => true)
  const result = await f.service.inspectLegacyRelay({ origin: 'Relay-Preview' }, recheck)
  if (!result.inspection) throw new Error('Missing source inspection')
  return result.inspection
}

describe('Legacy Relay public contract and shared backup-service barrier', () => {
  it('uses primitive fixed origin/selection fields and rejects path, boxed or duplicate selections', () => {
    expect(legacyRelayInspectRequest({ origin: 'Relay' })).toEqual({ origin: 'Relay' })
    for (const raw of [
      { origin: new String('Relay') },
      { origin: ['Relay'] },
      { origin: 'Relay', path: '/PRIVATE' }
    ])
      expect(() => legacyRelayInspectRequest(raw)).toThrow()
    const profile = {
        id: '00000000-0000-0000-0000-000000000001',
        sha256: 'a'.repeat(64),
        revision: 'b'.repeat(64)
      },
      base = { inspectionId: '00000000-0000-0000-0000-000000000002', profiles: [profile] }
    expect(legacyRelayPrepareRequest(base)).toEqual(base)
    for (const raw of [
      { ...base, origin: 'Relay' },
      { ...base, profiles: [profile, profile] },
      { ...base, profiles: [{ ...profile, path: '/PRIVATE' }] },
      { ...base, profiles: [{ ...profile, id: new String(profile.id) }] }
    ])
      expect(() => legacyRelayPrepareRequest(raw)).toThrow()
  })

  it('reads no source before explicit Native consent and rejects renderer paths without a dialog', async () => {
    await fixture(async (f) => {
      expect(await f.service.inspectLegacyRelay({ origin: 'Relay-Preview' })).toEqual({
        status: 'cancelled'
      })
      expect(f.adapters.confirmLegacyRelayInspect).toHaveBeenCalledWith('Relay-Preview')
      expect(f.adapters.inspectLegacyRelay).not.toHaveBeenCalled()
      await expect(
        f.service.inspectLegacyRelay({ origin: 'Relay', path: '/PRIVATE' })
      ).rejects.toThrow('路径')
      expect(f.adapters.confirmLegacyRelayInspect).toHaveBeenCalledTimes(1)
      await expect(readdir(join(f.context.stateRoot, 'Migrations'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
    })
  })

  it('uses a separate read-only inspection gate while keeping candidate preparation behind the original write gate', async () => {
    await fixture(async (f) => {
      f.adapters.assertIdle = vi.fn(() => {
        throw new Error('Active runtime blocks backup writes')
      })
      f.adapters.assertLegacyRelayInspectionIdle = vi.fn()
      const inspected = await inspect(f),
        snapshot = vi.spyOn(f.store, 'snapshot')
      expect(inspected.profiles).toHaveLength(1)
      expect(f.adapters.assertLegacyRelayInspectionIdle).toHaveBeenCalled()
      expect(f.adapters.assertIdle).not.toHaveBeenCalled()
      await expect(f.service.prepareLegacyRelayImport(request(inspected))).rejects.toThrow(
        'blocks backup writes'
      )
      expect(f.adapters.assertIdle).toHaveBeenCalled()
      expect(snapshot).not.toHaveBeenCalled()
      expect(f.adapters.prepareLegacyRelayArchive).not.toHaveBeenCalled()
    })
  })

  it('publishes exact original/report/plan with actual Native, then confirms a distinct Relay report and restores the additive candidate', async () => {
    await fixture(async (f) => {
      const baseline = await f.store.snapshot(),
        metadata = await readFile(join(f.sourceDirectory, 'metadata.json')),
        inspected = await inspect(f),
        prepared = await f.service.prepareLegacyRelayImport(request(inspected))
      expect(prepared.status).toBe('prepared')
      if (!prepared.plan || !prepared.report || !prepared.migrationId)
        throw new Error('Missing prepared record')
      const directory = join(f.context.stateRoot, 'Migrations', prepared.migrationId),
        original = await readFile(join(directory, 'original.zip')),
        receipt = JSON.parse(await readFile(join(directory, 'migration.json'), 'utf8'))
      expect((await readdir(directory)).sort()).toEqual([
        'migration.json',
        'original.zip',
        'report.json',
        'restore-plan.json'
      ])
      expect(prepared.report.format).toBe('relay-legacy-profiles-v1')
      expect(prepared.report.originalArchiveSHA256).toBe(backupHash(original))
      expect(receipt.sourceSHA256).toBe(prepared.report.originalArchiveSHA256)
      expect(JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'))).toEqual(
        prepared.report
      )
      expect(
        JSON.parse(await readFile(join(directory, 'restore-plan.json'), 'utf8')).restoreId
      ).toBe(prepared.plan.id)
      expect(backupSnapshotSHA256(await f.store.snapshot())).toBe(backupSnapshotSHA256(baseline))
      f.adapters.confirmRestore = vi.fn(async () => true)
      const refreshed = vi.fn(async () => {})
      f.adapters.afterRestore = refreshed
      expect(await f.service.restore({ id: prepared.plan.id })).toEqual({ status: 'restored' })
      expect(f.adapters.confirmRestore).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          format: 'relay-legacy-profiles-v1',
          origin: 'Relay-Preview',
          originalArchiveSHA256: backupHash(original)
        })
      )
      expect(refreshed).toHaveBeenCalledTimes(1)
      expect(await readFile(join(f.context.stateRoot, 'preferences.json'), 'utf8')).toBe(
        'UNCHANGED'
      )
      expect(await readFile(join(f.sourceDirectory, 'metadata.json'))).toEqual(metadata)
      expect(await readFile(join(f.sourceDirectory, 'profile.yaml'), 'utf8')).toBe(configuration)
      expect(await readFile(join(directory, 'original.zip'))).toEqual(original)
    })
  }, 20000)

  it('keeps default-cancel restore at zero commit and consumes the prepared proof', async () => {
    await fixture(async (f) => {
      const commit = vi.spyOn(f.store, 'commitRestore'),
        before = backupSnapshotSHA256(await f.store.snapshot()),
        inspected = await inspect(f),
        prepared = await f.service.prepareLegacyRelayImport(request(inspected))
      expect(await f.service.restore({ id: prepared.plan?.id })).toEqual({ status: 'cancelled' })
      expect(commit).not.toHaveBeenCalled()
      expect(backupSnapshotSHA256(await f.store.snapshot())).toBe(before)
      await expect(f.service.restore({ id: prepared.plan?.id })).rejects.toThrow('失效')
    })
  })

  it.each(['before-native', 'after-native-microtask'] as const)(
    'keeps the prepared Relay proof bound to its private owner at %s without dispatching a transaction',
    async (phase) => {
      await fixture(async (f) => {
        let ownerLive = true
        const recheck = (): void => {
            if (!ownerLive) throw new Error('Owner lost without lifecycle event')
          },
          inspected = await inspect(f, recheck),
          before = backupSnapshotSHA256(await f.store.snapshot()),
          prepared = await f.service.prepareLegacyRelayImport(request(inspected)),
          commit = vi.spyOn(f.store, 'commitRestore')
        f.adapters.confirmRestore = vi.fn(async () => {
          expect(ownerLive).toBe(true)
          queueMicrotask(() => {
            ownerLive = false
          })
          return true
        })
        if (phase === 'before-native') ownerLive = false
        expect(await f.service.restore({ id: prepared.plan?.id })).toEqual({ status: 'cancelled' })
        expect(commit).not.toHaveBeenCalled()
        if (phase === 'before-native') expect(f.adapters.confirmRestore).not.toHaveBeenCalled()
        else expect(f.adapters.confirmRestore).toHaveBeenCalledTimes(1)
        expect(backupSnapshotSHA256(await f.store.snapshot())).toBe(before)
        await expect(f.service.restore({ id: prepared.plan?.id })).rejects.toThrow('失效')
      })
    },
    20000
  )

  it('lets the existing real Native transaction finish after admission even if its former renderer owner is lost', async () => {
    await fixture(async (f) => {
      let ownerLive = true
      const recheck = (): void => {
          if (!ownerLive) throw new Error('Owner no longer live')
        },
        inspected = await inspect(f, recheck),
        prepared = await f.service.prepareLegacyRelayImport(request(inspected)),
        commit = f.store.commitRestore.bind(f.store)
      f.adapters.confirmRestore = async () => true
      vi.spyOn(f.store, 'commitRestore').mockImplementationOnce(async (...args) => {
        ownerLive = false
        return commit(...args)
      })
      expect(await f.service.restore({ id: prepared.plan?.id })).toEqual({ status: 'restored' })
      expect(ownerLive).toBe(false)
      const profile = prepared.report?.profiles[0]
      if (!profile) throw new Error('Missing copied profile')
      expect(
        (
          await new ProfileStore(f.context).read({
            id: profile.profileId,
            sha256: profile.profileSHA256
          })
        ).text
      ).toBe(configuration)
      expect(await readFile(join(f.sourceDirectory, 'profile.yaml'), 'utf8')).toBe(configuration)
    })
  }, 20000)

  it.each(['native', 'read'] as const)(
    'waits for late %s while invalidation prevents inspection reinstallation',
    async (phase) => {
      await fixture(async (f) => {
        const ready = Promise.withResolvers<void>(),
          gate = Promise.withResolvers<void>(),
          originalInspect = f.adapters.inspectLegacyRelay
        if (!originalInspect) throw new Error('Missing inspect adapter')
        f.adapters.confirmLegacyRelayInspect = vi.fn(async () => {
          if (phase === 'native') {
            ready.resolve()
            await gate.promise
          }
          return true
        })
        f.adapters.inspectLegacyRelay = vi.fn(async (...args) => {
          const result = await originalInspect(...args)
          if (phase === 'read') {
            ready.resolve()
            await gate.promise
          }
          return result
        })
        const pending = f.service.inspectLegacyRelay({ origin: 'Relay-Preview' })
        await ready.promise
        f.service.invalidatePending()
        let idle = false
        const waiting = f.service.whenIdle().then(() => {
          idle = true
        })
        await Promise.resolve()
        expect(idle).toBe(false)
        gate.resolve()
        expect(await pending).toEqual({ status: 'cancelled' })
        await waiting
        if (phase === 'native') expect(f.adapters.inspectLegacyRelay).not.toHaveBeenCalled()
        expect(f.adapters.cancelLegacyRelayInspection).toHaveBeenCalled()
        expect(f.service.isBusy()).toBe(false)
      })
    }
  )

  it.each(['conversion', 'record-plan'] as const)(
    'keeps originals but returns no late restore proof after %s cancellation',
    async (phase) => {
      await fixture(async (f) => {
        const inspected = await inspect(f),
          ready = Promise.withResolvers<void>(),
          gate = Promise.withResolvers<void>(),
          original = f.adapters.prepareLegacyRelayArchive,
          staged = vi.spyOn(f.store, 'stageRestore'),
          commit = vi.spyOn(f.store, 'commitRestore'),
          before = backupSnapshotSHA256(await f.store.snapshot())
        if (!original) throw new Error('Missing preparation adapter')
        f.adapters.prepareLegacyRelayArchive = async (...args) => {
          const result = await original(...args)
          if (phase === 'conversion') {
            ready.resolve()
            await gate.promise
            return result
          }
          return {
            ...result,
            async recordPlan(plan) {
              await result.recordPlan(plan)
              ready.resolve()
              await gate.promise
            }
          }
        }
        const pending = f.service.prepareLegacyRelayImport(request(inspected))
        await ready.promise
        f.service.cancel()
        gate.resolve()
        expect(await pending).toEqual({ status: 'cancelled' })
        await f.service.whenIdle()
        if (phase === 'conversion') expect(staged).not.toHaveBeenCalled()
        expect(commit).not.toHaveBeenCalled()
        expect(backupSnapshotSHA256(await f.store.snapshot())).toBe(before)
        const [id] = await readdir(join(f.context.stateRoot, 'Migrations'))
        expect(
          await readFile(join(f.context.stateRoot, 'Migrations', id, 'original.zip'))
        ).toBeInstanceOf(Buffer)
        await expect(f.service.prepareLegacyRelayImport(request(inspected))).rejects.toThrow('失效')
      })
    },
    20000
  )

  it('fails closed on a mismatched original SHA without publishing an original or report', async () => {
    await fixture(async (f) => {
      const inspected = await inspect(f),
        baseline = await f.store.snapshot(),
        publish = vi.fn(f.publish)
      await expect(
        prepareLegacyRelayMigrationRecord(
          f.context,
          baseline,
          new AbortController().signal,
          publish,
          async (temporaryHome) => {
            f.conversions.add(temporaryHome)
            const result = await f.migrator.prepare(request(inspected), {
              baseline,
              temporaryHome,
              signal: new AbortController().signal
            })
            return {
              ...result,
              report: { ...result.report, originalArchiveSHA256: 'f'.repeat(64) }
            }
          }
        )
      ).rejects.toThrow('原备份')
      expect(publish).not.toHaveBeenCalled()
      const [id] = await readdir(join(f.context.stateRoot, 'Migrations'))
      expect(await readdir(join(f.context.stateRoot, 'Migrations', id))).toEqual([])
    })
  })

  it.each(['native', 'read'] as const)(
    'revokes a late %s result on private owner loss without an emitted lifecycle event',
    async (phase) => {
      await fixture(async (f) => {
        let ownerLive = true
        const recheck = (): void => {
            if (!ownerLive) throw new Error('Owner getter no longer available')
          },
          ready = Promise.withResolvers<void>(),
          gate = Promise.withResolvers<void>(),
          originalInspect = f.adapters.inspectLegacyRelay
        if (!originalInspect) throw new Error('Missing inspect adapter')
        f.adapters.confirmLegacyRelayInspect = async () => {
          if (phase === 'native') {
            ready.resolve()
            await gate.promise
          }
          return true
        }
        f.adapters.inspectLegacyRelay = vi.fn(async (...args) => {
          const inspected = await originalInspect(...args)
          if (phase === 'read') {
            ready.resolve()
            await gate.promise
          }
          return inspected
        })
        const pending = f.service.inspectLegacyRelay({ origin: 'Relay-Preview' }, recheck)
        await ready.promise
        ownerLive = false
        expect(f.service.isBusy()).toBe(true)
        gate.resolve()
        expect(await pending).toEqual({ status: 'cancelled' })
        await f.service.whenIdle()
        if (phase === 'native') expect(f.adapters.inspectLegacyRelay).not.toHaveBeenCalled()
        expect(f.adapters.cancelLegacyRelayInspection).toHaveBeenCalled()
        expect(f.service.isBusy()).toBe(false)
      })
    }
  )

  it.each(['snapshot', 'conversion', 'stage', 'record-plan'] as const)(
    'checks the inspection-bound private owner after the awaited %s and publishes no plan on loss',
    async (phase) => {
      await fixture(async (f) => {
        let ownerLive = true
        const recheck = (): void => {
            if (!ownerLive) throw new Error('Owner changed without a lifecycle event')
          },
          inspected = await inspect(f, recheck),
          before = backupSnapshotSHA256(await f.store.snapshot()),
          ready = Promise.withResolvers<void>(),
          gate = Promise.withResolvers<void>(),
          originalPrepare = f.adapters.prepareLegacyRelayArchive,
          originalSnapshot = f.store.snapshot.bind(f.store),
          originalStage = f.store.stageRestore.bind(f.store),
          stage = vi.spyOn(f.store, 'stageRestore'),
          commit = vi.spyOn(f.store, 'commitRestore')
        if (!originalPrepare) throw new Error('Missing preparation adapter')
        if (phase === 'snapshot')
          vi.spyOn(f.store, 'snapshot').mockImplementationOnce(async () => {
            const result = await originalSnapshot()
            ready.resolve()
            await gate.promise
            return result
          })
        if (phase === 'stage')
          stage.mockImplementationOnce(async (...args) => {
            const result = await originalStage(...args)
            ready.resolve()
            await gate.promise
            return result
          })
        f.adapters.prepareLegacyRelayArchive = async (...args) => {
          const result = await originalPrepare(...args)
          if (phase === 'conversion') {
            ready.resolve()
            await gate.promise
          }
          if (phase === 'record-plan')
            return {
              ...result,
              async recordPlan(plan) {
                await result.recordPlan(plan)
                ready.resolve()
                await gate.promise
              }
            }
          return result
        }
        const pending = f.service.prepareLegacyRelayImport(request(inspected))
        await ready.promise
        ownerLive = false
        expect(f.service.isBusy()).toBe(true)
        gate.resolve()
        expect(await pending).toEqual({ status: 'cancelled' })
        await f.service.whenIdle()
        expect(commit).not.toHaveBeenCalled()
        if (phase === 'snapshot' || phase === 'conversion') expect(stage).not.toHaveBeenCalled()
        expect(backupSnapshotSHA256(await f.store.snapshot())).toBe(before)
        await expect(f.service.prepareLegacyRelayImport(request(inspected))).rejects.toThrow('失效')
      })
    },
    20000
  )

  it('preserves a late foreign original and never falls back from exclusive Native publication', async () => {
    await fixture(async (f) => {
      const inspected = await inspect(f),
        baseline = await f.store.snapshot()
      let foreign = ''
      await expect(
        prepareLegacyRelayMigrationRecord(
          f.context,
          baseline,
          new AbortController().signal,
          async (publication) => {
            if (publication.name === 'original.zip') {
              foreign = join(f.context.stateRoot, 'Migrations', publication.id, publication.name)
              await writeFile(foreign, 'FOREIGN-ORIGINAL', { flag: 'wx', mode: 0o600 })
            }
            return f.publish(publication)
          },
          async (temporaryHome) => {
            f.conversions.add(temporaryHome)
            return f.migrator.prepare(request(inspected), {
              baseline,
              temporaryHome,
              signal: new AbortController().signal
            })
          }
        )
      ).rejects.toThrow('没有替换当前资料')
      expect(await readFile(foreign, 'utf8')).toBe('FOREIGN-ORIGINAL')
      expect(await readdir(join(foreign, '..'))).toEqual(['original.zip'])
      expect(await readFile(join(f.sourceDirectory, 'profile.yaml'), 'utf8')).toBe(configuration)
    })
  })
})
