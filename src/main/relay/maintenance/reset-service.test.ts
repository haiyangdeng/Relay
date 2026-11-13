import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { OwnedResetReport } from '../../../shared/relay/owned-reset'
import { OwnedResetUnavailable, type OwnedResetBridge } from './reset-native'
import { createOwnedResetService } from './reset-service'
import { ownedResetStartup } from './reset-startup'

const idle: OwnedResetReport = {
  phase: 'idle',
  mode: 'normal',
  lockHeld: true,
  canReset: true,
  canRestore: false,
  evidenceID: 'ad4aa5f1-a973-48e2-89f6-2f75794114bd',
  restartRequired: false
}

function fixture() {
  const bridge = {
    acquire: vi.fn<OwnedResetBridge['acquire']>().mockResolvedValue(idle),
    inspect: vi.fn<OwnedResetBridge['inspect']>().mockResolvedValue(idle),
    reset: vi.fn<OwnedResetBridge['reset']>().mockResolvedValue(idle),
    restore: vi.fn<OwnedResetBridge['restore']>().mockResolvedValue(idle),
    cancel: vi.fn<OwnedResetBridge['cancel']>().mockResolvedValue(idle),
    invalidate: vi.fn(),
    isBusy: () => false
  } satisfies OwnedResetBridge
  return {
    bridge,
    service: createOwnedResetService({
      bridge,
      assertIdle: vi.fn(),
      inspectOwningIdle: vi.fn(async () => {})
    })
  }
}

describe('owned reset offline startup and failure barriers', () => {
  it.runIf(process.getuid !== undefined)(
    'isolates startup on a malformed marker without changing data or the marker',
    async () => {
      const home = await realpath(await mkdtemp(join(tmpdir(), 'relay-reset-startup-')))
      try {
        const paths = ownedResetStartup(home)
        expect(paths.mode).toBe('normal')
        await mkdir(paths.targetRoot, { recursive: true, mode: 0o700 })
        await mkdir(paths.controlRoot, { mode: 0o700 })
        const data = join(paths.targetRoot, 'preserved.txt')
        const marker = join(paths.controlRoot, 'owned-reset.json')
        await writeFile(data, 'private fixture data')
        await writeFile(marker, 'intentionally malformed fixture marker')
        expect(ownedResetStartup(home)).toEqual({
          ...paths,
          mode: 'maintenance',
          profileRoot: join(paths.controlRoot, 'Bootstrap')
        })
        expect(await readFile(data, 'utf8')).toBe('private fixture data')
        expect(await readFile(marker, 'utf8')).toBe('intentionally malformed fixture marker')
      } finally {
        await rm(home, { recursive: true, force: true })
      }
    }
  )

  it('discards a stale intent before sending the native reset request', async () => {
    const { bridge, service } = fixture()
    let reply: (value: OwnedResetReport) => void = () => {}
    bridge.inspect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          reply = resolve
        })
    )
    const pending = service.action('reset', () => {})
    await vi.waitFor(() => expect(bridge.inspect).toHaveBeenCalledOnce())
    service.invalidate()
    reply(idle)
    await expect(pending).rejects.toThrow('授权失效')
    expect(bridge.reset).not.toHaveBeenCalled()
    expect(service.isBlocking()).toBe(true)
    expect(await service.state()).toEqual(idle)
    expect(service.isBlocking()).toBe(false)
  })

  it('holds uncertain reset after an unavailable read and clears on a confirmed held state', async () => {
    const { bridge, service } = fixture()
    bridge.reset.mockResolvedValueOnce({ ...idle, phase: 'uncertain', canReset: false })
    expect((await service.action('reset', () => {})).phase).toBe('uncertain')
    bridge.inspect.mockRejectedValueOnce(new OwnedResetUnavailable('fixture unavailable'))
    expect((await service.state()).phase).toBe('unavailable')
    expect(service.isBlocking()).toBe(true)
    expect(await service.state()).toEqual(idle)
    expect(service.isBlocking()).toBe(false)
  })
})
