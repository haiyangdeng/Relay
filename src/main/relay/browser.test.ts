import { beforeEach, describe, expect, it, vi } from 'vitest'
import { openRelayBrowser } from './browser'

const fixture = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('child_process', () => ({ execFile: fixture.execFile }))
beforeEach(() => {
  fixture.execFile.mockReset()
})
describe('Bundled browser entry only', () => {
  it('uses the fixed helper and login URL without a shell, default-browser call or external launcher', async () => {
    const end = vi.fn()
    fixture.execFile.mockImplementation((_path, _args, _options, done) => {
      queueMicrotask(() => done(null))
      return { stdin: { on: vi.fn(), end } }
    })
    expect((await openRelayBrowser('/fixture/RelayBrowser')).status).toBe('requested')
    expect(fixture.execFile).toHaveBeenCalledWith(
      '/fixture/RelayBrowser',
      ['https://claude.ai/login'],
      { timeout: 10000, maxBuffer: 131072 },
      expect.any(Function)
    )
    expect(end).toHaveBeenCalledWith()
  })
  it('does not retry or expose a helper error containing an OAuth URL', async () => {
    fixture.execFile.mockImplementation((_path, _args, _options, done) => {
      queueMicrotask(() => done(new Error('PRIVATE_OAUTH_TOKEN')))
      return { stdin: { on: vi.fn(), end: vi.fn() } }
    })
    const error = await openRelayBrowser('/fixture/RelayBrowser').catch((value: Error) => value)
    expect(String(error)).toContain('没有调用默认浏览器')
    expect(String(error)).not.toContain('PRIVATE_OAUTH_TOKEN')
    expect(fixture.execFile).toHaveBeenCalledTimes(1)
  })
})
