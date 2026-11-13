import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile
} from 'fs/promises'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { nativeRuntimeExecutable } from './native-runtime'
import { systemProxyNative, previewNative } from './native'
import { resourceHash, RESOURCE_BYTE_LIMIT } from './resources/source'
import type { RelayStateContext } from './context'

const mock = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('child_process', () => ({ execFile: mock.execFile }))
afterEach(() => mock.execFile.mockReset())

async function fixture(
  run: (source: string, context: RelayStateContext, bytes: Buffer) => Promise<void>
): Promise<void> {
  const home = await realpath(await mkdtemp('/private/tmp/relay-native-runtime-')),
    source = join(home, 'RelayNative'),
    bytes = Buffer.from('inert native resource fixture; never executed'),
    context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') }
  try {
    await writeFile(source, bytes, { mode: 0o755 })
    await run(source, context, bytes)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

describe('Private content-addressed native deployment without executing fixture bytes', () => {
  it('publishes complete identical bytes privately and reuses the verified inode', async () => {
    await fixture(async (source, context, bytes) => {
      const path = await nativeRuntimeExecutable(source, context),
        identity = await lstat(path)
      expect(path).toBe(
        join(context.stateRoot, 'NativeRuntime', resourceHash(bytes), 'RelayNative')
      )
      expect(await readFile(path)).toEqual(bytes)
      expect(identity.uid).toBe(process.getuid?.())
      expect(identity.nlink).toBe(1)
      expect(identity.mode & 0o7777).toBe(0o700)
      expect(await nativeRuntimeExecutable(source, context)).toBe(path)
      expect((await lstat(path)).ino).toBe(identity.ino)
      expect(await readdir(join(path, '..'))).toEqual(['RelayNative'])
      expect(mock.execFile).not.toHaveBeenCalled()
    })
  })

  it('coalesces concurrent deployment and retains prior immutable versions after source updates', async () => {
    await fixture(async (source, context) => {
      const paths = await Promise.all(
        Array.from({ length: 24 }, () => nativeRuntimeExecutable(source, context))
      )
      expect(new Set(paths).size).toBe(1)
      expect(await readdir(join(paths[0], '..'))).toEqual(['RelayNative'])
      const previous = await readFile(paths[0])
      await writeFile(source, Buffer.from('new inert resource version'))
      const next = await nativeRuntimeExecutable(source, context)
      expect(next).not.toBe(paths[0])
      expect(await readFile(paths[0])).toEqual(previous)
      expect((await lstat(next)).nlink).toBe(1)
    })
  })

  it('refuses unknown existing bytes and permissions without replacing or repairing them', async () => {
    await fixture(async (source, context) => {
      const path = await nativeRuntimeExecutable(source, context)
      await writeFile(path, 'unknown modified resource')
      await expect(nativeRuntimeExecutable(source, context)).rejects.toThrow('摘要')
      expect(await readFile(path, 'utf8')).toBe('unknown modified resource')
      await chmod(path, 0o755)
      await expect(nativeRuntimeExecutable(source, context)).rejects.toThrow('权限')
      expect((await lstat(path)).mode & 0o7777).toBe(0o755)
    })
  })

  it('refuses linked or writable sources before creating any runtime directory', async () => {
    await fixture(async (source, context) => {
      await chmod(source, 0o775)
      await expect(nativeRuntimeExecutable(source, context)).rejects.toThrow('权限')
      await chmod(source, 0o755)
      await link(source, source + '-hardlink')
      await expect(nativeRuntimeExecutable(source, context)).rejects.toThrow('权限')
      await expect(lstat(context.stateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    })
    await fixture(async (source, context) => {
      const alias = join(context.home, 'alias')
      await symlink(context.home, alias)
      await expect(nativeRuntimeExecutable(join(alias, 'RelayNative'), context)).rejects.toThrow()
      await expect(lstat(context.stateRoot)).rejects.toMatchObject({ code: 'ENOENT' })
      await truncate(source, RESOURCE_BYTE_LIMIT + 1)
      await expect(nativeRuntimeExecutable(source, context)).rejects.toThrow('大小')
    })
  })

  it('refuses cache symlinks and hard links while preserving their unrelated destination', async () => {
    await fixture(async (source, context, bytes) => {
      const directory = join(context.stateRoot, 'NativeRuntime', resourceHash(bytes)),
        outside = join(context.home, 'keep'),
        path = join(directory, 'RelayNative')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await writeFile(outside, bytes, { mode: 0o700 })
      await symlink(outside, path)
      await expect(nativeRuntimeExecutable(source, context)).rejects.toThrow('权限')
      expect((await lstat(path)).isSymbolicLink()).toBe(true)
      expect(await readFile(outside)).toEqual(bytes)
      await rm(path)
      await link(outside, path)
      await expect(nativeRuntimeExecutable(source, context)).rejects.toThrow('权限')
      expect((await lstat(outside)).nlink).toBe(2)
    })
  })

  it('refuses aliases, nonprivate owned directories and alternate state roots without repairing them', async () => {
    await fixture(async (source, context) => {
      await mkdir(context.stateRoot, { recursive: true, mode: 0o700 })
      await chmod(context.stateRoot, 0o755)
      await expect(nativeRuntimeExecutable(source, context)).rejects.toThrow('私有')
      expect((await lstat(context.stateRoot)).mode & 0o7777).toBe(0o755)
      await expect(lstat(join(context.stateRoot, 'NativeRuntime'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
      await expect(
        nativeRuntimeExecutable(source, { ...context, stateRoot: join(context.home, 'other') })
      ).rejects.toThrow('上下文')
      await chmod(context.stateRoot, 0o700)
      const outside = join(context.home, 'other')
      await mkdir(outside, { mode: 0o700 })
      await symlink(outside, join(context.stateRoot, 'NativeRuntime'))
      await expect(nativeRuntimeExecutable(source, context)).rejects.toThrow()
      expect(await readdir(outside)).toEqual([])
    })
  })
})

describe('Proxy bridge deploys before a confirmed mutation, without fallback retries', () => {
  it('keeps inspection on the resource and only apply/restore on the verified private runtime', async () => {
    await fixture(async (source, context) => {
      const result = {
        status: 'inactive',
        revision: 'a'.repeat(64),
        location: 'fixture',
        services: [],
        canApply: false,
        canRestore: false,
        warnings: []
      }
      mock.execFile.mockImplementation((_path, _args, _options, done) => {
        queueMicrotask(() => done(null, JSON.stringify(result)))
        return { stdin: { end: vi.fn(), on: vi.fn() } }
      })
      for (const action of ['inspect', 'prepare', 'prepareRestore'] as const)
        await systemProxyNative(source, context, action)
      expect(mock.execFile.mock.calls.map((call) => call[0])).toEqual([source, source, source])
      await expect(lstat(join(context.stateRoot, 'NativeRuntime'))).rejects.toMatchObject({
        code: 'ENOENT'
      })
      for (const action of ['apply', 'restore'] as const)
        await systemProxyNative(source, context, action, undefined, 'b'.repeat(64))
      const cached = await nativeRuntimeExecutable(source, context)
      expect(mock.execFile.mock.calls.slice(3).map((call) => call[0])).toEqual([cached, cached])
      mock.execFile.mockImplementation((_path, _args, _options, done) => {
        queueMicrotask(() => done(new Error('fixture native failure'), ''))
        return { stdin: { end: vi.fn(), on: vi.fn() } }
      })
      const before = mock.execFile.mock.calls.length
      await expect(systemProxyNative(source, context, 'apply')).rejects.toThrow('事务结果未确认')
      expect(mock.execFile.mock.calls.length).toBe(before + 1)
      expect(mock.execFile.mock.calls.at(-1)?.[0]).toBe(cached)
    })
  })

  it('never invokes a resource after deployment validation fails and leaves unrelated operations unchanged', async () => {
    await fixture(async (source, context) => {
      await chmod(source, 0o775)
      await expect(systemProxyNative(source, context, 'restore')).rejects.toThrow('权限')
      expect(mock.execFile).not.toHaveBeenCalled()
      mock.execFile.mockImplementation((_path, _args, _options, done) => {
        queueMicrotask(() =>
          done(
            null,
            JSON.stringify({
              settingsJSON: '{}',
              noProxy: '',
              plan: '',
              rules: '',
              dns: '',
              listeners: '',
              warnings: []
            })
          )
        )
        return { stdin: { end: vi.fn(), on: vi.fn() } }
      })
      await previewNative(source, {
        httpPort: 7890,
        node: 'fixture',
        existingJSON: '{}',
        internalExceptions: ''
      })
      expect(mock.execFile.mock.calls[0][0]).toBe(source)
    })
  })
})
