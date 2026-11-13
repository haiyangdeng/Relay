import { chmod, lstat, readFile, rm } from 'fs/promises'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { profileRuntimeSource } from '../__fixtures__/profile-runtime'
import { checkProfileRuntime } from './profile-check'

type Options = {
  cwd: string
  env: NodeJS.ProcessEnv
  timeout: number
  killSignal: string
  maxBuffer: number
}
const hooks = vi.hoisted(() => ({ execute: vi.fn(), verify: vi.fn(), directories: [] as string[] }))
vi.mock('util', async (original) => ({
  ...(await original<typeof import('util')>()),
  promisify: () => async (file: string, args: string[], options: Options) => {
    hooks.directories.push(options.cwd)
    return hooks.execute(file, args, options)
  }
}))
vi.mock('./resources', () => ({ verifyCoreResource: hooks.verify }))
beforeEach(() => {
  hooks.execute.mockReset().mockResolvedValue({ stdout: '', stderr: '' })
  hooks.verify.mockReset().mockResolvedValue({
    executable: '/fixture/pinned-core',
    version: 'v1.19.33',
    architecture: 'arm64',
    sha256: 'a'.repeat(64)
  })
  hooks.directories = []
})
afterEach(async () => {
  for (const directory of hooks.directories) {
    try {
      await chmod(directory, 0o700)
      await rm(directory, { recursive: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
})
describe('Bounded own-core configuration test with simulated execution only', () => {
  it('refuses Smart groups on the Stable core before executing a parser', async () => {
    const source = JSON.stringify({
      proxies: [],
      'proxy-groups': [
        {
          name: 'Smart',
          type: 'smart',
          proxies: ['REJECT'],
          url: 'http://127.0.0.1:1/probe',
          uselightgbm: true
        }
      ],
      rules: ['MATCH,Smart']
    })
    expect((await checkProfileRuntime('/fixture/resources', source)).status).toBe('unavailable')
    expect(hooks.execute).not.toHaveBeenCalled()
  })
  it('uses only fixed -t args/private files, isolated environment and waits for cleanup', async () => {
    hooks.execute.mockImplementation(async (file: string, args: string[], options: Options) => {
      expect(file).toBe('/fixture/pinned-core')
      expect(args).toEqual(['-t', '-d', options.cwd, '-f', join(options.cwd, 'config.json')])
      expect(options).toMatchObject({
        timeout: 8000,
        killSignal: 'SIGKILL',
        maxBuffer: 65536,
        env: { HOME: options.cwd, TMPDIR: options.cwd, PATH: '/usr/bin:/bin' }
      })
      expect(
        Object.keys(options.env).some(
          (key) => key.startsWith('CLASH_') || key.endsWith('_PROXY') || key.endsWith('_TOKEN')
        )
      ).toBe(false)
      expect((await lstat(options.cwd)).mode & 0o7777).toBe(0o700)
      const config = join(options.cwd, 'config.json')
      expect((await lstat(config)).mode & 0o7777).toBe(0o600)
      expect(JSON.parse(await readFile(config, 'utf8'))).toMatchObject({
        'mixed-port': 0,
        dns: { enable: false },
        tun: { enable: false }
      })
      return { stdout: 'PRIVATE raw core output', stderr: '' }
    })
    const result = await checkProfileRuntime('/fixture/resources', profileRuntimeSource)
    expect(result.status).toBe('passed')
    expect(JSON.stringify(result)).not.toContain('PRIVATE')
    await expect(lstat(hooks.directories[0])).rejects.toMatchObject({ code: 'ENOENT' })
    expect(hooks.verify).toHaveBeenCalledTimes(2)
  })
  it('blocks unsupported profiles before resources or execution and refuses changed fixed resources', async () => {
    await expect(
      checkProfileRuntime('/fixture/resources', 'proxies: [{name: W, type: unknown-protocol}]')
    ).rejects.toThrow('范围')
    expect(hooks.verify).not.toHaveBeenCalled()
    await expect(
      checkProfileRuntime(
        '/fixture/resources',
        'proxies: [{name: S, type: ssh, PRIVATE_KEY: /PRIVATE/never-read}]'
      )
    ).rejects.toThrow('范围')
    expect(hooks.verify).not.toHaveBeenCalled()
    hooks.verify
      .mockResolvedValueOnce({ executable: '/fixture/core', version: 'v1.19.33' })
      .mockRejectedValueOnce(new Error('PRIVATE changed resource'))
    expect((await checkProfileRuntime('/fixture/resources', profileRuntimeSource)).status).toBe(
      'unavailable'
    )
    expect(hooks.execute).not.toHaveBeenCalled()
  })
  it('separates semantic rejection from timeout/unavailable without returning raw core logs', async () => {
    hooks.execute.mockRejectedValueOnce(
      Object.assign(new Error('PRIVATE credential'), { code: 1, stderr: 'PRIVATE' })
    )
    const rejected = await checkProfileRuntime('/fixture/resources', profileRuntimeSource)
    expect(rejected.status).toBe('rejected')
    expect(JSON.stringify(rejected)).not.toContain('PRIVATE')
    hooks.execute.mockRejectedValueOnce(
      Object.assign(new Error('PRIVATE timeout'), { code: 'ETIMEDOUT', signal: 'SIGKILL' })
    )
    expect((await checkProfileRuntime('/fixture/resources', profileRuntimeSource)).status).toBe(
      'unavailable'
    )
  })
  it('does not claim success or remove a directory whose identity/permissions changed', async () => {
    hooks.execute.mockImplementation(async (_file: string, _args: string[], options: Options) => {
      await chmod(options.cwd, 0o755)
      return { stdout: '', stderr: '' }
    })
    expect((await checkProfileRuntime('/fixture/resources', profileRuntimeSource)).status).toBe(
      'uncertain'
    )
    expect((await lstat(hooks.directories[0])).isDirectory()).toBe(true)
  })
})
