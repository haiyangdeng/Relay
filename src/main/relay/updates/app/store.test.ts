import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AppReleaseConfiguration } from './configuration'
import { publicAppRelease, type TrustedAppRelease } from './release'
import { appUpdateHash, AppUpdateCandidateStore } from './store'

const config = {
  feedURLs: {
    arm64: 'https://fixture.invalid/latest-arm64.json',
    x64: 'https://fixture.invalid/latest-x64.json'
  },
  downloadOrigins: ['https://fixture.invalid'],
  applicationIdentifier: 'local.relay.network.preview',
  applicationBundleName: 'Relay.app',
  packageIdentifier: 'local.relay.fixture.pkg',
  publisherTeamID: 'FIXTURE123',
  approvedInstallerScriptSHA256: [],
  maximumPackageBytes: 1024
} satisfies AppReleaseConfiguration
const bytes = Buffer.from('xar!synthetic update candidate')
const release: TrustedAppRelease = {
  version: '2.0.1',
  architecture: 'arm64',
  bytes: bytes.length,
  sha512: createHash('sha512').update(bytes).digest('base64'),
  releasedAt: '2026-11-08T00:00:00.000Z',
  url: 'https://fixture.invalid/update.pkg',
  metadataSHA256: 'a'.repeat(64),
  trustRevision: 'b'.repeat(64)
}

async function fixture(count: number, run: (store: AppUpdateCandidateStore) => Promise<void>) {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'relay-app-update-store-'))
  try {
    const store = new AppUpdateCandidateStore({
      home,
      stateRoot: join(home, 'Library/Application Support/Relay-Preview')
    })
    await store.files.directory(store.root, true)
    // Seed the same format previous versions wrote, including over-capacity sets.
    for (let index = 0; index < count; index++) {
      const id = randomUUID(),
        root = join(store.root, id)
      const candidate = {
        ...publicAppRelease(release),
        id,
        sha256: appUpdateHash(bytes),
        stagedAt: index + 1
      }
      await mkdir(root, { mode: 0o700 })
      await writeFile(join(root, 'record.json'), JSON.stringify({ release, candidate }), {
        mode: 0o600
      })
      await writeFile(join(root, 'update.pkg'), bytes, { mode: 0o600 })
    }
    await run(store)
  } finally {
    await rm(home, { recursive: true })
  }
}

describe('Application update candidate capacity', () => {
  it('keeps older overflowing inventories readable and allows recovery by ordinary removal', () =>
    fixture(66, async (store) => {
      const inventory = await store.list(config, release.trustRevision)
      expect(inventory.candidates).toHaveLength(64)
      expect(inventory.incomplete).toBe(2)

      for (const candidate of inventory.candidates.slice(0, 3))
        await store.remove(candidate.id, config, release.trustRevision, () => {})

      const remaining = await store.list(config, release.trustRevision)
      expect(remaining.candidates).toHaveLength(63)
      expect(remaining.incomplete).toBe(0)
    }))

  it('admits one concurrent stage at the last slot and refuses further staging before writing', () =>
    fixture(63, async (store) => {
      const signal = new AbortController().signal
      const results = await Promise.allSettled([
        store.stage(release, bytes, signal),
        store.stage(release, bytes, signal)
      ])
      expect(results.map((result) => result.status)).toEqual(['fulfilled', 'rejected'])
      const full = (await readdir(store.root)).sort()
      expect(full).toHaveLength(64)
      const writeRecord = vi.spyOn(store.files, 'write')
      await expect(store.stage(release, bytes, signal)).rejects.toThrow('应用更新候选已达上限')
      expect(writeRecord).not.toHaveBeenCalled()
      expect((await readdir(store.root)).sort()).toEqual(full)

      await store.remove(full[0], config, release.trustRevision, () => {})
      const replacement = await store.stage(release, bytes, signal)
      const inventory = await store.list(config, release.trustRevision)
      expect(inventory.candidates).toHaveLength(64)
      expect(inventory.candidates).toContainEqual(replacement)
      expect(inventory.incomplete).toBe(0)
    }))
})
