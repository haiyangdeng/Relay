import { createHash } from 'crypto'
import { access, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { VariantStore } from './variant-store'
import manifest from './manifest.json'

const homes: string[] = []
async function fixture() {
  const home = await realpath(await mkdtemp('/private/tmp/relay-variants-test-'))
  homes.push(home)
  const stateRoot = join(home, 'Relay'),
    store = new VariantStore({ stateRoot })
  const bytes = Buffer.from('tree\n' + 'fixture\n'.repeat(32) + '[/target_enhance]\n')
  const sourcePath = join(home, 'Model.bin')
  await writeFile(sourcePath, bytes, { mode: 0o600 })
  return {
    home,
    stateRoot,
    store,
    bytes,
    request: {
      kind: 'smart' as const,
      sourcePath,
      version: 'fixture-only',
      sha256: createHash('sha256').update(bytes).digest('hex'),
      size: bytes.length
    }
  }
}
afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })))
})

describe('Private variant integrity and actual selected core root', () => {
  it('persists only metadata, rechecks the private model and clears a removed selection', async () => {
    const f = await fixture(),
      record = await f.store.acquire(f.request)
    expect(await f.store.verify(record.id)).toEqual(record)
    await f.store.select({ id: record.id })
    expect((await f.store.list()).activeSmartId).toBe(record.id)
    const metadata = await readFile(join(f.stateRoot, 'Variants/variants.json'), 'utf8')
    expect(metadata).not.toContain('sourcePath')
    expect(metadata).not.toContain(f.request.sourcePath)
    await f.store.remove({ id: record.id })
    expect((await f.store.list()).activeSmartId).toBeUndefined()
    expect((await f.store.list()).records).toEqual([])
  })
  it('rejects modified cached bytes when selecting, preserving the previous preference', async () => {
    const f = await fixture(),
      first = await f.store.acquire(f.request),
      second = await f.store.acquire(f.request)
    await f.store.select({ id: first.id })
    const target = join(f.stateRoot, 'Variants/variants', `smart-${second.id}`)
    const changed = Buffer.from(f.bytes)
    changed[20] ^= 1
    await writeFile(target, changed)
    await expect(f.store.select({ id: second.id })).rejects.toThrow('摘要')
    expect((await f.store.list()).activeSmartId).toBe(first.id)
  })
  it('refuses truncated or invalid models and does not create successful records', async () => {
    const f = await fixture()
    const bytes = Buffer.from('tree\n' + 'incomplete\n'.repeat(32))
    await writeFile(f.request.sourcePath, bytes)
    await expect(
      f.store.acquire({
        ...f.request,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex')
      })
    ).rejects.toThrow('不完整')
    expect((await f.store.list()).records).toEqual([])
  })
  it('rejects SHA/size mismatches and symbolic-link sources', async () => {
    const f = await fixture()
    await expect(f.store.acquire({ ...f.request, sha256: 'f'.repeat(64) })).rejects.toThrow('摘要')
    await expect(f.store.acquire({ ...f.request, size: f.request.size + 1 })).rejects.toThrow(
      '普通文件'
    )
    const linked = join(f.home, 'linked.bin')
    await symlink(f.request.sourcePath, linked)
    await expect(f.store.acquire({ ...f.request, sourcePath: linked })).rejects.toThrow()
    expect((await f.store.list()).records).toEqual([])
  })
  it('refuses unknown executable hashes before opening a source and never treats a supplied digest as trust', async () => {
    const f = await fixture()
    await expect(
      f.store.acquire({
        kind: 'core',
        sourcePath: '/not-opened',
        architecture: 'arm64',
        version: 'custom',
        sha256: 'a'.repeat(64),
        size: 1000000
      })
    ).rejects.toThrow('可信清单')
    expect((await f.store.list()).records).toEqual([])
  })
  it('rejects invalid metadata instead of silently dropping records or following traversal ids', async () => {
    const f = await fixture(),
      record = await f.store.acquire(f.request)
    await writeFile(
      join(f.stateRoot, 'Variants/variants.json'),
      JSON.stringify({ records: [{ ...record, id: '../../outside' }] })
    )
    await expect(f.store.list()).rejects.toThrow('记录读取失败')
    await expect(f.store.remove({ id: '../../outside' })).rejects.toThrow('UUID')
  })
  it('restores the default without using an absent or corrupt selected core', async () => {
    const f = await fixture()
    expect(await f.store.resolveCoreRoot('/default/pinned')).toBe('/default/pinned')
    await f.store.restore('core')
    expect(await f.store.resolveCoreRoot('/default/pinned')).toBe('/default/pinned')
  })
  it('uses a verified private pinned core root and detects tampering before the next parser/start', async () => {
    if (process.platform !== 'darwin' || (process.arch !== 'arm64' && process.arch !== 'x64'))
      return
    const f = await fixture(),
      architecture = process.arch,
      pin = manifest.assets[architecture]
    const sourcePath = await realpath(join(process.cwd(), 'extra/relay/core', pin.path))
    await access(sourcePath)
    const record = await f.store.acquire({
      kind: 'core',
      sourcePath,
      architecture,
      version: manifest.version,
      sha256: pin.sha256,
      size: pin.size
    })
    await f.store.select({ id: record.id })
    const selectedRoot = await f.store.resolveCoreRoot('/default/pinned')
    expect(selectedRoot).toContain(`core-${record.id}`)
    expect(selectedRoot).not.toBe('/default/pinned')
    await writeFile(join(selectedRoot, pin.path), Buffer.from('tampered'))
    await expect(f.store.resolveCoreRoot('/default/pinned')).rejects.toThrow('大小')
    await f.store.restore('core')
    expect(await f.store.resolveCoreRoot('/default/pinned')).toBe('/default/pinned')
  }, 30000)
})
