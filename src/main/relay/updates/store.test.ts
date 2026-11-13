import { createHash } from 'crypto'
import { gzipSync } from 'zlib'
import { mkdtemp, realpath, rm, writeFile, symlink } from 'fs/promises'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { UpdateCandidateStore, verifiedUpdatePayload } from './store'
import { trustedUpdateCatalog, type TrustedUpdateAsset } from './catalog'

const hash = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
export function updateFixtureBytes() {
  const payload = Buffer.alloc(32)
  payload.writeUInt32LE(0xfeedfacf, 0)
  payload.writeUInt32LE(0x100000c, 4)
  const bytes = gzipSync(payload)
  const asset: TrustedUpdateAsset = {
    target: 'core',
    version: 'fixture',
    architecture: 'arm64',
    url: 'https://github.com/fixture/core.gz',
    releaseURL: 'https://github.com/fixture',
    downloadBytes: bytes.length,
    downloadSHA256: hash(bytes),
    encoding: 'gzip',
    sha256: hash(payload),
    payloadSHA256: hash(payload),
    payloadBytes: payload.length,
    cpuType: 0x100000c
  }
  return { payload, bytes, asset }
}
async function fixture(
  run: (
    context: { store: UpdateCandidateStore; stateRoot: string } & ReturnType<
      typeof updateFixtureBytes
    >
  ) => Promise<void>
): Promise<void> {
  const home = await realpath(await mkdtemp('/private/tmp/relay-update-store-'))
  const context = { home, stateRoot: join(home, 'Library/Application Support/Relay') }
  const inputs = updateFixtureBytes()
  try {
    await run({
      ...inputs,
      stateRoot: context.stateRoot,
      store: new UpdateCandidateStore(context, [inputs.asset])
    })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

describe('Trusted immutable update candidates', () => {
  it('exposes only reviewed fixed resources for the host architecture', () => {
    expect(trustedUpdateCatalog('arm64').map((asset) => asset.target)).toEqual([
      'core',
      'core-alpha',
      'core-smart',
      'smart-model',
      'smart-model-middle',
      'smart-model-large',
      'substore-backend',
      'substore-frontend'
    ])
    expect(trustedUpdateCatalog('x64')[0].architecture).toBe('x64')
    expect(trustedUpdateCatalog('other')).toEqual([])
    expect(trustedUpdateCatalog('arm64')[0].version).toBe('v1.19.33')
  })
  it('verifies compressed and expanded bytes and architecture before accepting a core candidate', () => {
    const f = updateFixtureBytes()
    expect(verifiedUpdatePayload(f.asset, f.bytes)).toEqual(f.payload)
    expect(() => verifiedUpdatePayload(f.asset, Buffer.from('corrupt'))).toThrow('可信摘要')
    expect(() =>
      verifiedUpdatePayload({ ...f.asset, payloadSHA256: '0'.repeat(64) }, f.bytes)
    ).toThrow('展开')
    expect(() => verifiedUpdatePayload({ ...f.asset, cpuType: 0x1000007 }, f.bytes)).toThrow('架构')
    expect(() => verifiedUpdatePayload({ ...f.asset, payloadBytes: 8 }, f.bytes)).toThrow()
    for (const target of ['core-alpha', 'core-smart'] as const) {
      expect(verifiedUpdatePayload({ ...f.asset, target }, f.bytes)).toEqual(f.payload)
      expect(() =>
        verifiedUpdatePayload({ ...f.asset, target, cpuType: 0x1000007 }, f.bytes)
      ).toThrow('架构')
    }
  })
  it('checks the complete model format after exact download and payload digests', () => {
    const f = updateFixtureBytes(),
      payload = Buffer.from('tree\n' + 'model-fixture\n'.repeat(64) + '[/target_enhance]\n')
    for (const target of ['smart-model', 'smart-model-middle', 'smart-model-large'] as const) {
      const asset = {
        ...f.asset,
        target,
        encoding: 'identity' as const,
        downloadBytes: payload.length,
        downloadSHA256: hash(payload),
        payloadBytes: payload.length,
        payloadSHA256: hash(payload)
      }
      expect(verifiedUpdatePayload(asset, payload)).toEqual(payload)
      const malformed = Buffer.from(payload)
      malformed[0] = 0
      expect(() =>
        verifiedUpdatePayload(
          { ...asset, downloadSHA256: hash(malformed), payloadSHA256: hash(malformed) },
          malformed
        )
      ).toThrow('模型候选格式')
    }
  })
  it('stages in an isolated directory, leaves installed state false and rechecks cached bytes', async () => {
    await fixture(async ({ store, bytes, payload, asset }) => {
      expect(await store.list()).toEqual({ candidates: [], incomplete: 0 })
      const record = await store.stage(asset, bytes)
      expect(record).toMatchObject({
        installed: false,
        applied: false,
        payloadBytes: payload.length
      })
      expect((await store.resolve(record.id)).record).toEqual(record)
      const path = (await store.resolve(record.id)).path
      await writeFile(path, 'tampered', { mode: 0o600 })
      await expect(store.resolve(record.id)).rejects.toThrow('损坏')
      expect((await store.list()).incomplete).toBe(1)
    })
  })
  it('keeps an earlier good candidate when later download verification fails or cancellation arrives', async () => {
    await fixture(async ({ store, bytes, asset }) => {
      const record = await store.stage(asset, bytes)
      await expect(store.stage(asset, Buffer.from('failed'))).rejects.toThrow()
      const signal = new AbortController()
      signal.abort()
      await expect(store.stage(asset, bytes, signal.signal)).rejects.toThrow('取消')
      expect((await store.list()).candidates.map((item) => item.id)).toEqual([record.id])
      await store.remove(record.id)
      expect((await store.list()).candidates).toEqual([])
    })
  })
  it('does not read symlinked payloads or expose an arbitrary source path as an accepted candidate', async () => {
    await fixture(async ({ store, bytes, asset, stateRoot }) => {
      const record = await store.stage(asset, bytes)
      const path = (await store.resolve(record.id)).path
      await rm(path)
      await writeFile(join(stateRoot, 'outside'), 'foreign', { mode: 0o600 })
      await symlink(join(stateRoot, 'outside'), path)
      await expect(store.resolve(record.id)).rejects.toThrow()
      await expect(store.resolve('../../outside')).rejects.toThrow('凭据')
    })
  })
})
