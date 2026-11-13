import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { trustedCoreVariants } from '../core/trusted-variants'
import { trustedSmartModels } from '../core/smart-models'
import { SMART_MODEL_CONTROLS } from '../profiles/groups'
import { resourceHash } from '../resources/source'
import { checkCompleteConfiguration } from './checker'
import type { CapturedCoreExecutionV2 } from './core-snapshot-prototype'

const hooks = vi.hoisted(() => ({ execute: vi.fn(), verify: vi.fn() }))
vi.mock('util', async (original) => ({
  ...(await original<typeof import('util')>()),
  promisify: () => hooks.execute
}))
vi.mock('../core/resources', () => ({ verifyCoreResource: hooks.verify }))
beforeEach(() => {
  hooks.execute.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
  hooks.verify.mockReset()
})
const source = (smart = true) =>
  JSON.stringify({
    'geo-auto-update': false,
    'geox-url': {},
    proxies: [],
    ...(smart ? SMART_MODEL_CONTROLS : {}),
    'proxy-groups': smart
      ? [
          {
            name: 'S',
            type: 'smart',
            proxies: ['REJECT'],
            uselightgbm: true,
            url: 'http://127.0.0.1:1/health'
          }
        ]
      : [],
    rules: ['MATCH,REJECT']
  })

const asnFixture = () => {
  const configuration = JSON.parse(source(false))
  configuration.rules = ['IP-ASN,64512,REJECT,no-resolve', 'MATCH,REJECT']
  const bytes = Buffer.from('ASN worker contract fixture')
  return {
    configuration: JSON.stringify(configuration),
    assets: [{ path: 'ASN.mmdb', bytes, sha256: resourceHash(bytes) }]
  }
}

