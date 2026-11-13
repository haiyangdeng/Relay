import { fstatSync, lstatSync } from 'fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, type FileHandle } from 'fs/promises'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SMART_MODEL_CONTROLS } from '../profiles/groups'
import { smartStateDigest } from './smart-state-schema'
import { trustedSmartModels, type TrustedSmartModel } from './smart-models'
import { trustedCoreVariants } from './trusted-variants'
import { stageSmartRuntimeModel } from './smart-runtime'

const owned: { root: string; file?: FileHandle }[] = []
afterEach(async () => {
  for (const item of owned.splice(0)) {
    try {
      await item.file?.close()
    } catch {
      /* An invalid transfer was already closed by its creator. */
    }
    await rm(item.root, { recursive: true, force: true })
  }
})
async function fixture() {
  const root = await realpath(await mkdtemp('/private/tmp/relay-model-creator-')),
    source = join(root, 'source'),
    target = join(root, 'target'),
    pin = trustedSmartModels()[0],
    core = trustedCoreVariants().find(
      (item) => item.family === 'smart' && item.architecture === 'arm64'
    )
  if (!core) throw new Error('missing fixed Smart core metadata')
  const holder: { root: string; file?: FileHandle } = { root }
  owned.push(holder)
  await mkdir(source, { mode: 0o700 })
  await mkdir(target, { mode: 0o700 })
  const bytes = await readFile(
    join(process.cwd(), '.relay-build/variant-reference/model-Model.bin')
  )
  expect(bytes.length).toBe(pin.size)
  expect(smartStateDigest(bytes)).toBe(pin.sha256)
  await writeFile(join(source, 'Model.bin'), bytes, { flag: 'wx', mode: 0o600 })
  await writeFile(join(source, 'relay-model.json'), JSON.stringify({ kind: 'smart', ...pin }), {
    flag: 'wx',
    mode: 0o600
  })
  const config = JSON.stringify({
    'proxy-groups': [{ name: 'S', type: 'smart' }],
    ...SMART_MODEL_CONTROLS
  })
  return {
    holder,
    source,
    target,
    pin,
    bytes,
    config,
    resource: { ...core, executable: '/not-executed' }
  }
}
describe('Private optional model creator registration with exact cached pinned model, no Core', () => {
  it('transfers the readable creator FD before any model byte is written and retains the exact inode', async () => {
    const f = await fixture(),
      callback = vi.fn((file: FileHandle, pin: TrustedSmartModel) => {
        f.holder.file = file
        const current = fstatSync(file.fd),
          linked = lstatSync(join(f.target, 'Model.bin'))
        expect(current.size).toBe(0)
        expect(current.ino).toBe(linked.ino)
        expect(pin.sha256).toBe(f.pin.sha256)
      })
    expect(
      await stageSmartRuntimeModel(f.source, f.target, f.resource, f.config, callback)
    ).toEqual(f.pin)
    const file = f.holder.file
    if (!file) throw new Error('missing transferred creator FD')
    const stat = await file.stat(),
      linked = lstatSync(join(f.target, 'Model.bin'))
    expect(stat.ino).toBe(linked.ino)
    expect(stat.size).toBe(f.pin.size)
    const prefix = Buffer.alloc(1024)
    expect((await file.read(prefix, 0, prefix.length, 0)).bytesRead).toBe(1024)
    expect(prefix).toEqual(f.bytes.subarray(0, 1024))
    expect(callback).toHaveBeenCalledOnce()
  })
  it('preserves the old no-callback behavior with the same exact pinned output', async () => {
    const f = await fixture()
    expect(await stageSmartRuntimeModel(f.source, f.target, f.resource, f.config)).toEqual(f.pin)
    expect(smartStateDigest(await readFile(join(f.target, 'Model.bin')))).toBe(f.pin.sha256)
  })
  it('keeps the exclusive empty file but closes the FD if synchronous creator registration fails', async () => {
    const f = await fixture()
    await expect(
      stageSmartRuntimeModel(f.source, f.target, f.resource, f.config, (file) => {
        f.holder.file = file
        throw new Error('creator registration failed')
      })
    ).rejects.toThrow('registration failed')
    expect((await readFile(join(f.target, 'Model.bin'))).length).toBe(0)
    await expect(f.holder.file?.stat()).rejects.toThrow()
  })
  it('refuses an async rejected registration before writing and consumes its rejection', async () => {
    const f = await fixture(),
      errors: unknown[] = [],
      listen = (error: unknown): void => {
        errors.push(error)
      }
    process.on('unhandledRejection', listen)
    try {
      await expect(
        stageSmartRuntimeModel(f.source, f.target, f.resource, f.config, async () => {
          throw new Error('invalid async creator')
        })
      ).rejects.toThrow('同步')
      await new Promise<void>((resolve) => setImmediate(resolve))
      expect(errors).toEqual([])
      expect((await readFile(join(f.target, 'Model.bin'))).length).toBe(0)
    } finally {
      process.removeListener('unhandledRejection', listen)
    }
  })
})
