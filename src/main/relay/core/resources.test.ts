import { createHash } from 'crypto'
import { EventEmitter } from 'events'
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import { verifyCoreExecutable, verifyCoreResource } from './resources'
import { coreEnvironment, isolatedCoreConfiguration } from './isolated-runtime'
import geodataManifest from './geodata-manifest.json'

async function fixture(
  test: (file: string, pin: { sha256: string; size: number; cpuType: number }) => Promise<void>
): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'relay-core-resource-')))
  try {
    const data = Buffer.alloc(1024 * 1024 + 17)
    data.writeUInt32LE(0xfeedfacf, 0)
    data.writeUInt32LE(0x100000c, 4)
    const file = join(root, 'inert-macho-fixture')
    await writeFile(file, data, { mode: 0o755 })
    await test(file, {
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex'),
      cpuType: 0x100000c
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
describe('Pinned independent core resources and inert runtime constraints', () => {
  it('verifies bytes and architecture, refusing tampering and truncated files without executing them', async () => {
    await fixture(async (file, pin) => {
      await expect(verifyCoreExecutable(file, pin)).resolves.toBeUndefined()
      await expect(verifyCoreExecutable(file, { ...pin, cpuType: 0x1000007 })).rejects.toThrow(
        '架构'
      )
      const changed = await readFile(file)
      changed[changed.length - 1] = 1
      await writeFile(file, changed)
      await expect(verifyCoreExecutable(file, pin)).rejects.toThrow('摘要')
      await writeFile(file, changed.subarray(0, 100))
      await expect(verifyCoreExecutable(file, pin)).rejects.toThrow('类型')
    })
  })
  it('refuses mutable, linked and unsupported resources instead of selecting another program', async () => {
    await fixture(async (file, pin) => {
      await chmod(file, 0o775)
      await expect(verifyCoreExecutable(file, pin)).rejects.toThrow('权限')
      await chmod(file, 0o755)
      await symlink(file, file + '-symlink')
      await expect(verifyCoreExecutable(file + '-symlink', pin)).rejects.toThrow()
      await link(file, file + '-hardlink')
      await expect(verifyCoreExecutable(file, pin)).rejects.toThrow('权限')
    })
    await expect(verifyCoreResource('/unavailable', 'arm64', 'linux')).rejects.toThrow('macOS')
    await expect(verifyCoreResource('/unavailable', 'riscv64', 'darwin')).rejects.toThrow('macOS')
    await expect(verifyCoreResource('/unavailable', 'arm64', 'darwin')).rejects.toThrow(
      '未尝试其他程序'
    )
  })
  it('does not inherit executable hooks, inline config, controller overrides, proxies or unrelated credentials', () => {
    const env = coreEnvironment({
      HOME: '/fixture',
      USER: 'fixture',
      LANG: 'en_US.UTF-8',
      PATH: '/untrusted/tools',
      CLASH_CONFIG_STRING: 'PRIVATE inline configuration',
      CLASH_POST_UP: 'PRIVATE command',
      CLASH_POST_DOWN: 'PRIVATE command',
      CLASH_OVERRIDE_EXTERNAL_CONTROLLER: '0.0.0.0:9090',
      SAFE_PATHS: '/',
      HTTP_PROXY: 'PRIVATE proxy',
      RELAY_LOCAL_GEODATA_V1: '1',
      SOME_TOKEN: 'PRIVATE token'
    })
    expect(env).toEqual({
      HOME: '/fixture',
      USER: 'fixture',
      LANG: 'en_US.UTF-8',
      PATH: '/usr/bin:/bin'
    })
    const a = isolatedCoreConfiguration(),
      b = isolatedCoreConfiguration()
    expect(a).toMatchObject({
      port: 0,
      'mixed-port': 0,
      'socks-port': 0,
      'external-controller': '',
      dns: { enable: false },
      tun: { enable: false },
      ntp: { enable: false },
      rules: ['MATCH,REJECT'],
      'proxy-providers': {},
      'rule-providers': {},
      listeners: []
    })
    expect(a).not.toBe(b)
    expect(a.dns).not.toBe(b.dns)
  })
  it('enables only the compiled Thin Core pin in its fixed namespace; sidecars cannot grant it', async () => {
    await fixture(async (file, pin) => {
      const root = join(file, '..', 'relay', 'core-geodata-v1'),
        wrongParent = join(file, '..', 'other', 'core-geodata-v1'),
        officialRoot = join(file, '..', 'relay', 'core')
      for (const directory of [root, wrongParent, officialRoot]) {
        await mkdir(join(directory, 'darwin-arm64'), { recursive: true, mode: 0o700 })
        await copyFile(file, join(directory, 'darwin-arm64/mihomo'))
        await chmod(join(directory, 'darwin-arm64/mihomo'), 0o755)
      }
      vi.resetModules()
      vi.doMock('./geodata-manifest.json', () => ({
        default: {
          ...geodataManifest,
          assets: { ...geodataManifest.assets, arm64: { ...pin, path: 'darwin-arm64/mihomo' } }
        }
      }))
      try {
        const verified = (await import('./resources')).verifyCoreResource
        await expect(verified(root, 'arm64', 'darwin')).resolves.toMatchObject({
          version: 'relay-geodata-v1p1-3f27',
          capability: 'local-geodata-v1',
          sha256: pin.sha256
        })
        await expect(verified(wrongParent, 'arm64', 'darwin')).rejects.toThrow()
        await writeFile(join(officialRoot, 'relay-core.json'), JSON.stringify(geodataManifest))
        await expect(verified(officialRoot, 'arm64', 'darwin')).rejects.toThrow()
        await rm(join(root, 'darwin-arm64/mihomo'))
        await writeFile(join(root, 'relay-core.json'), JSON.stringify(geodataManifest))
        await expect(verified(root, 'arm64', 'darwin')).rejects.toThrow('未尝试其他程序')
      } finally {
        vi.doUnmock('./geodata-manifest.json')
        vi.resetModules()
      }
    })
  })
  it('verifies both actual signed Thin Core resources and the unchanged official resources without executing them', async () => {
    const root = join(process.cwd(), 'extra/relay')
    for (const architecture of ['arm64', 'x64'] as const) {
      await expect(
        verifyCoreResource(join(root, 'core-geodata-v1'), architecture, 'darwin')
      ).resolves.toMatchObject({
        capability: 'local-geodata-v1',
        sha256: geodataManifest.assets[architecture].sha256
      })
      const official = await verifyCoreResource(join(root, 'core'), architecture, 'darwin')
      expect(official).not.toHaveProperty('capability')
      expect(official.version).toBe('v1.19.33')
    }
  })
  it.each([undefined, 'local-geodata-v1'] as const)(
    'uses verified capability %s for parser and spawn env while retaining the environment whitelist',
    async (capability) => {
      const environments: NodeJS.ProcessEnv[] = [],
        child = Object.assign(new EventEmitter(), {
          pid: 1234,
          stdout: new EventEmitter(),
          stderr: new EventEmitter()
        }),
        version = capability ? 'relay-geodata-v1p1-3f27' : 'v1.19.33'
      vi.resetModules()
      vi.doMock('./resources', () => ({
        verifyCoreResource: vi.fn(async () => ({
          executable: '/fixture/never-executed',
          architecture: 'arm64',
          version,
          sha256: 'a'.repeat(64),
          ...(capability ? { capability } : {})
        }))
      }))
      vi.doMock('child_process', () => ({
        execFile: vi.fn(
          (
            _file: string,
            _args: string[],
            options: { env: NodeJS.ProcessEnv },
            callback: (error: Error | null, stdout: string, stderr: string) => void
          ) => {
            environments.push(options.env)
            callback(null, '', '')
          }
        ),
        spawn: vi.fn((_file: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
          environments.push(options.env)
          return child
        })
      }))
      vi.doMock('fs/promises', async () => {
        const original = await vi.importActual<typeof import('fs/promises')>('fs/promises')
        return {
          ...original,
          lstat: (path: Parameters<typeof original.lstat>[0]) =>
            String(path).endsWith('/api.sock')
              ? Promise.resolve({
                  dev: 1,
                  ino: 2,
                  uid: process.getuid?.(),
                  isSocket: () => true,
                  isSymbolicLink: () => false
                })
              : original.lstat(path)
        }
      })
      vi.doMock('./shutdown', () => ({
        stopOwnedChild: vi.fn(async () => {
          child.emit('close', 0)
        })
      }))
      vi.doMock('http', () => ({
        request: vi.fn(
          (
            _options: object,
            callback: (response: EventEmitter & { statusCode: number }) => void
          ) => {
            const req = Object.assign(new EventEmitter(), {
              setTimeout: () => req,
              end: () => {
                queueMicrotask(() => {
                  const response = Object.assign(new EventEmitter(), { statusCode: 200 })
                  callback(response)
                  response.emit('data', Buffer.from(JSON.stringify({ version })))
                  response.emit('end')
                  req.emit('close')
                })
              }
            })
            return req
          }
        )
      }))
      const previous = process.env.RELAY_LOCAL_GEODATA_V1
      process.env.RELAY_LOCAL_GEODATA_V1 = 'UNTRUSTED'
      let core:
        Awaited<ReturnType<(typeof import('./owned-runtime'))['startOwnedCore']>> | undefined
      try {
        const { startOwnedCore } = await import('./owned-runtime')
        core = await startOwnedCore(
          '/fixture/not-used',
          JSON.stringify(isolatedCoreConfiguration()),
          'inert'
        )
        expect(environments).toHaveLength(2)
        for (const env of environments) {
          expect(env.RELAY_LOCAL_GEODATA_V1).toBe(capability ? '1' : undefined)
          expect(env.PATH).toBe('/usr/bin:/bin')
          expect(env.HTTP_PROXY).toBeUndefined()
          expect(env.CLASH_CONFIG_STRING).toBeUndefined()
        }
      } finally {
        try {
          await core?.stop()
        } finally {
          if (previous === undefined) delete process.env.RELAY_LOCAL_GEODATA_V1
          else process.env.RELAY_LOCAL_GEODATA_V1 = previous
          for (const name of ['./resources', 'child_process', 'fs/promises', './shutdown', 'http'])
            vi.doUnmock(name)
          vi.resetModules()
        }
      }
    }
  )
})
