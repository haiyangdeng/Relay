import { zstdCompressSync } from 'zlib'
import { lstat, readFile, writeFile, rename, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { RelayCoreResource } from '../core/resources'
import { convertRuleMRS, type MRSExecutor } from './mrs-convert'
import type { ResourceValidationJob } from './check-definition'
import { resourceHash } from './source'

function fixture() {
  const decoded = Buffer.alloc(21 + 1 + 8 + 32)
  decoded.set([77, 82, 83, 1, 1])
  decoded.writeBigInt64BE(1n, 5)
  decoded[21] = 1
  decoded.writeBigInt64BE(1n, 22)
  const bytes = zstdCompressSync(decoded)
  const job: ResourceValidationJob = {
    descriptor: { name: 'Private cached MRS', kind: 'rule-mrs', behavior: 'ipcidr', selector: '' },
    bytes,
    sha256: resourceHash(bytes)
  }
  const core: RelayCoreResource = {
    executable: '/fixture/fixed-core',
    version: 'v1.19.33',
    architecture: 'arm64',
    sha256: 'a'.repeat(64)
  }
  const verify = vi.fn(async () => ({ ...core }))
  const execute = vi.fn<MRSExecutor>(async () => ({
    stdout: Buffer.from('127.0.0.0/8\n'),
    stderr: Buffer.alloc(0)
  }))
  return { job, core, adapters: { verify, execute, platform: 'darwin' as const } }
}
describe('Bounded fixed-core MRS conversion worker', () => {
  it('does not launch a private converter after its scope expires during Core verification', async () => {
    const f = fixture(),
      gate = Promise.withResolvers<RelayCoreResource>()
    let active = true
    f.adapters.verify.mockImplementationOnce(() => gate.promise)
    const pending = convertRuleMRS('/fixed', f.job, {
        ...f.adapters,
        assertCurrent: () => {
          if (!active) throw new Error('closed')
        }
      }),
      rejected = expect(pending).rejects.toThrow('MRS转换未确认')
    await vi.waitFor(() => expect(f.adapters.verify).toHaveBeenCalledOnce())
    active = false
    gate.resolve(f.core)
    await rejected
    expect(f.adapters.execute).not.toHaveBeenCalled()
  })
  it('drains an admitted converter and cleans its own directory after the view scope is revoked', async () => {
    const f = fixture()
    let active = true,
      directory = ''
    f.adapters.execute.mockImplementationOnce(async (_file, _args, options) => {
      directory = options.cwd
      active = false
      return { stdout: Buffer.from('127.0.0.0/8\n'), stderr: Buffer.alloc(0) }
    })
    await expect(
      convertRuleMRS('/fixed', f.job, {
        ...f.adapters,
        assertCurrent: () => {
          if (!active) throw new Error('closed')
        }
      })
    ).rejects.toThrow('MRS转换未确认')
    expect(f.adapters.execute).toHaveBeenCalledOnce()
    expect(directory).not.toBe('')
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('uses only a verified fixed converter under a deny-network sandbox, bounded stdout and private input', async () => {
    const f = fixture(),
      original = Buffer.from(f.job.bytes)
    let directory = '',
      transient: Buffer | undefined
    f.adapters.execute.mockImplementationOnce(async (file, args, options) => {
      expect(file).toBe('/usr/bin/sandbox-exec')
      expect(args[0]).toBe('-p')
      expect(args[1]).toContain('(deny network*)')
      expect(args[1]).toContain('(allow default)')
      expect(args[2]).toBe(f.core.executable)
      expect(args.slice(3, 6)).toEqual(['convert-ruleset', 'ipcidr', 'mrs'])
      expect(args.at(-1)).toBe('/dev/stdout')
      expect(options).toMatchObject({
        timeout: 10000,
        maxBuffer: 512 * 1024,
        encoding: 'buffer',
        killSignal: 'SIGTERM'
      })
      expect(options.env).not.toHaveProperty('CLASH_CONFIG_STRING')
      directory = options.cwd
      expect((await lstat(directory)).mode & 0o7777).toBe(0o700)
      expect((await lstat(args[6])).mode & 0o7777).toBe(0o600)
      expect(await readFile(args[6])).toEqual(original)
      transient = Buffer.from('127.0.0.0/8\n')
      return { stdout: transient, stderr: Buffer.alloc(0) }
    })
    expect(await convertRuleMRS('/trusted/root', f.job, f.adapters)).toEqual({
      entries: ['127.0.0.0/8'],
      sourceRules: 1
    })
    expect(f.adapters.verify).toHaveBeenCalledTimes(2)
    expect(f.job.bytes).toEqual(original)
    expect(transient?.every((value) => value === 0)).toBe(true)
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('refuses unsupported hosts, excessive input and mismatched metadata before execution', async () => {
    const f = fixture()
    await expect(
      convertRuleMRS('/trusted', f.job, { ...f.adapters, platform: 'linux' })
    ).rejects.toThrow('MRS转换未确认')
    await expect(
      convertRuleMRS('/trusted', { ...f.job, bytes: Buffer.alloc(2 * 1024 * 1024 + 1) }, f.adapters)
    ).rejects.toThrow()
    await expect(
      convertRuleMRS('/trusted', { ...f.job, sha256: '0'.repeat(64) }, f.adapters)
    ).rejects.toThrow()
    await expect(
      convertRuleMRS(
        '/trusted',
        { ...f.job, descriptor: { ...f.job.descriptor, kind: 'rule-yaml' } },
        f.adapters
      )
    ).rejects.toThrow()
    expect(f.adapters.execute).not.toHaveBeenCalled()
    expect(f.adapters.verify).not.toHaveBeenCalled()
  })
  it('does not run a different core version or accept an executable changed after conversion', async () => {
    const f = fixture()
    f.adapters.verify.mockResolvedValueOnce({ ...f.core, version: 'alpha-unreviewed' })
    await expect(convertRuleMRS('/trusted', f.job, f.adapters)).rejects.toThrow()
    expect(f.adapters.execute).not.toHaveBeenCalled()
    f.adapters.verify
      .mockResolvedValueOnce({ ...f.core })
      .mockResolvedValueOnce({ ...f.core, sha256: 'b'.repeat(64) })
    await expect(convertRuleMRS('/trusted', f.job, f.adapters)).rejects.toThrow()
    expect(f.adapters.execute).toHaveBeenCalledTimes(1)
  })
  it.each([
    Buffer.alloc(0),
    Buffer.from([0xff]),
    Buffer.from('GEOIP,CN\n'),
    Buffer.alloc(512 * 1024 + 1),
    Buffer.from(Array(20001).fill('127.0.0.0/8').join('\n'))
  ])('refuses truncated, oversized or incompatible converter output (case %#)', async (stdout) => {
    const f = fixture()
    f.adapters.execute.mockResolvedValueOnce({
      stdout: Buffer.from(stdout),
      stderr: Buffer.alloc(0)
    })
    await expect(convertRuleMRS('/trusted', f.job, f.adapters)).rejects.toThrow('MRS转换未确认')
  })
  it('treats timeout or sandbox failure as a failure without an unsandboxed fallback or private diagnostics', async () => {
    const f = fixture()
    f.adapters.execute.mockRejectedValueOnce(new Error('PRIVATE-source-path'))
    await expect(convertRuleMRS('/trusted', f.job, f.adapters)).rejects.toThrow(/^MRS转换未确认/)
    expect(f.adapters.execute).toHaveBeenCalledTimes(1)
    expect(f.adapters.execute.mock.calls[0][0]).toBe('/usr/bin/sandbox-exec')
  })
  it('refuses changed input bytes and cleans only its owned worker directory', async () => {
    const f = fixture()
    let directory = ''
    f.adapters.execute.mockImplementationOnce(async (_file, args, options) => {
      directory = options.cwd
      await writeFile(args[6], 'tampered', { mode: 0o600 })
      return { stdout: Buffer.from('127.0.0.0/8\n'), stderr: Buffer.alloc(0) }
    })
    await expect(convertRuleMRS('/trusted', f.job, f.adapters)).rejects.toThrow('MRS转换未确认')
    await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('preserves a replacement directory when ownership identity changes instead of deleting unknown contents', async () => {
    const f = fixture()
    let directory = '',
      retained = ''
    f.adapters.execute.mockImplementationOnce(async (_file, _args, options) => {
      directory = options.cwd
      retained = directory + '-retained'
      await rename(directory, retained)
      await mkdir(directory, { mode: 0o700 })
      await writeFile(join(directory, 'foreign'), 'keep', { mode: 0o600 })
      return { stdout: Buffer.from('127.0.0.0/8\n'), stderr: Buffer.alloc(0) }
    })
    try {
      await expect(convertRuleMRS('/trusted', f.job, f.adapters)).rejects.toThrow('清理未确认')
      expect(await readFile(join(directory, 'foreign'), 'utf8')).toBe('keep')
    } finally {
      if (directory) await rm(directory, { recursive: true, force: true })
      if (retained) await rm(retained, { recursive: true, force: true })
    }
  })
})
