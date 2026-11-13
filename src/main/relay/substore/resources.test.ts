import { createHash } from 'crypto'
import { mkdtemp, realpath, rm, symlink, writeFile, readFile, readdir } from 'fs/promises'
import { join } from 'path'
import AdmZip from 'adm-zip'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SubStoreResources,
  subStoreFrontendFiles,
  verifySubStoreAsset,
  type SubStoreManifest
} from './resources'

const roots: string[] = []
const faults = vi.hoisted(() => ({ failPublish: false, failRollback: false, archived: false }))
vi.mock('fs/promises', async (original) => {
  const fs = await original<typeof import('fs/promises')>()
  return {
    ...fs,
    rename: async (...args: Parameters<typeof fs.rename>) => {
      const [from, to] = args
      if (
        (faults.failPublish && faults.archived && String(from).includes('/.resources-')) ||
        (faults.failRollback && String(from).endsWith('/original'))
      )
        throw Object.assign(new Error('Injected resource transaction failure.'), { code: 'EIO' })
      await fs.rename(...args)
      if (String(to).endsWith('/original')) faults.archived = true
    }
  }
})
beforeEach(() => {
  faults.failPublish = false
  faults.failRollback = false
  faults.archived = false
})
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
export function resourceFixture() {
  const zip = new AdmZip()
  zip.addFile('dist/index.html', Buffer.from('<html>fixture only</html>'))
  zip.addFile('dist/assets/index.js', Buffer.from('/* fixture */'))
  const backend = Buffer.from('/* fixture - never executed */'),
    frontend = zip.toBuffer()
  const pin = (bytes: Buffer) => ({
    version: 'fixture',
    url: 'https://github.com/fixture',
    releaseURL: 'https://github.com/fixture',
    size: bytes.length,
    sha256: sha(bytes)
  })
  const manifest: SubStoreManifest = {
    schemaVersion: 1,
    backend: pin(backend),
    frontend: pin(frontend)
  }
  return { backend, frontend, manifest }
}
async function fixture() {
  const root = await realpath(await mkdtemp('/private/tmp/relay-substore-resource-'))
  roots.push(root)
  const bytes = resourceFixture(),
    resources = new SubStoreResources(root, bytes.manifest)
  return { root, resources, ...bytes }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
describe('Pinned private Sub-Store resource transactions', () => {
  it('repairs a corrupt fixed cache only after verification, preserving its original bytes and all business data', async () => {
    const f = await fixture(),
      signal = new AbortController().signal
    await f.resources.install(f.backend, f.frontend, signal)
    await writeFile(join(f.resources.dataRoot, 'subscriptions.json'), 'PRIVATE fixture data', {
      mode: 0o600
    })
    await writeFile(join(f.resources.directory, 'backend.cjs'), 'corrupt old resource')
    await f.resources.install(f.backend, f.frontend, signal)
    expect((await f.resources.load()).files.has('/index.html')).toBe(true)
    const retained = (await readdir(join(f.root, 'SubStore'))).filter((name) =>
      name.startsWith('retained-resources-')
    )
    expect(retained).toHaveLength(1)
    expect(
      await readFile(join(f.root, 'SubStore', retained[0], 'original/backend.cjs'), 'utf8')
    ).toBe('corrupt old resource')
    expect(await readFile(join(f.resources.dataRoot, 'subscriptions.json'), 'utf8')).toBe(
      'PRIVATE fixture data'
    )
    await f.resources.install(f.backend, f.frontend, signal)
    expect(
      (await readdir(join(f.root, 'SubStore'))).filter((name) =>
        name.startsWith('retained-resources-')
      )
    ).toHaveLength(1)
  })
  it('does not move unknown directory contents or symlinks as a repair', async () => {
    const f = await fixture(),
      signal = new AbortController().signal
    await f.resources.install(f.backend, f.frontend, signal)
    await writeFile(join(f.resources.directory, 'backend.cjs'), 'corrupt')
    await writeFile(join(f.resources.directory, 'unknown.txt'), 'user data', { mode: 0o600 })
    await expect(f.resources.install(f.backend, f.frontend, signal)).rejects.toThrow('未知内容')
    expect(await readFile(join(f.resources.directory, 'unknown.txt'), 'utf8')).toBe('user data')
    await rm(join(f.resources.directory, 'unknown.txt'))
    await rm(join(f.resources.directory, 'backend.cjs'))
    const outside = join(f.root, 'outside')
    await writeFile(outside, f.backend, { mode: 0o600 })
    await symlink(outside, join(f.resources.directory, 'backend.cjs'))
    await expect(f.resources.install(f.backend, f.frontend, signal)).rejects.toThrow('未知文件身份')
    expect(await readFile(outside)).toEqual(f.backend)
  })
  it.each([false, true])(
    'preserves originals when publication fails, including rollback failure=%s',
    async (rollbackFails) => {
      const f = await fixture(),
        signal = new AbortController().signal
      await f.resources.install(f.backend, f.frontend, signal)
      await writeFile(join(f.resources.directory, 'backend.cjs'), 'old corrupt bytes')
      await writeFile(join(f.resources.dataRoot, 'data.json'), 'unchanged business data', {
        mode: 0o600
      })
      faults.failPublish = true
      faults.failRollback = rollbackFails
      await expect(f.resources.install(f.backend, f.frontend, signal)).rejects.toThrow()
      if (!rollbackFails)
        expect(await readFile(join(f.resources.directory, 'backend.cjs'), 'utf8')).toBe(
          'old corrupt bytes'
        )
      else {
        const retained = (await readdir(join(f.root, 'SubStore'))).find((name) =>
          name.startsWith('retained-resources-')
        )
        expect(retained).toBeDefined()
        expect(
          await readFile(join(f.root, 'SubStore', String(retained), 'original/backend.cjs'), 'utf8')
        ).toBe('old corrupt bytes')
      }
      expect(await readFile(join(f.resources.dataRoot, 'data.json'), 'utf8')).toBe(
        'unchanged business data'
      )
      await expect(f.resources.load()).rejects.toThrow()
    }
  )
  it('verifies both assets before atomically installing immutable bytes and rechecks cached copies', async () => {
    const f = await fixture(),
      signal = new AbortController().signal
    await f.resources.install(f.backend, f.frontend, signal)
    const loaded = await f.resources.load()
    expect(loaded.files.get('/index.html')?.toString()).toContain('fixture only')
    await f.resources.install(f.backend, f.frontend, signal)
    await writeFile(loaded.backendPath, 'tampered')
    await expect(f.resources.load()).rejects.toThrow('固定摘要')
  })
  it('refuses corrupt assets, cancelled installation and missing HTML rather than claiming readiness', async () => {
    const f = await fixture(),
      abort = new AbortController()
    abort.abort()
    await expect(f.resources.install(f.backend, f.frontend, abort.signal)).rejects.toThrow('取消')
    await expect(f.resources.load()).rejects.toThrow()
    expect(() => verifySubStoreAsset(Buffer.from('wrong'), f.manifest.backend)).toThrow('固定摘要')
    const zip = new AdmZip()
    zip.addFile('dist/assets/a.js', Buffer.from('fixture'))
    expect(() => subStoreFrontendFiles(zip.toBuffer())).toThrow('缺少入口')
  })
  it('rejects private path substitution and foreign archive paths', async () => {
    const f = await fixture(),
      signal = new AbortController().signal
    await f.resources.install(f.backend, f.frontend, signal)
    await rm(join(f.resources.directory, 'backend.cjs'))
    const outside = join(f.root, 'outside')
    await writeFile(outside, f.backend, { mode: 0o600 })
    await symlink(outside, join(f.resources.directory, 'backend.cjs'))
    await expect(f.resources.load()).rejects.toThrow()
    const zip = new AdmZip()
    zip.addFile('outside.txt', Buffer.from('fixture'))
    expect(() => subStoreFrontendFiles(zip.toBuffer())).toThrow('压缩路径')
  })
})
