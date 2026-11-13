import { createHash } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { compiledExecutionCoreV2 } from './execution-installation'
import { readTunInstallation, inspectTunNative } from './transport'

const f = vi.hoisted(() => ({
  manifest: Buffer.alloc(0),
  client: Buffer.from('fixed-private-fixture-client'),
  mode: 0o100755,
  uid: 0,
  size: 28,
  alias: false,
  stdout: '',
  flags: [] as unknown[]
}))
vi.mock('../../utils/dirs', () => ({ logPath: () => '/private/tmp/unused.log' }))
vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>()
  return {
    ...actual,
    lstat: vi.fn(async (path: string) => ({
      uid: f.uid,
      nlink: 1,
      mode: path.endsWith('RelayTunClient') ? f.mode : 0o100644,
      size: path.endsWith('RelayTunClient') ? f.size : f.manifest.length,
      isFile: () => true,
      isDirectory: () => true,
      isSymbolicLink: () => false
    })),
    realpath: vi.fn(async (path: string) => (f.alias ? path + '-alias' : path))
  }
})
vi.mock('../resources/source', async (original) => {
  const actual = await original<typeof import('../resources/source')>()
  return {
    ...actual,
    readBinaryResource: vi.fn(async (path: string) =>
      path.endsWith('installation.json') ? f.manifest : f.client
    )
  }
})
vi.mock('./execution-client.json', () => ({
  default: {
    version: 1,
    capability: 'execution-v2',
    clientSHA256: '71952ed3778b4e5be68edfa41a64d7a577ad0488141deeeac0dd274e3abb4a26'
  }
}))
vi.mock('child_process', async (original) => {
  const actual = await original<typeof import('child_process')>()
  return {
    ...actual,
    execFile: vi.fn((_path, flags, _options, callback) => {
      f.flags = flags
      callback(null, f.stdout, '')
    })
  }
})
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
function manifest(profile: 'stable' | 'alpha' | 'smart' | 'local-geodata-v1' = 'smart') {
  const core = (arch: 'arm64' | 'x64') => {
    const p = compiledExecutionCoreV2(profile, arch)
    return { sha256: p.sha256, size: p.size }
  }
  return {
    version: 2,
    role: 'core-managed-v2',
    clientUID: process.getuid?.() ?? 501,
    client: {
      sha256: hash(f.client),
      size: f.client.length,
      cdhashes: { arm64: 'a'.repeat(40), x86_64: 'b'.repeat(40) }
    },
    coreProfile: profile,
    cores: { arm64: core('arm64'), x86_64: core('x64') },
    uninstallerSHA256: 'd'.repeat(64)
  }
}
const store = (raw: unknown) => {
  f.manifest = Buffer.from(JSON.stringify(raw))
}
beforeEach(() => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
  vi.spyOn(process, 'arch', 'get').mockReturnValue('arm64')
  f.mode = 0o100755
  f.uid = 0
  f.size = f.client.length
  f.alias = false
  f.flags = []
  store(manifest())
})
afterEach(() => vi.restoreAllMocks())
describe('Main fixed installation v2 read admission', () => {
  it.each(['stable', 'alpha', 'smart', 'local-geodata-v1'] as const)(
    'reads the trusted %s tuple',
    async (profile) => {
      store(manifest(profile))
      const installed = await readTunInstallation('core-managed')
      expect(installed).toEqual({
        execution: 'core-managed',
        executionCore: compiledExecutionCoreV2(profile, 'arm64'),
        revision: hash(f.manifest),
        helperSHA256: hash(f.client),
        clientSHA256: hash(f.client),
        coreSHA256: compiledExecutionCoreV2(profile, 'arm64').sha256
      })
    }
  )
  it.each([
    () => {
      f.mode = 0o100775
    },
    () => {
      f.uid = process.getuid?.() ?? 501
    },
    () => {
      f.size++
    },
    () => {
      f.alias = true
    },
    () => {
      store({ ...manifest(), role: 'core-managed-v1' })
    },
    () => {
      const m = manifest()
      store({ ...m, client: { ...m.client, sha256: '0'.repeat(64) } })
    },
    () => {
      const m = manifest()
      store({ ...m, cores: { ...m.cores, x86_64: { ...m.cores.x86_64, size: 1 } } })
    }
  ])('refuses changed file or role facts before execution', async (mutate) => {
    mutate()
    await expect(readTunInstallation('core-managed')).rejects.toThrow()
    expect(f.flags).toHaveLength(0)
  })
  it('does not reinterpret a v2 installation as the network executor', async () => {
    await expect(readTunInstallation()).rejects.toThrow()
  })
  it('refuses duplicate manifest keys even with a valid last value', async () => {
    f.manifest = Buffer.from(
      f.manifest.toString().replace('"version":2', '"version":1,"version":2')
    )
    await expect(readTunInstallation('core-managed')).rejects.toThrow()
  })
  it('uses only the new fixed inspect flag after fresh admission', async () => {
    const installed = await readTunInstallation('core-managed')
    if (!installed) throw new Error('missing test installation')
    f.stdout = '{}'
    await expect(inspectTunNative(installed)).rejects.toThrow()
    expect(f.flags).toEqual(['--managed-inspect-execution-v2'])
  })
})
