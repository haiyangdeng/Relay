import { mkdtemp, realpath, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { createCompleteConfigurationService } from '../configuration/service'
import { collectRuntimeDependencies } from '../configuration/dependencies'
import { ProfileStore } from '../profiles/store'
import { ResourceStore } from '../resources/store'
import { resourceHash } from '../resources/source'
import {
  createCheckedTunCandidateReader,
  type TunCheckedNativeObservation
} from './checked-candidate'
import { prepareTunDescriptorRuntime } from './runtime'

async function prepareFixture(home: string) {
  const context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') },
    profiles = new ProfileStore(context),
    providers = new ProfileStore(context, 'ProviderResources'),
    resources = new ResourceStore(context),
    bytes = Buffer.from('payload:\n  - DOMAIN,example.com\n'),
    resource = await resources.save(
      { name: 'Local rules', kind: 'rule-yaml', behavior: 'classical', selector: '' },
      bytes
    ),
    source = JSON.stringify({
      port: 18290,
      mode: 'rule',
      'allow-lan': false,
      tun: {
        enable: true,
        device: 'utun',
        stack: 'gvisor',
        'auto-route': true,
        'auto-detect-interface': true,
        'dns-hijack': ['any:53'],
        mtu: 1500
      },
      dns: { enable: true, nameserver: ['https://cloudflare-dns.com/dns-query'] },
      proxies: [{ name: 'N', type: 'direct' }],
      'rule-providers': {
        local: {
          type: 'file',
          path: '/PRIVATE/original-not-read',
          behavior: 'classical',
          format: 'yaml'
        }
      },
      rules: ['RULE-SET,local,REJECT', 'MATCH,REJECT']
    }),
    profile = await profiles.save('Private TUN source', source),
    dependency = collectRuntimeDependencies(source).dependencies[0],
    complete = createCompleteConfigurationService({
      profiles,
      providers,
      resources,
      script: vi.fn(),
      check: async (configuration) => ({
        status: 'passed',
        scope: 'complete-parser',
        configurationSHA256: resourceHash(Buffer.from(configuration)),
        coreVersion: 'v1.19.33',
        active: false,
        runtimeAccepted: false,
        warnings: []
      }),
      now: () => 1000
    }),
    plan = await complete.prepare({
      profile: { id: profile.id, sha256: profile.sha256 },
      options: { globalOverrides: [], profileOverrides: [], controlled: {} },
      bindings: [
        { dependencyId: dependency.id, selection: { id: resource.id, sha256: resource.sha256 } }
      ]
    })
  expect(plan.readyForParserCheck).toBe(true)
  expect((await complete.check({ evidenceId: plan.evidenceId })).status).toBe('passed')
  const request = {
      configurationSHA256: plan.configurationSHA256,
      bundleSHA256: plan.bundleSHA256
    },
    native: TunCheckedNativeObservation = {
      helper: {
        version: 1,
        source: 'native',
        observedAt: 1000,
        revision: 'a'.repeat(64),
        state: 'ready',
        identity: 'authenticated',
        authorization: 'approved',
        rootOwned: true,
        runningAsRoot: true,
        clientUID: 501,
        helperSHA256: 'b'.repeat(64),
        coreSHA256: 'c'.repeat(64)
      },
      network: {
        version: 1,
        source: 'native',
        observedAt: 1000,
        state: 'observed',
        revision: 'd'.repeat(64),
        routesSHA256: 'e'.repeat(64),
        dnsSHA256: 'f'.repeat(64),
        interfacesSHA256: '1'.repeat(64),
        proxySHA256: '2'.repeat(64),
        protectionSHA256: '3'.repeat(64),
        existingTunnel: 'none',
        recovery: 'available'
      }
    },
    adapters = {
      resolveEvidenceId: vi.fn((selected: typeof request) =>
        selected.configurationSHA256 === request.configurationSHA256 &&
        selected.bundleSHA256 === request.bundleSHA256
          ? plan.evidenceId
          : undefined
      ),
      takeChecked: vi.fn(complete.takeChecked),
      observeNative: vi.fn(async () => structuredClone(native)),
      recheckNative: vi.fn(async (expected: TunCheckedNativeObservation) => {
        if (
          expected.helper.revision !== native.helper.revision ||
          expected.network.revision !== native.network.revision
        )
          throw new Error('native baseline changed')
      }),
      expectedHelperSHA256: 'b'.repeat(64),
      expectedCoreSHA256: 'c'.repeat(64),
      currentUID: 501,
      now: () => 1000
    }
  return {
    adapters,
    read: createCheckedTunCandidateReader(adapters),
    complete,
    request,
    native,
    plan,
    bytes,
    resourcePath: join(resources.directory, resource.id, 'resource.bin')
  }
}

async function fixture(
  run: (context: Awaited<ReturnType<typeof prepareFixture>>) => Promise<void>
) {
  const home = await realpath(await mkdtemp('/private/tmp/relay-tun-checked-candidate-'))
  try {
    await run(await prepareFixture(home))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

describe('TUN private checked candidate handoff', () => {
  it('consumes the real complete-check snapshot and retains bound local rule-provider bytes and pins', async () => {
    await fixture(async (f) => {
      const candidate = await f.read(f.request),
        runtime = prepareTunDescriptorRuntime(f.request, candidate.evidence, 1000)
      expect(f.adapters.takeChecked).toHaveBeenCalledWith({ evidenceId: f.plan.evidenceId })
      expect(candidate.evidence.assets).toHaveLength(1)
      expect(Buffer.isBuffer(candidate.evidence.assets[0].bytes)).toBe(true)
      expect(candidate.evidence.assets[0].bytes.equals(f.bytes)).toBe(true)
      expect(candidate.evidence.pins[0].namespace).toBe('resource')
      expect(runtime.preparation.readyForConfirmation).toBe(true)
      expect(runtime.configuration).toContain(candidate.evidence.assets[0].path)
      await candidate.recheck()
      expect(f.adapters.recheckNative).toHaveBeenCalledOnce()
      await expect(f.read(f.request)).rejects.toThrow('先完成')
    })
  })

  it('rejects a digest with no trusted complete-check mapping before consuming or observing anything', async () => {
    await fixture(async (f) => {
      await expect(f.read({ ...f.request, bundleSHA256: '0'.repeat(64) })).rejects.toThrow(
        '先重新检查'
      )
      expect(f.adapters.takeChecked).not.toHaveBeenCalled()
      expect(f.adapters.observeNative).not.toHaveBeenCalled()
    })
  })

  it('independently rejects a wrong mapping even if the trusted lookup returns an existing check ID', async () => {
    await fixture(async (f) => {
      f.adapters.resolveEvidenceId.mockReturnValue(f.plan.evidenceId)
      await expect(f.read({ ...f.request, bundleSHA256: '0'.repeat(64) })).rejects.toThrow(
        '摘要不一致'
      )
      expect(f.adapters.observeNative).not.toHaveBeenCalled()
    })
  })

  it('rejects source-resource changes through the original complete snapshot recheck', async () => {
    await fixture(async (f) => {
      const candidate = await f.read(f.request)
      await writeFile(f.resourcePath, Buffer.alloc(f.bytes.length))
      await expect(candidate.recheck()).rejects.toThrow()
      expect(f.adapters.recheckNative).not.toHaveBeenCalled()
    })
  })

  it('rejects mutations to its private copied asset and revocation of the checked source', async () => {
    await fixture(async (f) => {
      const candidate = await f.read(f.request)
      candidate.evidence.assets[0].bytes[0] = 0
      await expect(candidate.recheck()).rejects.toThrow('已变化')
      expect(f.adapters.recheckNative).not.toHaveBeenCalled()
    })
    await fixture(async (f) => {
      const candidate = await f.read(f.request)
      f.complete.clear()
      await expect(candidate.recheck()).rejects.toThrow('失效')
    })
  })

  it('rechecks native identity and baseline without replacing the original observed timestamps', async () => {
    await fixture(async (f) => {
      const candidate = await f.read(f.request)
      f.native.network.observedAt = 1100
      await candidate.recheck()
      expect(candidate.evidence.network.observedAt).toBe(1000)
      expect(f.adapters.recheckNative).toHaveBeenCalledWith(
        expect.objectContaining({ network: expect.objectContaining({ observedAt: 1000 }) })
      )
      f.native.network.revision = '5'.repeat(64)
      await expect(candidate.recheck()).rejects.toThrow('baseline changed')
    })
  })

  it('preserves unavailable native helper evidence without granting start readiness', async () => {
    await fixture(async (f) => {
      f.native.helper.state = 'missing'
      const candidate = await f.read(f.request),
        runtime = prepareTunDescriptorRuntime(f.request, candidate.evidence, 1000)
      expect(runtime.preparation.readyForConfirmation).toBe(false)
      expect(runtime.preparation.issues).toContain('helperNotReady')
      await expect(candidate.recheck()).rejects.toThrow('已变化')
      expect(f.adapters.recheckNative).not.toHaveBeenCalled()
    })
  })
})
