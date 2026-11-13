import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalProxyState } from '../../../shared/relay/local-proxy'
import { createRuntimeInfoService, readProcessMemory } from './service'

const f = vi.hoisted(() => ({ output: '  2048\n', error: null as Error | null, exec: vi.fn() }))
vi.mock('child_process', async () => {
  const { promisify } = await import('util')
  const execFile = (...args: unknown[]): void => {
    f.exec(...args.slice(0, 3))
    const callback = args[3] as (error: Error | null, stdout: string, stderr: string) => void
    callback(f.error, f.output, '')
  }
  Object.defineProperty(execFile, promisify.custom, {
    value: (...args: unknown[]) =>
      new Promise((resolve, reject) => {
        execFile(...args, (error: Error | null, stdout: string, stderr: string) => {
          if (error) reject(error)
          else resolve({ stdout, stderr })
        })
      })
  })
  return { execFile }
})
beforeEach(() => {
  vi.clearAllMocks()
  f.output = '  2048\n'
  f.error = null
})

const state = (): LocalProxyState => ({
  phase: 'running',
  owned: true,
  pending: false,
  uncertain: false,
  hasRecord: true,
  pid: 12345,
  instanceId: 'fixture',
  configurationRevision: 'a'.repeat(64),
  traffic: 'listening',
  groups: [],
  systemProxyChanged: false,
  liveGuardEnabled: false,
  warnings: []
})

describe('Owned process memory observation', () => {
  it('reads only the held numeric PID with a bounded read-only OS command and converts KiB to bytes', async () => {
    expect(await readProcessMemory(12345)).toBe(2097152)
    expect(f.exec).toHaveBeenCalledExactlyOnceWith('/bin/ps', ['-o', 'rss=', '-p', '12345'], {
      timeout: 1000,
      maxBuffer: 1024,
      encoding: 'utf8'
    })
  })
  it('does not invent a zero when the process disappears or output is invalid', async () => {
    for (const output of ['', '0', '-1', 'memory: 20', '100\n200', '9007199254740991']) {
      f.output = output
      expect(await readProcessMemory(12345)).toBeUndefined()
    }
    f.error = new Error('process exited')
    expect(await readProcessMemory(12345)).toBeUndefined()
    f.exec.mockClear()
    expect(await readProcessMemory(-1)).toBeUndefined()
    expect(await readProcessMemory(NaN)).toBeUndefined()
    expect(f.exec).not.toHaveBeenCalled()
  })
  it('publishes memory only while the same owned instance and configuration remain current', async () => {
    let current = state()
    const memory = vi.fn(async () => 4096)
    const service = createRuntimeInfoService({
      state: () => current,
      connections: async () => ({ download: 1, upload: 2 }),
      memory
    })
    expect((await service.inspect()).memory).toBe(4096)
    for (const patch of [
      { instanceId: 'next' },
      { configurationRevision: 'b'.repeat(64) },
      { pid: 54321 },
      { owned: false },
      { uncertain: true },
      { pending: true }
    ]) {
      current = state()
      memory.mockImplementationOnce(async () => {
        current = { ...current, ...patch }
        return 4096
      })
      expect((await service.inspect()).memory).toBeUndefined()
    }
    memory.mockClear()
    current = { ...state(), phase: 'idle', owned: false }
    expect((await service.inspect()).memory).toBeUndefined()
    expect(memory).not.toHaveBeenCalled()
  })
})
