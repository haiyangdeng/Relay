import AdmZip from 'adm-zip'
import { describe, expect, it, vi } from 'vitest'
import type { LocalProxyState } from '../../../shared/relay/local-proxy'
import { createOnlineThemeService } from './theme-service'

function fixture() {
  const local: LocalProxyState = {
    phase: 'running',
    owned: true,
    pending: false,
    uncertain: false,
    hasRecord: true,
    instanceId: '00000000-0000-4000-8000-000000000038',
    configurationRevision: 'configuration',
    pid: 42,
    httpPort: 18191,
    traffic: 'listening',
    groups: [],
    systemProxyChanged: false,
    liveGuardEnabled: false,
    warnings: []
  }
  const zip = new AdmZip()
  zip.addFile('Ocean.css', Buffer.from('/* Ocean */\nbody{color:navy}'))
  let now = 1000
  const adapters = {
    local: () => structuredClone(local),
    assertAvailable: vi.fn(),
    confirm: vi.fn(async () => true),
    download: vi.fn(async (_port: number, _signal: AbortSignal) => zip.toBuffer()),
    invalidated: vi.fn(),
    now: () => now
  }
  const service = createOnlineThemeService(adapters)
  return {
    service,
    adapters,
    local,
    advance: () => {
      now += 300001
    }
  }
}
describe('Owned online themes remain draft-only and cancellable', () => {
  it('requires confirmation, binds own instance, returns no CSS and generates IDs only for an explicit draft', async () => {
    const f = fixture(),
      result = await f.service.acquire()
    expect(result.status).toBe('ready')
    if (result.status !== 'ready') throw new Error('Missing receipt')
    expect(result.candidates[0]).not.toHaveProperty('css')
    expect(f.adapters.download).toHaveBeenCalledWith(18191, expect.any(AbortSignal))
    const themes = f.service.draft({
      acquisitionId: result.acquisitionId,
      path: 'Ocean.css',
      themes: []
    })
    expect(themes).toEqual([
      { id: expect.any(String), name: 'Ocean', css: '/* Ocean */\nbody{color:navy}' }
    ])
    expect(() =>
      f.service.draft({ acquisitionId: result.acquisitionId, path: 'Ocean.css', themes })
    ).toThrow('同名')
  })
  it('cancelled confirmation does not fetch or create a ready token', async () => {
    const f = fixture()
    f.adapters.confirm.mockResolvedValueOnce(false)
    expect(await f.service.acquire()).toEqual({ status: 'cancelled' })
    expect(f.adapters.download).not.toHaveBeenCalled()
    expect(() => f.service.draft({ acquisitionId: 'fake', path: 'Ocean.css', themes: [] })).toThrow(
      '失效'
    )
  })
  it.each(['instanceId', 'configurationRevision', 'httpPort', 'pid'] as const)(
    'rejects changed %s after confirmation',
    async (key) => {
      const f = fixture()
      f.adapters.confirm.mockImplementationOnce(async () => {
        if (key === 'httpPort' || key === 'pid') f.local[key] = 18192
        else f.local[key] = 'other'
        return true
      })
      await expect(f.service.acquire()).rejects.toThrow('变化')
      expect(f.adapters.download).not.toHaveBeenCalled()
    }
  )
  it('discards a late response after cancellation and keeps concurrent reads single-flight', async () => {
    const f = fixture()
    let finish: (value: Buffer) => void = () => {
      throw new Error('barrier not started')
    }
    f.adapters.download.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const pending = f.service.acquire()
    await vi.waitFor(() => expect(f.adapters.download).toHaveBeenCalledOnce())
    await expect(f.service.acquire()).rejects.toThrow('尚未结束')
    f.service.cancel()
    finish(Buffer.from('not a ZIP'))
    expect(await pending).toEqual({ status: 'cancelled' })
    expect(f.adapters.invalidated).toHaveBeenCalledOnce()
  })
  it('permanently retires a candidate once an owner mismatch has been observed', async () => {
    const f = fixture(),
      result = await f.service.acquire()
    if (result.status !== 'ready') throw new Error('Missing receipt')
    const request = { acquisitionId: result.acquisitionId, path: 'Ocean.css', themes: [] }
    f.local.configurationRevision = 'other'
    expect(() => f.service.draft(request)).toThrow('变化')
    f.local.configurationRevision = 'configuration'
    expect(() => f.service.draft(request)).toThrow('失效')
  })
  it.each(['wall-back', 'wall-expire', 'mono-back', 'mono-expire'] as const)(
    'permanently expires on %s',
    async (kind) => {
      const f = fixture()
      let wall = 1000,
        mono = 1000
      const service = createOnlineThemeService({
        ...f.adapters,
        now: () => wall,
        monotonic: () => mono
      })
      const result = await service.acquire()
      if (result.status !== 'ready') throw new Error('Missing receipt')
      const request = { acquisitionId: result.acquisitionId, path: 'Ocean.css', themes: [] }
      if (kind === 'wall-back') wall--
      if (kind === 'wall-expire') wall += 300000
      if (kind === 'mono-back') mono--
      if (kind === 'mono-expire') mono += 300000
      expect(() => service.draft(request)).toThrow('失效')
      wall = 1000
      mono = 1000
      expect(() => service.draft(request)).toThrow('失效')
    }
  )
  it('rejects expired, source-changed, cancelled, fabricated or oversized drafts without mutating the supplied library', async () => {
    const f = fixture(),
      result = await f.service.acquire()
    if (result.status !== 'ready') throw new Error('Missing receipt')
    const request = { acquisitionId: result.acquisitionId, path: 'Ocean.css', themes: [] }
    expect(() => f.service.draft({ ...request, path: '../escape' })).toThrow('不存在')
    expect(() => f.service.draft({ ...request, url: 'https://evil' })).toThrow('消息')
    const themes = Array.from({ length: 16 }, (_, index) => ({
      id: '00000000-0000-4000-8000-' + index.toString().padStart(12, '0'),
      name: 'Theme' + index,
      css: ''
    }))
    const bytes = JSON.stringify(themes)
    expect(() => f.service.draft({ ...request, themes })).toThrow('16')
    expect(JSON.stringify(themes)).toBe(bytes)
    f.local.configurationRevision = 'changed'
    expect(() => f.service.draft(request)).toThrow('变化')
    f.local.configurationRevision = 'configuration'
    f.advance()
    expect(() => f.service.draft(request)).toThrow('失效')
    f.service.cancel()
    expect(() => f.service.draft(request)).toThrow('失效')
  })
})
