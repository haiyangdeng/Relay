import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProfileWriteUncertain } from '../profiles/store'
import { createSubscriptionService } from './service'

const source =
  '\ufeff# PRIVATE fixture\nproxies: [{name: Node, type: http, server: 127.0.0.1, port: 12345, password: PRIVATE}]\nproxy-groups: [{name: Group, type: select, proxies: [Node]}]\nrules: [MATCH,Group]\n'
const input = {
  name: 'My subscription',
  url: 'https://sub.invalid/PRIVATE/path?token=PRIVATE',
  proxyPort: 18191
}
const cleaners: (() => void)[] = []
afterEach(() => {
  cleaners.splice(0).forEach((clear) => clear())
  vi.useRealTimers()
})
function fixture() {
  let time = 0
  const adapters = {
    download: vi.fn(async (_url: string, _port: number, _signal: AbortSignal) => source),
    confirmDownload: vi.fn(async () => false),
    confirmSave: vi.fn(async () => false),
    save: vi.fn(async () => ({
      id: '00000000-0000-0000-0000-000000000001',
      name: input.name,
      createdAt: '2026-10-24',
      sha256: 'a'.repeat(64),
      summary: { proxies: 1, groups: 1, rules: 2, proxyProviders: 0, ruleProviders: 0 }
    })),
    now: () => time
  }
  const service = createSubscriptionService(adapters)
  cleaners.push(() => service.clear())
  return {
    service,
    adapters,
    advance: (value: number) => {
      time += value
    }
  }
}
async function downloaded(f: ReturnType<typeof fixture>) {
  f.adapters.confirmDownload.mockResolvedValue(true)
  const plan = f.service.prepare(input)
  const result = await f.service.download({ evidenceId: plan.evidenceId })
  if (!result.profile) throw new Error('fixture missing staged report')
  return { plan, profile: result.profile }
}
describe('Explicit subscription snapshot download and private save', () => {
  it('has no startup IO, redacts path/query and rejects request/header/path injection', async () => {
    const f = fixture()
    expect(f.service.state()).toMatchObject({ phase: 'idle', pending: false })
    const plan = f.service.prepare(input)
    expect(plan.origin).toBe('https://sub.invalid')
    expect(JSON.stringify(plan)).not.toContain('PRIVATE')
    expect(f.adapters.download).not.toHaveBeenCalled()
    for (const value of [
      { ...input, headers: {} },
      { ...input, path: '/PRIVATE' },
      { ...input, url: 'https://u:p@sub.invalid/' },
      { ...input, url: 'https://sub.invalid/#PRIVATE' },
      { ...input, proxyPort: 0 },
      { ...input, name: '\nPRIVATE' }
    ])
      expect(() => f.service.prepare(value)).toThrow()
    await expect(
      f.service.download({ evidenceId: plan.evidenceId, url: input.url })
    ).rejects.toThrow()
    expect(f.adapters.save).not.toHaveBeenCalled()
  })
  it('cancels by default and expires a download proof before any request', async () => {
    const f = fixture(),
      plan = f.service.prepare(input)
    expect((await f.service.download({ evidenceId: plan.evidenceId })).status).toBe('cancelled')
    expect(f.adapters.download).not.toHaveBeenCalled()
    const expired = f.service.prepare(input)
    f.advance(60001)
    await expect(f.service.download({ evidenceId: expired.evidenceId })).rejects.toThrow('失效')
    expect(f.adapters.download).not.toHaveBeenCalled()
  })
  it('saves the held exact bytes once, keeps cancelled save staged and refuses renderer mutation', async () => {
    const f = fixture(),
      { profile } = await downloaded(f)
    expect(profile.inspection).toMatchObject({
      structure: 'passed',
      active: false,
      coreCompatibility: 'notVerified'
    })
    expect(JSON.stringify(profile)).not.toContain('PRIVATE')
    profile.name = 'Injected'
    expect((await f.service.save({ evidenceId: profile.evidenceId })).status).toBe('cancelled')
    expect(f.service.state().stagedId).toBe(profile.evidenceId)
    f.adapters.confirmSave.mockResolvedValue(true)
    expect((await f.service.save({ evidenceId: profile.evidenceId })).status).toBe('saved')
    expect(f.adapters.save).toHaveBeenCalledWith(input.name, source)
    expect(f.adapters.download).toHaveBeenCalledOnce()
    await expect(f.service.save({ evidenceId: profile.evidenceId })).rejects.toThrow('失效')
  })
  it('rejects HTML, missing nodes and malformed input without saving; preserves providers as unexecuted source', async () => {
    const f = fixture()
    f.adapters.confirmDownload.mockResolvedValue(true)
    for (const text of ['<html>PRIVATE</html>', 'error: PRIVATE', 'proxies: [']) {
      f.adapters.download.mockResolvedValueOnce(text)
      const plan = f.service.prepare(input),
        result = await f.service.download({ evidenceId: plan.evidenceId })
      expect(result.status).toBe('rejected')
      expect(JSON.stringify(result)).not.toContain('PRIVATE')
      expect(f.service.state().stagedId).toBeUndefined()
    }
    f.adapters.download.mockResolvedValueOnce(
      'proxy-providers: {P: {type: http, url: "https://must-not-fetch.invalid/PRIVATE"}}'
    )
    const plan = f.service.prepare(input),
      result = await f.service.download({ evidenceId: plan.evidenceId })
    expect(result.profile?.inspection.summary?.proxyProviders).toBe(1)
    expect(f.adapters.download).toHaveBeenCalledTimes(4)
    expect(f.adapters.save).not.toHaveBeenCalled()
  })
  it('cancels only the current request, propagates abort and waits for its completion before closing', async () => {
    const f = fixture()
    f.adapters.confirmDownload.mockResolvedValue(true)
    let signal!: AbortSignal, reject!: (error: Error) => void
    f.adapters.download.mockImplementationOnce(async (_url, _port, value) => {
      signal = value
      return new Promise<string>((_resolve, fail) => {
        reject = fail
      })
    })
    const plan = f.service.prepare(input),
      pending = f.service.download({ evidenceId: plan.evidenceId })
    await vi.waitFor(() => expect(f.adapters.download).toHaveBeenCalled())
    expect(() => f.service.prepare(input)).toThrow('尚未结束')
    expect(f.service.cancel({ evidenceId: '00000000-0000-0000-0000-000000000099' }).status).toBe(
      'stale'
    )
    expect(signal.aborted).toBe(false)
    const close = f.service.requestClose()
    expect(f.service.requestClose()).toBe(close)
    expect(signal.aborted).toBe(true)
    expect(f.service.isBusy()).toBe(true)
    reject(new Error('PRIVATE'))
    expect((await pending).status).toBe('cancelled')
    await close
    expect(f.service.state()).toMatchObject({ phase: 'idle', pending: false })
    expect(f.adapters.save).not.toHaveBeenCalled()
  })
  it('does not request or save after close/cancel during system confirmation', async () => {
    const f = fixture()
    let confirm!: (value: boolean) => void
    f.adapters.confirmDownload.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirm = resolve
        })
    )
    const plan = f.service.prepare(input),
      pending = f.service.download({ evidenceId: plan.evidenceId })
    const close = f.service.requestClose()
    confirm(true)
    expect((await pending).status).toBe('cancelled')
    await close
    expect(f.adapters.download).not.toHaveBeenCalled()
    const { profile } = await downloaded(f)
    f.adapters.confirmSave.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          confirm = resolve
        })
    )
    const saving = f.service.save({ evidenceId: profile.evidenceId })
    expect(f.service.cancel({ evidenceId: profile.evidenceId }).status).toBe('requested')
    confirm(true)
    expect((await saving).status).toBe('cancelled')
    expect(f.adapters.save).not.toHaveBeenCalled()
  })
  it('waits for an already started private write and reports uncertainty without retrying', async () => {
    const f = fixture(),
      { profile } = await downloaded(f)
    f.adapters.confirmSave.mockResolvedValue(true)
    let finish!: (value: Awaited<ReturnType<typeof f.adapters.save>>) => void
    f.adapters.save.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const saved = f.service.save({ evidenceId: profile.evidenceId })
    await vi.waitFor(() => expect(f.adapters.save).toHaveBeenCalled())
    expect(f.service.cancel({ evidenceId: profile.evidenceId }).status).toBe('busy')
    const close = f.service.requestClose()
    expect(f.service.state().phase).toBe('saving')
    finish({
      id: '00000000-0000-0000-0000-000000000001',
      name: input.name,
      createdAt: '2026-10-24',
      sha256: 'a'.repeat(64),
      summary: { proxies: 1, groups: 1, rules: 2, proxyProviders: 0, ruleProviders: 0 }
    })
    expect((await saved).status).toBe('saved')
    await close
    const next = await downloaded(f)
    f.adapters.save.mockRejectedValueOnce(new ProfileWriteUncertain())
    expect((await f.service.save({ evidenceId: next.profile.evidenceId })).status).toBe('uncertain')
    expect(f.adapters.save).toHaveBeenCalledTimes(2)
  })
  it('erases expiring staged data and refuses late confirmation without network or writes', async () => {
    vi.useFakeTimers()
    const f = fixture(),
      { profile } = await downloaded(f)
    await vi.advanceTimersByTimeAsync(60001)
    expect(f.service.state().stagedId).toBeUndefined()
    await expect(f.service.save({ evidenceId: profile.evidenceId })).rejects.toThrow('失效')
    f.adapters.confirmDownload.mockImplementationOnce(async () => {
      f.advance(60001)
      return true
    })
    const plan = f.service.prepare(input)
    expect((await f.service.download({ evidenceId: plan.evidenceId })).status).toBe('failed')
    expect(f.adapters.download).toHaveBeenCalledOnce()
  })
})
