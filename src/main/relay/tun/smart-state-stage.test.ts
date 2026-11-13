import { randomUUID } from 'crypto'
import {
  mkdtemp,
  realpath,
  mkdir,
  readFile,
  writeFile,
  rm,
  lstat,
  rename,
  symlink,
  link
} from 'fs/promises'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { SmartStateStore } from '../core/smart-state-store'
import { smartStateCSVHeader, smartStateDigest } from '../core/smart-state-schema'
import { createTunSmartStateStage } from './smart-state-stage'
import type { TunSmartStateSnapshot } from './smart-state-channel'

const binding = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  evidenceSHA256: 'a'.repeat(64),
  runtimeConfigurationSHA256: 'b'.repeat(64)
}
async function fixture(
  collect: boolean,
  run: (f: {
    root: string
    stage: Awaited<ReturnType<typeof createTunSmartStateStage>>
    snapshot: TunSmartStateSnapshot
    publish: (patch?: Record<string, unknown>) => Promise<void>
    bytes: { path: 'cache.db' | 'smart_weight_data.csv'; bytes: Buffer }[]
  }) => Promise<void>
) {
  const home = await realpath(await mkdtemp('/private/tmp/relay-smart-stage-')),
    root = join(home, 'stage')
  await mkdir(root, { mode: 0o700 })
  const store = new SmartStateStore({
      home,
      stateRoot: join(home, 'Library/Application Support/Relay-Preview')
    }),
    prepared = await store.prepare(randomUUID(), collect),
    stage = await createTunSmartStateStage(root, prepared),
    bytes: { path: 'cache.db' | 'smart_weight_data.csv'; bytes: Buffer }[] = [
      { path: 'cache.db', bytes: Buffer.from('closed database fixture') }
    ]
  if (collect)
    bytes.push({
      path: 'smart_weight_data.csv',
      bytes: Buffer.concat([smartStateCSVHeader(), Buffer.from('partial tail retained')])
    })
  const files = bytes.map((f) => ({
      path: f.path,
      sha256: smartStateDigest(f.bytes),
      size: f.bytes.length
    })),
    metadata = {
      version: 1,
      kind: 'relay-smart-state-result',
      ...binding,
      executionSHA256: 'c'.repeat(64),
      key: prepared.receipt.key,
      previousRevision: prepared.receipt.previousRevision,
      files
    },
    raw = Buffer.from(JSON.stringify(metadata)),
    snapshot = {
      version: 1 as const,
      executionSHA256: metadata.executionSHA256,
      key: metadata.key,
      previousRevision: metadata.previousRevision,
      files,
      resultSHA256: smartStateDigest(raw)
    }
  try {
    await run({
      root,
      stage,
      bytes,
      snapshot,
      publish: async (patch = {}) => {
        for (const f of bytes)
          await writeFile(join(root, 'state-result', f.path), f.bytes, { mode: 0o600 })
        await writeFile(
          join(root, 'state-result/receipt.json'),
          JSON.stringify({ ...metadata, ...patch }),
          { mode: 0o600 }
        )
      }
    })
  } finally {
    await stage.close()
    await rm(home, { recursive: true, force: true })
  }
}
describe('Main Smart seed/result bounded finite staging', () => {
  it.each([false, true])(
    'copies exact seed and reads only authenticated closed bytes, CSV=%s',
    async (collect) =>
      fixture(collect, async (f) => {
        expect(await readFile(join(f.root, 'state-seed/cache.db'))).toEqual(Buffer.alloc(0))
        await f.stage.recheck()
        await f.publish()
        const output = await f.stage.readResult(f.snapshot, binding)
        expect(output).toEqual(f.bytes)
        await f.stage.cleanup()
        await expect(lstat(join(f.root, 'state-result'))).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(lstat(join(f.root, 'state-seed'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect((await lstat(f.root)).isDirectory()).toBe(true)
      })
  )
  it('cleans its own empty pre-bootstrap result and created seeds', async () =>
    fixture(false, async (f) => {
      await f.stage.cleanup()
      await expect(lstat(join(f.root, 'state-seed'))).rejects.toMatchObject({ code: 'ENOENT' })
    }))
  it('retains all files on unknown result inventory before cleanup', async () =>
    fixture(false, async (f) => {
      await writeFile(join(f.root, 'state-result/unregistered'), 'unknown', { mode: 0o600 })
      await expect(f.stage.cleanup()).rejects.toThrow()
      expect(await readFile(join(f.root, 'state-seed/cache.db'))).toEqual(Buffer.alloc(0))
    }))
  it('does not adopt a replacement result directory', async () =>
    fixture(false, async (f) => {
      await rename(join(f.root, 'state-result'), join(f.root, 'old-result'))
      await mkdir(join(f.root, 'state-result'), { mode: 0o700 })
      await f.publish()
      await expect(f.stage.readResult(f.snapshot, binding)).rejects.toThrow()
    }))
  it('rejects modified seed bytes and retains output', async () =>
    fixture(false, async (f) => {
      await writeFile(join(f.root, 'state-seed/cache.db'), 'changed')
      await f.publish()
      await expect(f.stage.readResult(f.snapshot, binding)).rejects.toThrow()
      expect(await readFile(join(f.root, 'state-result/cache.db'))).toEqual(f.bytes[0].bytes)
    }))
  it.each(['extra', 'link', 'symlink', 'hash', 'binding', 'metadata', 'large', 'missing'] as const)(
    'retains evidence on malformed %s result',
    async (defect) =>
      fixture(false, async (f) => {
        await f.publish()
        const cache = join(f.root, 'state-result/cache.db')
        if (defect === 'extra') await writeFile(join(f.root, 'state-result/new'), '')
        if (defect === 'link') await link(cache, join(f.root, 'state-result/hardlink'))
        if (defect === 'symlink') {
          await rename(cache, join(f.root, 'original'))
          await symlink(join(f.root, 'original'), cache)
        }
        if (defect === 'hash') await writeFile(cache, 'bad')
        if (defect === 'binding') binding.sessionId = '22222222-2222-4222-8222-222222222222'
        if (defect === 'metadata') await writeFile(join(f.root, 'state-result/receipt.json'), '{}')
        if (defect === 'large')
          await writeFile(join(f.root, 'state-result/receipt.json'), 'a'.repeat(16385))
        if (defect === 'missing') await rm(cache)
        try {
          await expect(f.stage.readResult(f.snapshot, binding)).rejects.toThrow()
        } finally {
          binding.sessionId = '11111111-1111-4111-8111-111111111111'
        }
        await expect(f.stage.readResult(f.snapshot, binding)).rejects.toThrow()
        await expect(lstat(join(f.root, 'state-seed/cache.db'))).resolves.toBeDefined()
      })
  )
  it('revalidates held result descriptors and the whole union before any deletion', async () =>
    fixture(false, async (f) => {
      await f.publish()
      await f.stage.readResult(f.snapshot, binding)
      await writeFile(join(f.root, 'state-result/cache.db'), 'changed')
      await expect(f.stage.cleanup()).rejects.toThrow()
      expect(await readFile(join(f.root, 'state-seed/cache.db'))).toEqual(Buffer.alloc(0))
    }))
})
