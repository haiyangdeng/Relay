import { ok } from 'assert/strict'
import { chmod, lstat, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RelayStateContext } from '../context'
import { resourceHash } from '../resources/source'
import { CORE_OWNER_CONTRACT, type OwnerReply, type OwnerSnapshot } from './protocol'
import { createCoreOwnerRuntime } from './runtime'

const channel = vi.hoisted(() => ({
  enabled: true,
  live: true,
  reply: {} as OwnerReply,
  request: vi.fn()
}))
const resourceSHA256 = 'a'.repeat(64),
  coreSHA256 = 'b'.repeat(64),
  ownerExecutable = '/fixture/RelayCoreOwner',
  coreExecutable = '/fixture/mihomo'
vi.mock('./release', () => ({
  coreOwnerReleaseEnabled: () => channel.enabled,
  coreOwnerResources: async () => ({
    executable: ownerExecutable,
    sha256: resourceSHA256,
    core: { executable: coreExecutable, sha256: coreSHA256 }
  })
}))
vi.mock('./transport', () => ({
  CoreOwnerTransport: class {
    ready = Promise.resolve(channel.reply)
    live = () => channel.live
    request = channel.request
  }
}))

describe.skipIf(typeof process.getuid !== 'function')('Retained core work directory', () => {
  let context: RelayStateContext,
    directory: string,
    owner: ReturnType<typeof createCoreOwnerRuntime>
  const capture = (): NonNullable<ReturnType<typeof owner.captureWorkDirectory>> => {
    const open = owner.captureWorkDirectory()
    ok(open)
    return open
  }
  const publish = async (phase: OwnerSnapshot['phase'] = 'detached'): Promise<Buffer> => {
    const uid = process.getuid?.()
    ok(uid !== undefined)
    const info = await lstat(directory, { bigint: true }),
      identity = {
        pid: 4000,
        uid,
        bornSeconds: '100',
        bornMicroseconds: '20',
        executable: ownerExecutable,
        resourceSHA256,
        fileIdentity: '1:2'
      },
      sessionId = '11111111-1111-4111-8111-111111111111',
      snapshot = {
        version: 1 as const,
        contract: CORE_OWNER_CONTRACT,
        sessionId,
        phase,
        owner: identity,
        core: { ...identity, pid: 4001, executable: coreExecutable, resourceSHA256: coreSHA256 },
        coreLease: {
          token: sessionId,
          directoryIdentity: '1:3',
          ownerSHA256: resourceSHA256
        },
        runtime: {
          directory,
          socket: join(directory, 'api.sock'),
          httpPort: 21080,
          profileId: '22222222-2222-4222-8222-222222222222',
          sourceSHA256: resourceSHA256,
          configurationSHA256: coreSHA256,
          mode: 'rule' as const,
          coreResourceSHA256: coreSHA256
        },
        attachedMain: { ...identity, pid: process.pid, executable: '/fixture/Relay' },
        controlLost: phase === 'detached',
        detached: phase === 'detached'
      },
      bytes = Buffer.from(
        JSON.stringify({
          ...snapshot,
          createdAt: '2026-11-08T00:00:00Z',
          workspaceIdentity: `${BigInt.asIntN(32, info.dev)}:${info.ino}`,
          leaseRaw: '{}'
        })
      )
    await writeFile(join(directory, 'owner.json'), bytes, { mode: 0o600 })
    channel.reply = {
      version: 1,
      contract: CORE_OWNER_CONTRACT,
      requestId: sessionId,
      status: 'ok',
      connectionId: sessionId,
      clientNonce: sessionId,
      serverNonce: sessionId,
      sequence: 0,
      snapshot: { ...snapshot, revision: resourceHash(bytes), released: false, warnings: [] }
    }
    return bytes
  }
  beforeEach(async () => {
    const home = await mkdtemp(join(await realpath(tmpdir()), 'relay-owner-directory-'))
    context = { home, stateRoot: join(home, 'Library/Application Support/Relay-Preview') }
    directory = join(context.stateRoot, 'CoreOwner/.session')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    channel.enabled = true
    channel.live = true
    channel.request.mockReset().mockImplementation(async () => channel.reply)
    owner = createCoreOwnerRuntime(context, () => '/fixture/RelayNative')
  })
  afterEach(async () => {
    await rm(context.home, { recursive: true, force: true })
  })

  it('uses only a fresh authenticated inspect and the exact private directory', async () => {
    await publish()
    expect(owner.captureWorkDirectory()).toBeUndefined()
    await owner.connect()
    channel.request.mockClear()
    const open = vi.fn()
    await capture()(open)
    expect(channel.request.mock.calls).toEqual([[{ action: 'inspect' }]])
    expect(open.mock.calls).toEqual([[directory]])
    channel.enabled = false
    expect(owner.captureWorkDirectory()).toBeUndefined()
  })

  it('requires a primary connection for a ready owner', async () => {
    await publish('ready')
    await owner.connect()
    expect(owner.captureWorkDirectory()).toBeUndefined()
    await owner.reattach(() => {})
    const open = vi.fn()
    await capture()(open)
    expect(open.mock.calls).toEqual([[directory]])
  })

  it('refuses byte-identical replacement directories and symlinks', async () => {
    const bytes = await publish()
    await owner.connect()
    const open = vi.fn(),
      captured = capture(),
      original = directory + '-prior'
    await rename(directory, original)
    await mkdir(directory, { mode: 0o700 })
    await writeFile(join(directory, 'owner.json'), bytes, { mode: 0o600 })
    await expect(captured(open)).rejects.toThrow()
    await rename(directory, directory + '-replacement')
    await symlink(original, directory)
    await expect(captured(open)).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
  })

  it('refuses changed journal bytes and non-private file or directory modes', async () => {
    const bytes = await publish(),
      journal = join(directory, 'owner.json')
    await owner.connect()
    const open = vi.fn(),
      captured = capture()
    await writeFile(journal, Buffer.concat([bytes, Buffer.from('\n')]))
    await expect(captured(open)).rejects.toThrow()
    await writeFile(journal, bytes)
    await chmod(journal, 0o644)
    await expect(captured(open)).rejects.toThrow()
    await chmod(journal, 0o600)
    await chmod(directory, 0o755)
    await expect(captured(open)).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
  })

  it('refuses a lost channel or an owner whose phase or revision changed during inspect', async () => {
    await publish()
    await owner.connect()
    const open = vi.fn(),
      captured = capture()
    channel.live = false
    channel.request.mockClear()
    await expect(captured(open)).rejects.toThrow()
    expect(channel.request).not.toHaveBeenCalled()
    channel.live = true
    await publish('closed')
    await expect(captured(open)).rejects.toThrow()
    expect(open).not.toHaveBeenCalled()
  })
})
