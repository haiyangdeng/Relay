import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MacAppUpdatePlatform } from './macos'
import { publicAppRelease, type TrustedAppRelease } from './release'
import { AppUpdateCandidateStore } from './store'

const execFile = vi.hoisted(() =>
  vi.fn<
    (
      file: string,
      args: string[],
      options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void
    ) => void
  >()
)
vi.mock('node:child_process', () => ({ execFile }))

async function fixture(
  run: (
    platform: MacAppUpdatePlatform,
    stored: Parameters<MacAppUpdatePlatform['verifyPackage']>[0]
  ) => Promise<void>
) {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'relay-installer-fixture-'))
  try {
    const path = join(home, 'update.pkg')
    const bytes = Buffer.from('xar!pinned update fixture')
    await writeFile(path, bytes, { mode: 0o600 })
    const release: TrustedAppRelease = {
      version: '2.0.1',
      architecture: 'arm64',
      bytes: bytes.length,
      sha512: createHash('sha512').update(bytes).digest('base64'),
      releasedAt: '2026-11-08T00:00:00.000Z',
      url: 'https://fixture.invalid/update.pkg',
      metadataSHA256: 'a'.repeat(64),
      trustRevision: 'b'.repeat(64)
    }
    await run(
      new MacAppUpdatePlatform(
        new AppUpdateCandidateStore({
          home,
          stateRoot: join(home, 'Library/Application Support/Relay-Preview')
        })
      ),
      {
        path,
        release,
        candidate: {
          ...publicAppRelease(release),
          id: randomUUID(),
          sha256: createHash('sha256').update(bytes).digest('hex'),
          stagedAt: Date.now()
        }
      }
    )
  } finally {
    await rm(home, { recursive: true })
  }
}

beforeEach(() => {
  execFile.mockReset().mockImplementation((_file, _args, _options, done) => done(null, '', ''))
})

describe('Installer handoff with an injected command runner', () => {
  it('refuses the approved path if its same-size bytes change during Installer signature readback', () =>
    fixture(async (platform, stored) => {
      execFile.mockImplementationOnce((_file, _args, _options, done) => {
        void writeFile(stored.path, Buffer.alloc(stored.release.bytes, 1)).then(
          () => done(null, '', ''),
          (error: Error) => done(error, '', '')
        )
      })
      const assertLeaseCurrent = vi.fn(async () => {})
      await expect(platform.openInstaller(stored, () => {}, assertLeaseCurrent)).rejects.toThrow(
        '安装包已变化'
      )
      expect(assertLeaseCurrent).toHaveBeenCalledOnce()
      expect(execFile.mock.calls.map(([file]) => file)).toEqual(['/usr/bin/codesign'])
    }))

  it('refuses handoff if the lease was lost during Installer signature readback', () =>
    fixture(async (platform, stored) => {
      await expect(
        platform.openInstaller(
          stored,
          () => {},
          async () => {
            throw new Error('fixture lease lost')
          }
        )
      ).rejects.toThrow('fixture lease lost')
      expect(execFile.mock.calls.map(([file]) => file)).toEqual(['/usr/bin/codesign'])
    }))

  it('refuses handoff when Installer appears during package verification', () =>
    fixture(async (platform, stored) => {
      execFile.mockImplementation((file, _args, _options, done) => {
        done(
          null,
          file === '/bin/ps'
            ? '/System/Library/CoreServices/Installer.app/Contents/MacOS/Installer\n'
            : '',
          ''
        )
      })
      await expect(
        platform.openInstaller(
          stored,
          () => {},
          async () => {}
        )
      ).rejects.toThrow('请先完成或关闭现有系统Installer。')
      expect(execFile.mock.calls.map(([file]) => file)).toEqual(['/usr/bin/codesign', '/bin/ps'])
    }))

  it('refuses a same-byte path replacement during the final Installer process check', () =>
    fixture(async (platform, stored) => {
      execFile.mockImplementation((file, _args, _options, done) => {
        if (file !== '/bin/ps') {
          done(null, '', '')
          return
        }
        const replacement = stored.path + '.replacement'
        void readFile(stored.path)
          .then((bytes) => writeFile(replacement, bytes, { mode: 0o600 }))
          .then(() => rename(replacement, stored.path))
          .then(
            () => done(null, '', ''),
            (error: Error) => done(error, '', '')
          )
      })
      await expect(
        platform.openInstaller(
          stored,
          () => {},
          async () => {}
        )
      ).rejects.toThrow('应用更新文件摘要期间发生变化。')
      expect(execFile.mock.calls.map(([file]) => file)).toEqual(['/usr/bin/codesign', '/bin/ps'])
    }))

  it('hands off exactly the approved owned path after both checks succeed', () =>
    fixture(async (platform, stored) => {
      await platform.openInstaller(
        stored,
        () => {},
        async () => {}
      )
      expect(execFile.mock.calls.map(([file, args]) => [file, args])).toEqual([
        [
          '/usr/bin/codesign',
          [
            '--verify',
            '--strict',
            '-R=anchor apple and identifier "com.apple.installer"',
            '/System/Library/CoreServices/Installer.app'
          ]
        ],
        ['/bin/ps', ['-ax', '-o', 'comm=']],
        ['/usr/bin/open', ['-a', '/System/Library/CoreServices/Installer.app', '--', stored.path]]
      ])
    }))
})