describe('Captured complete parser without an ASN asset', () => {
  it.each([
    { failure: undefined, status: 'passed' },
    { failure: { code: 1 }, status: 'rejected' },
    { failure: { code: 'ENOENT' }, status: 'unavailable' }
  ])(
    'requires deny-network without an unsandboxed fallback ($status)',
    async ({ failure, status }) => {
      const pin = trustedCoreVariants().find(
        (pin) => pin.family === 'alpha' && pin.architecture === 'arm64'
      )
      if (!pin) throw new Error('Missing fixed Alpha core.')
      const configuration = source(false),
        execution: CapturedCoreExecutionV2 = {
          receipt: {
            version: 2,
            profile: 'alpha',
            architecture: pin.architecture,
            core: { version: pin.version, sha256: pin.sha256, size: pin.size },
            configurationSHA256: resourceHash(Buffer.from(configuration)),
            selectionSHA256: '1'.repeat(64),
            snapshotSHA256: '2'.repeat(64),
            expiresAt: Date.now() + 60000,
            assets: []
          },
          copyAssets: () => [],
          recheck: vi.fn(async () => undefined),
          parserRoot: async () => '/trusted'
        }
      hooks.verify.mockResolvedValue({ ...pin, executable: '/captured-alpha' })
      hooks.execute.mockImplementation(async (_file, _args, options) => {
        expect(await readFile(join(options.cwd, 'config.json'), 'utf8')).toBe(configuration)
        if (failure) throw Object.assign(new Error('PRIVATE-sandbox-output'), failure)
        return { stdout: '', stderr: '' }
      })
      const result = await checkCompleteConfiguration(
        '/trusted',
        configuration,
        [],
        undefined,
        execution
      )
      expect(result.status).toBe(status)
      expect(JSON.stringify(result)).not.toContain('PRIVATE')
      expect(hooks.execute).toHaveBeenCalledOnce()
      const [file, args, options] = hooks.execute.mock.calls[0]
      expect(file).toBe('/usr/bin/sandbox-exec')
      expect(args).toEqual([
        '-p',
        '(version 1) (allow default) (deny network*)',
        '/captured-alpha',
        '-t',
        '-d',
        options.cwd,
        '-f',
        join(options.cwd, 'config.json')
      ])
      await expect(lstat(options.cwd)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )
})

describe('Bound ASN semantic preflight before the complete parser', () => {
  it.each([undefined, 'local-geodata-v1'] as const)(
    'uses only the verified %s capability for both parser environments, never ambient privilege',
    async (capability) => {
      const fixture = asnFixture()
      hooks.verify.mockResolvedValue({
        ...trustedCoreVariants()[0],
        executable: '/fixed-core',
        ...(capability ? { capability } : {})
      })
      vi.stubEnv('RELAY_LOCAL_GEODATA_V1', 'UNTRUSTED')
      vi.stubEnv('HTTP_PROXY', 'PRIVATE_PROXY')
      vi.stubEnv('CLASH_CONFIG_STRING', 'PRIVATE_CONFIG')
      hooks.execute.mockImplementation(
        async (_file: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
          expect(options.env.RELAY_LOCAL_GEODATA_V1).toBe(capability ? '1' : undefined)
          expect(options.env.PATH).toBe('/usr/bin:/bin')
          expect(options.env.HTTP_PROXY).toBeUndefined()
          expect(options.env.CLASH_CONFIG_STRING).toBeUndefined()
          return { stdout: '', stderr: '' }
        }
      )
      try {
        expect(
          (await checkCompleteConfiguration('/trusted', fixture.configuration, fixture.assets))
            .status
        ).toBe('passed')
        expect(hooks.execute).toHaveBeenCalledTimes(2)
      } finally {
        vi.unstubAllEnvs()
      }
    }
  )
  it('checks ASN with the fixed parser under deny-network, then checks the exact unchanged candidate', async () => {
    const fixture = asnFixture(),
      signal = new AbortController().signal
    hooks.verify.mockResolvedValue({ ...trustedCoreVariants()[0], executable: '/fixed-core' })
    let directory = ''
    hooks.execute.mockImplementationOnce(async (file, args, options) => {
      directory = options.cwd
      expect(file).toBe('/usr/bin/sandbox-exec')
      expect(args.slice(0, 4)).toEqual([
        '-p',
        '(version 1) (allow default) (deny network*)',
        '/fixed-core',
        '-t'
      ])
      expect(args.slice(4, 7)).toEqual(['-d', directory, '-f'])
      expect(options).toMatchObject({ timeout: 10000, maxBuffer: 65536, signal })
      expect(options.env.HOME).toBe(directory)
      expect(options.env.TMPDIR).toBe(directory)
      const probe = JSON.parse(await readFile(args[7], 'utf8'))
      expect(probe.rules).toEqual(['IP-ASN,64512,REJECT,no-resolve', 'MATCH,REJECT'])
      expect(probe['proxy-groups']).toEqual([])
      expect(probe['geo-auto-update']).toBe(false)
      expect(Object.values(probe['geox-url'])).toEqual(['', '', '', ''])
      expect((await lstat(args[7])).mode & 0o7777).toBe(0o600)
      expect(await readFile(join(directory, 'ASN.mmdb'))).toEqual(fixture.assets[0].bytes)
      return { stdout: '', stderr: '' }
    })
    hooks.execute.mockImplementationOnce(async (file, args, options) => {
      expect(file).toBe('/usr/bin/sandbox-exec')
      expect(args.slice(0, 7)).toEqual([
        '-p',
        '(version 1) (allow default) (deny network*)',
        '/fixed-core',
        '-t',
        '-d',
        directory,
        '-f'
      ])
      expect(await readFile(args[7], 'utf8')).toBe(fixture.configuration)
      expect(options.signal).toBe(signal)
      return { stdout: '', stderr: '' }
    })
    const result = await checkCompleteConfiguration(
      '/trusted',
      fixture.configuration,
      fixture.assets,
      signal
    )
    expect(result.status).toBe('passed')
    expect(result.configurationSHA256).toBe(resourceHash(Buffer.from(fixture.configuration)))
    expect(hooks.execute).toHaveBeenCalledTimes(2)
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('keeps the ASN candidate sandbox failure terminal after a successful independent probe', async () => {
    const fixture = asnFixture()
    hooks.verify.mockResolvedValue({ ...trustedCoreVariants()[0], executable: '/fixed-core' })
    hooks.execute
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
      .mockRejectedValueOnce(Object.assign(new Error('PRIVATE-candidate-output'), { code: 1 }))
    const result = await checkCompleteConfiguration(
      '/trusted',
      fixture.configuration,
      fixture.assets
    )
    expect(result.status).toBe('rejected')
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    expect(hooks.execute).toHaveBeenCalledTimes(2)
    for (const call of hooks.execute.mock.calls) {
      expect(call[0]).toBe('/usr/bin/sandbox-exec')
      expect(call[1].slice(0, 3)).toEqual([
        '-p',
        '(version 1) (allow default) (deny network*)',
        '/fixed-core'
      ])
    }
  })
  it.each([
    { failure: { code: 1 }, status: 'rejected' },
    { failure: { code: 'ENOENT' }, status: 'unavailable' },
    { failure: { code: 1, signal: 'SIGKILL' }, status: 'unavailable' }
  ])(
    'does not run the candidate or fall back after ASN probe failure ($status)',
    async ({ failure, status }) => {
      const fixture = asnFixture()
      hooks.verify.mockResolvedValue({ ...trustedCoreVariants()[0], executable: '/fixed-core' })
      let directory = ''
      hooks.execute.mockImplementationOnce(async (_file, _args, options) => {
        directory = options.cwd
        throw Object.assign(new Error('PRIVATE-ASN-path-and-output'), failure)
      })
      const result = await checkCompleteConfiguration(
        '/trusted',
        fixture.configuration,
        fixture.assets
      )
      expect(result.status).toBe(status)
      expect(JSON.stringify(result)).not.toContain('PRIVATE')
      expect(hooks.execute).toHaveBeenCalledOnce()
      await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )
  it.each(['reject', 'resolve'])(
    'keeps cancellation through the ASN probe when its process promise will %s',
    async (outcome) => {
      const fixture = asnFixture(),
        controller = new AbortController()
      hooks.verify.mockResolvedValue({ ...trustedCoreVariants()[0], executable: '/fixed-core' })
      let directory = ''
      hooks.execute.mockImplementationOnce(async (_file, _args, options) => {
        directory = options.cwd
        expect(options.signal).toBe(controller.signal)
        controller.abort()
        if (outcome === 'reject') throw new Error('aborted')
        return { stdout: '', stderr: '' }
      })
      expect(
        (
          await checkCompleteConfiguration(
            '/trusted',
            fixture.configuration,
            fixture.assets,
            controller.signal
          )
        ).status
      ).toBe('cancelled')
      expect(hooks.execute).toHaveBeenCalledOnce()
      await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    }
  )
  it('rechecks the ASN digest after the probe and does not check a candidate backed by changed bytes', async () => {
    const fixture = asnFixture()
    hooks.verify.mockResolvedValue({ ...trustedCoreVariants()[0], executable: '/fixed-core' })
    hooks.execute.mockImplementationOnce(async (_file, _args, options) => {
      await writeFile(join(options.cwd, 'ASN.mmdb'), 'changed after ASN validation')
      return { stdout: '', stderr: '' }
    })
    expect(
      (await checkCompleteConfiguration('/trusted', fixture.configuration, fixture.assets)).status
    ).toBe('unavailable')
    expect(hooks.execute).toHaveBeenCalledOnce()
  })
})
describe('Complete parser model staging, with no actual process execution', () => {
  it('refuses Smart on Stable and does not run an unprepared Smart parser', async () => {
    for (const family of ['stable', 'smart']) {
      const pin = trustedCoreVariants().find(
        (pin) => pin.family === family && pin.architecture === 'arm64'
      )
      if (!pin) throw new Error('Missing fixed core.')
      hooks.verify.mockResolvedValue({ ...pin, executable: '/not-executed' })
      expect((await checkCompleteConfiguration('/missing-model', source(), [])).status).toBe(
        'unavailable'
      )
      expect(hooks.execute).not.toHaveBeenCalled()
    }
  })
  it('refuses a changed trusted model before running the complete parser', async () => {
    const root = await realpath(await mkdtemp('/private/tmp/relay-complete-model-'))
    try {
      const pin = trustedCoreVariants().find(
        (pin) => pin.family === 'smart' && pin.architecture === 'arm64'
      )
      if (!pin) throw new Error('Missing fixed core.')
      hooks.verify.mockResolvedValue({ ...pin, executable: '/not-executed' })
      await writeFile(
        join(root, 'relay-model.json'),
        JSON.stringify({ kind: 'smart', ...trustedSmartModels()[0] }),
        { mode: 0o600 }
      )
      await writeFile(join(root, 'Model.bin'), 'tampered', { mode: 0o600 })
      expect((await checkCompleteConfiguration(root, source(), [])).status).toBe('unavailable')
      expect(hooks.execute).not.toHaveBeenCalled()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('preserves the Stable complete parser path without reading Smart model files', async () => {
    const pin = trustedCoreVariants()[0]
    hooks.verify.mockResolvedValue({ ...pin, executable: '/simulated-stable' })
    expect((await checkCompleteConfiguration('/not-read', source(false), [])).status).toBe('passed')
    expect(hooks.execute).toHaveBeenCalledOnce()
    expect(hooks.execute.mock.calls[0][0]).toBe('/simulated-stable')
    expect(hooks.execute.mock.calls[0][1][0]).toBe('-t')
  })
})
