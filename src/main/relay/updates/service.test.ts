import { createHash } from 'crypto'
import { gzipSync } from 'zlib'
import { mkdtemp, realpath, rm } from 'fs/promises'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { UpdateCandidateStore } from './store'
import type { TrustedUpdateAsset } from './catalog'
import { createUpdateService } from './service'

async function fixture(
  run: (context: {
    service: ReturnType<typeof createUpdateService>
    adapters: Parameters<typeof createUpdateService>[0]
    bytes: Buffer
  }) => Promise<void>
): Promise<void> {
  const home = await realpath(await mkdtemp('/private/tmp/relay-update-service-'))
  const payload = Buffer.alloc(32)
  payload.writeUInt32LE(0xfeedfacf, 0)
  payload.writeUInt32LE(0x100000c, 4)
  const bytes = gzipSync(payload)
  const hash = (data: Buffer): string => createHash('sha256').update(data).digest('hex')
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
  const adapters: Parameters<typeof createUpdateService>[0] = {
    store: new UpdateCandidateStore(
      { home, stateRoot: join(home, 'Library/Application Support/Relay') },
      [asset]
    ),
    assertIdle: vi.fn(),
    confirmDownload: vi.fn(async () => false),
    confirmRemove: vi.fn(async () => false),
    download: vi.fn(async () => bytes)
  }
  try {
    await run({ service: createUpdateService(adapters), adapters, bytes })
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

describe('Update candidate confirmation and failure retention', () => {
  it('does no network work on construction, state inspection or preparation and refuses arbitrary URLs/pins', async () => {
    await fixture(async ({ service, adapters }) => {
      expect(adapters.download).not.toHaveBeenCalled()
      const state = await service.state()
      expect(state.appReleaseChannelConfigured).toBe(false)
      expect(state.discoversLatestVersions).toBe(false)
      expect(state.installationSupported).toBe(false)
      service.prepare({ target: 'core', proxyPort: 7890 })
      expect(adapters.download).not.toHaveBeenCalled()
      expect(() =>
        service.prepare({ target: 'core', proxyPort: 7890, url: 'https://foreign.test' })
      ).toThrow()
      expect(() => service.prepare({ target: 'app', proxyPort: 7890 })).toThrow()
    })
  })
  it('consumes cancelled download consent and stages only after a separate positive confirmation', async () => {
    await fixture(async ({ service, adapters }) => {
      const plan = service.prepare({ target: 'core', proxyPort: 7890 })
      expect((await service.execute({ evidenceId: plan.evidenceId })).status).toBe('cancelled')
      expect(adapters.download).not.toHaveBeenCalled()
      await expect(service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('重新准备')
      adapters.confirmDownload = async () => true
      const next = service.prepare({ target: 'core', proxyPort: 7891 })
      const result = await service.execute({ evidenceId: next.evidenceId })
      expect(result.status).toBe('staged')
      expect(result.candidate).toMatchObject({ installed: false, applied: false })
      expect(adapters.download).toHaveBeenCalledWith(
        expect.objectContaining({ version: 'fixture' }),
        7891,
        expect.any(AbortSignal)
      )
      expect((await service.state()).candidates).toHaveLength(1)
      expect((await service.remove({ id: result.candidate?.id })).status).toBe('cancelled')
      adapters.confirmRemove = async () => true
      expect((await service.remove({ id: result.candidate?.id })).status).toBe('removed')
    })
  })
  it('preserves previously staged candidates on a failed new download without retries or raw errors', async () => {
    await fixture(async ({ service, adapters }) => {
      adapters.confirmDownload = async () => true
      const first = service.prepare({ target: 'core', proxyPort: 7890 })
      const candidate = (await service.execute({ evidenceId: first.evidenceId })).candidate
      const failed = vi.fn(async () => {
        throw new Error('PRIVATE upstream error')
      })
      adapters.download = failed
      const next = service.prepare({ target: 'core', proxyPort: 7890 })
      await expect(service.execute({ evidenceId: next.evidenceId })).rejects.toThrow('既有候选')
      expect(failed).toHaveBeenCalledOnce()
      expect((await service.state()).candidates[0].id).toBe(candidate?.id)
    })
  })
  it('cancels only the in-flight request, waits for it to finish and never commits cancelled bytes', async () => {
    await fixture(async ({ service, adapters }) => {
      adapters.confirmDownload = async () => true
      adapters.download = (_pin, _port, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('abort')), { once: true })
        })
      const plan = service.prepare({ target: 'core', proxyPort: 7890 })
      const current = service.execute({ evidenceId: plan.evidenceId })
      await vi.waitFor(() => expect(service.isBusy()).toBe(true))
      service.cancel()
      expect((await current).status).toBe('cancelled')
      await service.whenIdle()
      expect((await service.state()).candidates).toEqual([])
    })
  })
})

describe('Update preparation expiry', () => {
  it('rechecks the preparation deadline after consent before making any network request', async () => {
    await fixture(async ({ adapters }) => {
      let now = 1
      const service = createUpdateService({
        ...adapters,
        now: () => now,
        confirmDownload: async () => {
          now = 60002
          return true
        }
      })
      const plan = service.prepare({ target: 'core', proxyPort: 7890 })
      await expect(service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('未完成')
      expect(adapters.download).not.toHaveBeenCalled()
    })
  })
})

describe('Update plan catalog binding', () => {
  it('rejects a changed trusted catalog after confirmation instead of downloading a newly substituted version', async () => {
    await fixture(async ({ service, adapters }) => {
      adapters.confirmDownload = async () => {
        adapters.store.catalog[0].version = 'changed'
        return true
      }
      const plan = service.prepare({ target: 'core', proxyPort: 7890 })
      await expect(service.execute({ evidenceId: plan.evidenceId })).rejects.toThrow('未完成')
      expect(adapters.download).not.toHaveBeenCalled()
    })
  })
})
